const { collectionPages, PAGE_BYTES } = require('./ColdMessagePages');
const path = require('path');
const { randomUUID } = require('crypto');
const { Worker } = require('worker_threads');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const DataCache = invoke('GameServer/DataCache');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Protocol = require('./ColdSimulationProtocol');
const ColdStateDelta = require('./ColdStateDelta');
const { ColdCommitQueue, EARLY_COMMIT_ROW_BUDGET_MS } = require('./ColdCommitQueue');
const { ColdSnapshotQueue } = require('./ColdSnapshotQueue');
const ColdNpcPlanningCatalog = require('./ColdNpcPlanningCatalog');
const TownNpcCatalog = require('../Economy/TownNpcCatalog');

const HUNTING_TRAVEL_MS = 25000;
const OWNERSHIP_REBASE_REASONS = new Set([
    'stale_revision',
    'cas_failed',
    'owner_changed',
    'lease_changed',
    'lease_expired',
    'lease_active'
]);

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function yieldToLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}

function directDropTargetNpcId(plan = {}) {
    if (!plan || plan.status !== 'active') return 0;
    return Number(plan.next?.npcId || plan.targetNpcId || 0);
}

function admitSoloRouteTravelState(nextState, baseState, profiles, occupancy, timestamp = Date.now()) {
    const travel = nextState?.stats?.travel;
    if (nextState?.activity !== 'traveling'
        || baseState?.activity === 'traveling'
        || travel?.reason === 'party_spot_replan'
        || !travel?.spotId) {
        return { state: nextState, admitted: true, checked: false };
    }
    const spot = (profiles || []).find((profile) => String(profile.id) === String(travel.spotId));
    if (!spot) return { state: nextState, admitted: true, checked: false };
    // Leaving party-only content is a safety transition, not an optional
    // farming reservation. A full destination may be exceeded by one bot so
    // an under-equipped solo character never remains trapped in combat.
    const safetyEvacuation = travel.reason === 'unsafe_ground_evacuation';
    const normalCapacity = SpotProfiles.hasCapacityForStates(spot, [nextState], occupancy);
    if (SpotProfiles.reserveCapacity(occupancy, spot, [nextState], {
        maxOverflowUnits: safetyEvacuation ? 1 : 0
    })) {
        return {
            state: nextState,
            admitted: true,
            checked: true,
            ...(safetyEvacuation && !normalCapacity ? { capacityBypassed: true } : {})
        };
    }

    const { travel: _travel, ...stats } = nextState.stats || {};
    return {
        state: {
            ...nextState,
            activity: baseState?.activity || 'hunting',
            spotId: baseState?.spotId || nextState.spotId,
            loc: baseState?.loc ? { ...baseState.loc } : nextState.loc,
            timing: {
                ...(nextState.timing || {}),
                activityStartedAt: baseState?.timing?.activityStartedAt || timestamp,
                nextResolveAt: timestamp + 1000
            },
            stats
        },
        admitted: false,
        checked: true
    };
}

function npcPlanningCatalogRows() {
    return ColdNpcPlanningCatalog.buildRows({
        items: DataCache.items || [],
        townNpcSellers: TownNpcCatalog.sellersByTown(),
        fetchForNpc: (npcSelfId) => NpcShopBuyLists.fetchForNpc(npcSelfId)
    });
}

function compactPartyMemberContext(state = {}) {
    const partyId = state.party?.partyId || state.partyId || null;
    return {
        characterId: Number(state.characterId || 0),
        phase: state.phase || 'cold',
        activity: state.activity || 'hunting',
        partyId,
        ...(partyId ? {
            party: {
                partyId,
                leaderId: Number(state.party?.leaderId || 0)
            }
        } : {}),
        simulation: {
            ownerId: state.simulation?.ownerId || 'legacy_main',
            revision: Math.max(0, Number(state.simulation?.revision || 0))
        },
        compact: true
    };
}

class ColdSimulationCoordinator {
    constructor(options = {}) {
        this.WorkerClass = options.WorkerClass || Worker;
        this.workerPath = options.workerPath || path.join(__dirname, 'ColdSimulationWorker.js');
        this.worker = null;
        this.workerEpoch = null;
        this.population = null;
        this.started = false;
        this.stopping = false;
        this.ready = false;
        this.snapshotsLoaded = false;
        this.lastHeartbeatAt = 0;
        this.lastWorkerSnapshot = {};
        this.partyReviews = { committed: 0, departed: 0, dissolved: 0, reasons: {}, recent: [] };
        this.workerMaxInFlight = null;
        this.restartCount = 0;
        this.restartTimer = null;
        this.watchdogTimer = null;
        this.reconcileTimer = null;
        this.snapshotContinuationTimer = null;
        this.recoveryTimer = null;
        this.renewalTimer = null;
        this.historyCleanupTimer = null;
        this.historyCleanupInFlight = null;
        this.seen = new Set();
        this.seenOrder = [];
        this.waiters = new Map();
        this.commandTail = Promise.resolve();
        this.competitionActions = new (require('./ColdCompetitionActions').ColdCompetitionActions)({
            life: LifeState, owner: ColdSimulationOwner,
            memory: invoke('GameServer/Social/InteractionMemoryRuntime'),
            participantAllowed: id => !this.fencedBots.has(Number(id)),
            formParty: (members, event, options) => this.population?.formCompetitionParty?.(members, event, options),
            onState: id => {
                const state = LifeState.cachedState(id);
                if (state) this.markDirty(state, { critical: true, reason: 'competition_action' });
            },
            canRun: () => !this.stopping && this.ready && this.snapshotsLoaded && !this.pauseReasons.size
                && !this.queue?.flushing && !invoke('Database').stats().pending
                && Number(Metrics.currentEventLoopLag()) < 40
        });
        this.commandInflight = new Map();
        this.fencedBots = new Set();
        this.pauseReasons = new Set();
        this.snapshotQueue = new ColdSnapshotQueue({
            pageSize: Config.coldWorkerSnapshotPageSize || 48,
            playerPageSize: Config.coldWorkerSnapshotPlayerPageSize || 32,
            maxDeferralMs: Config.coldWorkerSnapshotMaxDeferralMs || 5000,
            lagThrottleMs: Config.coldWorkerSnapshotLagThrottleMs || Config.schedulerLagThrottleMs || 40,
            lagAbortMs: Config.coldWorkerSnapshotLagAbortMs || Config.schedulerLagAbortMs || 120
        });
        this.snapshotInFlight = null;
        this.snapshotInFlightInitial = false;
        this.snapshotRefreshPending = false;
        this.criticalSnapshotInFlight = null;
        this.snapshotLast = {
            mode: 'none',
            rows: 0,
            pages: 0,
            durationMs: 0,
            deferred: false,
            error: null
        };
        this.counters = {
            workersStarted: 0,
            workerExits: 0,
            workerErrors: 0,
            workerRestarts: 0,
            invalidMessages: 0,
            invalidReasons: {},
            duplicateMessages: 0,
            messagesIn: 0,
            messagesOut: 0,
            bytesIn: 0,
            bytesOut: 0,
            fences: 0,
            fenceTimeouts: 0,
            commands: 0,
            commandErrors: 0,
            snapshotsSent: 0,
            snapshotPages: 0,
            snapshotFullRuns: 0,
            snapshotDirtyRuns: 0,
            snapshotCriticalRuns: 0,
            snapshotYields: 0,
            snapshotDeferrals: 0,
            routeCapacityRejects: 0
        };
        this.queue = new ColdCommitQueue({
            targetMs: Config.coldWorkerOrdinaryFlushMs || 2000,
            hardMs: Config.coldWorkerOrdinaryHardMaxMs || 5000,
            p1TargetMs: Config.coldWorkerCriticalFlushMs || 100,
            maxRows: Config.coldWorkerCommitBatchSize || 32,
            maxEntries: Config.coldWorkerQueueMaxEntries || 1024,
            maxBytes: Config.coldWorkerQueueMaxBytes || 4 * 1024 * 1024,
            prepare: (proposal) => this.prepareProposal(proposal),
            commit: (entries) => ColdSimulationOwner.commitAndReleaseBatch(entries),
            afterCommit: (entry, result) => this.afterCommit(entry, result),
            onResults: (results) => {
                const startedAt = Date.now();
                this.handleCommitResults(results)
                    .catch((error) => this.recordError(error))
                    .finally(() => this.queue.recordStage('ackBuild', Date.now() - startedAt));
            },
            onPause: () => this.setPauseReason('commit_queue_high_water', true),
            onResume: () => this.setPauseReason('commit_queue_high_water', false),
            admitEarlyFlush: () => {
                const pressure = this.desiredWorkerPressure();
                if (pressure.lagMs >= Math.max(1, Number(Config.schedulerLagThrottleMs) || 40)) return null;
                const governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
                const admission = governor.admit({
                    job: 'cold_commit_early', resource: 'sqlite-heavy',
                    requestedBudgetMs: Math.max(8, Number(Config.schedulerSliceMs) || 12),
                    minimumBudgetMs: EARLY_COMMIT_ROW_BUDGET_MS,
                    playerProtected: pressure.player, lagMs: pressure.lagMs
                });
                return admission.ok ? admission.lease : null;
            },
            completeEarlyFlush: (lease, durationMs) => {
                invoke('GameServer/Bot/Population/BackgroundWorkGovernor').complete(lease, { durationMs });
            }
        });
    }

    start(population = null) {
        this.competitionActions.stopping = false;
        if (this.started || Config.enabled === false || Config.backgroundResolverEnabled === false) return Promise.resolve(false);
        this.population = population || this.population;
        this.started = true;
        this.stopping = false;
        return Promise.all([LifeState.init(), BackgroundPartyState.init()]).then(async ([lifeReady, partyReady]) => {
            if (this.stopping) {
                this.started = false;
                return false;
            }
            if (!lifeReady || !partyReady) {
                this.started = false;
                this.recordError(new Error(`cold_population_startup_unavailable:life=${lifeReady ? 'ready' : 'failed'}:party=${partyReady ? 'ready' : 'failed'}`));
                return false;
            }
            // LifeState startup has already released members of historical
            // dissolved parties. Only then is it safe to trim the rows.
            await BackgroundPartyState.purgeHistory();
            this.queue.start();
            this.startWorker();
            this.watchdogTimer = setInterval(() => this.watchdog(), 1000);
            this.reconcileTimer = setInterval(() => {
                this.sendSnapshots(false).catch((error) => this.recordError(error));
            }, Math.max(2000, Number(Config.coldWorkerSnapshotRefreshMs) || 10000));
            this.recoveryTimer = setInterval(() => {
                ColdSimulationOwner.recoverExpiredLeases().catch((error) => this.recordError(error));
            }, Math.max(1000, Number(Config.coldOwnerRecoveryIntervalMs) || 5000));
            this.renewalTimer = setInterval(() => {
                if (!this.worker || this.stopping) return;
                ColdSimulationOwner.renewActiveLeases({
                    leaseMs: Math.max(2000, Number(Config.coldOwnerLeaseMs) || 30000)
                }).then((renewals) => {
                    const active = (renewals || []).filter((result) => result.ok);
                    if (active.length) this.postCollections('lease_renewal', { renewals: active });
                }).catch((error) => this.recordError(error));
            }, Math.max(1000, Number(Config.coldOwnerRenewalIntervalMs) || 5000));
            this.historyCleanupTimer = setInterval(() => {
                if (this.stopping || this.historyCleanupInFlight) return;
                this.historyCleanupInFlight = BackgroundPartyState.purgeHistory()
                    .catch((error) => this.recordError(error))
                    .finally(() => {
                        this.historyCleanupInFlight = null;
                    });
            }, Math.max(30000, Number(Config.partyHistoryCleanupIntervalMs) || 60 * 60 * 1000));
            this.watchdogTimer.unref?.();
            this.reconcileTimer.unref?.();
            this.recoveryTimer.unref?.();
            this.renewalTimer.unref?.();
            this.historyCleanupTimer.unref?.();
            return true;
        }).catch((error) => {
            this.started = false;
            this.recordError(error);
            return false;
        });
    }

    startWorker() {
        if (this.worker || this.stopping) return;
        this.workerEpoch = `cold-worker:${process.pid}:${randomUUID()}`;
        this.ready = false;
        this.snapshotsLoaded = false;
        this.lastHeartbeatAt = Date.now();
        const worker = new this.WorkerClass(this.workerPath, {
            workerData: { workerEpoch: this.workerEpoch },
            name: 'l2node-cold-simulation',
            resourceLimits: { maxOldGenerationSizeMb: Math.max(128, Number(Config.coldWorkerHeapMb) || 256) }
        });
        this.worker = worker;
        this.counters.workersStarted += 1;
        worker.on('message', (message) => { this.onMessage(message); });
        worker.on('error', (error) => this.onWorkerError(error));
        worker.on('exit', (code) => this.onWorkerExit(code));
    }

    remember(msgId) {
        if (this.seen.has(msgId)) return false;
        this.seen.add(msgId);
        this.seenOrder.push(msgId);
        if (this.seenOrder.length > 4096) this.seen.delete(this.seenOrder.shift());
        return true;
    }

    recordInvalid(reason = 'unknown') {
        this.counters.invalidMessages += 1;
        this.counters.invalidReasons[reason] = Number(this.counters.invalidReasons[reason] || 0) + 1;
    }

    post(type, payload = {}, msgId = null) {
        if (!this.worker || !this.workerEpoch) return null;
        const message = Protocol.envelope(type, this.workerEpoch, payload, msgId);
        const valid = Protocol.validateEnvelope(message, 'main', { workerEpoch: this.workerEpoch });
        if (!valid.ok) {
            this.recordInvalid(`out_${type}_${valid.reason}`);
            return null;
        }
        this.counters.messagesOut += 1;
        this.counters.bytesOut += valid.bytes;
        this.worker.postMessage(message);
        return message.msgId;
    }

    postCollections(type, collections = {}, msgId = null) {
        const pages = collectionPages(type, this.workerEpoch, collections, msgId, (value) => {
            this.recordInvalid(`out_${type}_single_item_too_large`);
            return value?.state ? {
                ...value, state: null, context: {},
                retryAfterMs: Math.max(1000, Number(value.retryAfterMs) || 10000),
                reason: value.reason || 'state_snapshot_too_large'
            } : null;
        });
        if (!Object.values(collections).some((values) => values?.length)) {
            return this.post(type, Object.fromEntries(Object.keys(collections).map((field) => [field, []])), msgId) ? 1 : 0;
        }
        let sent = 0;
        for (const page of pages) if (this.post(type, page, msgId)) sent++;
        return sent;
    }

    async onMessage(message) {
        const valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: this.workerEpoch });
        if (!valid.ok) {
            this.recordInvalid(`in_${valid.reason}`);
            return;
        }
        if (!this.remember(message.msgId)) {
            this.counters.duplicateMessages += 1;
            return;
        }
        this.counters.messagesIn += 1;
        this.counters.bytesIn += valid.bytes;
        const payload = message.payload || {};
        switch (message.type) {
        case 'ready':
            if (payload.phase === 'loaded') {
                this.sendPlanningCatalog();
                this.post('init', { config: this.workerConfig(), catalogVersion: utils.buildNumber() });
            } else if (payload.phase === 'running') {
                this.ready = true;
                this.syncWorkerPressure();
                if (this.pauseReasons.size) this.post('pause', { reasons: [...this.pauseReasons] });
                await this.sendSnapshots(true);
            } else if (payload.phase === 'snapshots_loaded') {
                this.snapshotsLoaded = true;
                this.lastWorkerSnapshot = payload;
                utils.infoSuccess('ColdWorker', 'ready states=%d due=%d', Number(payload.states || 0), Number(payload.due || 0));
            } else if (payload.phase === 'state_loaded') {
                const waiter = this.waiters.get(message.msgId);
                if (waiter) {
                    this.waiters.delete(message.msgId);
                    waiter.resolve(payload);
                }
            }
            break;
        case 'claim_request':
            await this.handleClaimRequest(message);
            break;
        case 'proposal_batch':
            this.handleProposalBatch(message);
            break;
        case 'party_formation_proposal': {
            const waiter = this.waiters.get(message.msgId);
            if (waiter) {
                this.waiters.delete(message.msgId);
                waiter.resolve(payload);
            }
            break;
        }
        case 'release_request':
            await this.handleReleaseRequest(message);
            break;
        case 'command_request':
            this.handleCommandRequest(message);
            break;
        case 'heartbeat':
            this.lastHeartbeatAt = Date.now();
            this.lastWorkerSnapshot = payload;
            if (Config.coldCompetitionActionsEnabled) this.competitionActions.submit(payload.competition);
            break;
        case 'fence_ack':
        case 'drained': {
            const waiter = this.waiters.get(message.msgId);
            if (waiter) {
                this.waiters.delete(message.msgId);
                waiter.resolve(payload);
            }
            break;
        }
        case 'fault':
            this.counters.workerErrors += 1;
            utils.infoWarn('ColdWorker', 'worker fault: %s%s', payload.reason || 'unknown', payload.stack ? `\n${payload.stack}` : '');
            break;
        default:
            break;
        }
    }

    workerConfig() {
        return {
            maxBatch: Math.max(1, Math.min(64, Number(Config.coldWorkerBatchSize) || 64)),
            maxInFlight: this.desiredWorkerPressure().maxInFlight,
            // Normal ambient parties keep their configured cap, while a clan
            // equipment operation may use the native C4 party limit of nine.
            maxAtomicPartySize: Math.max(9, Number(Config.partyMaxSize) || 5),
            claimAckTimeoutMs: 5000,
            flushTargetMs: Math.max(100, Number(Config.coldWorkerOrdinaryFlushMs) || 2000),
            flushHardMs: Math.max(1000, Number(Config.coldWorkerOrdinaryHardMaxMs) || 5000),
            heartbeatMs: Math.max(250, Number(Config.coldWorkerHeartbeatMs) || 1000),
            loopIntervalMs: Math.max(5, Number(Config.coldWorkerLoopIntervalMs) || 20)
        };
    }

    async requestRequiredPartyFormation(options = {}) {
        if (!this.worker || !this.ready || !this.snapshotsLoaded || this.stopping) {
            return { ok: false, reason: 'worker_not_ready', candidates: [] };
        }
        const queue = this.queue.snapshot();
        if (queue.depth > 0 || queue.flushing) {
            return { ok: false, reason: 'commit_queue_busy', candidates: [] };
        }
        const timeoutMs = Math.max(50, Number(options.timeoutMs) || 500);
        const msgId = this.post('party_formation_request', {
            timestamp: Number(options.timestamp || Date.now()),
            candidateLimit: Math.max(2, Math.min(64, Number(options.candidateLimit) || 12)),
            minSize: Math.max(2, Number(options.minSize) || 2),
            maxSize: Math.max(2, Number(options.maxSize) || 5),
            levelRange: Math.max(0, Number(options.levelRange ?? PartyComposition.DEFAULT_LEVEL_RANGE))
        });
        if (!msgId) return { ok: false, reason: 'request_send_failed', candidates: [] };
        let timer = null;
        try {
            const proposal = await new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('party_formation_worker_timeout')), timeoutMs);
                this.waiters.set(msgId, { resolve, reject });
            });
            return { ok: true, ...proposal };
        } catch (error) {
            this.waiters.delete(msgId);
            return { ok: false, reason: error.message, candidates: [] };
        } finally {
            clearTimeout(timer);
        }
    }

    sendPlanningCatalog() {
        const catalogs = [
            { catalog: 'spots', rows: SpotProfiles.ensure() || [] },
            { catalog: 'npc_offers', rows: npcPlanningCatalogRows() }
        ];
        catalogs.forEach(({ catalog, rows }) => {
            let page = [];
            const flush = (done = false) => {
                if (!page.length && !done) return;
                this.post('catalog_page', { catalog, rows: page, done });
                page = [];
            };
            for (const row of rows) {
                const candidate = [...page, row];
                const envelope = Protocol.envelope('catalog_page', this.workerEpoch, {
                    catalog,
                    rows: candidate,
                    done: false
                });
                if (page.length && Protocol.byteLength(envelope) > 240 * 1024) flush(false);
                page.push(row);
                if (page.length >= Protocol.MAX_BATCH) flush(false);
            }
            flush(true);
        });
    }

    contextIndex(options = {}) {
        let profiles = [];
        try { profiles = SpotProfiles.ensure() || []; } catch (_) { profiles = []; }
        const spots = new Map(profiles.map((spot) => [String(spot.id), spot]));
        const parties = new Map((BackgroundPartyState.active?.() || []).map((party) => [Number(party.leaderId || 0), party]));
        let occupancy = {};
        try { occupancy = SpotProfiles.currentOccupancy(profiles) || {}; } catch (_) { occupancy = {}; }
        return {
            spots,
            profiles,
            occupancy,
            parties,
            compactPartyMembers: options.compactPartyMembers === true,
            compactPartyMemberIds: options.compactPartyMemberIds instanceof Set
                ? options.compactPartyMemberIds
                : null
        };
    }

    routeFor(state, currentSpot, party, partyMembers, index) {
        if (!state || state.phase !== 'cold' || state.stats?.travel) return null;
        const partyRoute = !!party;
        const eligibleActivity = state.activity === 'hunting'
            || (partyRoute && state.activity === 'grouped');
        if (!eligibleActivity) return null;
        if (partyRoute && partyMembers.some((member) => ['resting', 'traveling', 'dead'].includes(member.activity))) return null;

        let physical = null;
        try { physical = SpotService.findCurrentSpot(state.loc); } catch (_) { physical = null; }
        const currentId = physical?.id || currentSpot?.id || state.spotId || party?.spotId || null;
        const timestamp = Number(index.timestamp || Date.now());
        const routedMembers = partyRoute ? partyMembers : [state];
        const excludedSpotIds = SpotRiskPolicy.excludedSpotIdsForStates(routedMembers, timestamp);
        const spotBackoff = SpotRiskPolicy.backoffForStates(routedMembers, currentId, timestamp);

        const role = partyRoute ? PartyComposition.roleForState(state) : null;
        const partyRequired = !partyRoute
            && !state.party?.partyId
            && (state.stats?.equipmentPlan?.partyNeed === 'required'
                || state.stats?.equipmentPlan?.requiresParty === true);
        let fallbackSpot = null;
        if (partyRequired) {
            let fallback = null;
            try {
                fallback = GearAcquisitionPlanner.safeFallbackForPlan(
                    state,
                    state.stats?.equipmentPlan,
                    // Preserve catalog identity for the planner's source-index cache.
                    index.profiles || [...index.spots.values()],
                    { occupancy: index.occupancy, excludedSpotIds }
                );
            } catch (_) { fallback = null; }
            fallbackSpot = (fallback && index.spots.get(String(fallback.spotId))) || null;
            if (fallbackSpot && !LevelingRoutes.isSpotAllowedForState(fallbackSpot, state)) {
                fallbackSpot = null;
            }
            if (!fallbackSpot) {
                try {
                    fallbackSpot = SpotProfiles.findForState({
                        ...state,
                        spotId: null,
                        stats: Object.fromEntries(Object.entries(state.stats || {})
                            .filter(([key]) => key !== 'equipmentPlan'))
                    }, { occupancy: index.occupancy, excludedSpotIds, timestamp });
                } catch (_) { fallbackSpot = null; }
            }
        }
        const routeState = partyRoute
            ? {
                ...state,
                spotId: party.spotId || state.spotId,
                party: { ...(state.party || {}), partyId: party.partyId, role },
                stats: { ...(state.stats || {}), routeMode: 'party' }
            }
            : fallbackSpot
                ? { ...state, spotId: null }
                : state;
        const options = {
            occupancy: index.occupancy,
            capacityStates: routedMembers,
            excludedSpotIds,
            timestamp,
            ...(partyRoute ? { mode: 'party', role } : {})
        };
        // Match the combat resolver: an indexed coordinate sector only
        // describes the current ground when it agrees with the persisted
        // spot. Legacy dungeon sectors can keep their qualified id/name after
        // the rebuilt spawn index exposes the same grid as an ordinary field.
        const currentGround = currentSpot
            && (!state.spotId || String(state.spotId) === String(currentSpot.id))
            ? currentSpot
            : (state.spotId || state.currentRegion) ? {
                id: state.spotId || null,
                name: state.currentRegion || null,
                area: state.area || state.stats?.area || null
            } : currentSpot;
        const unsafeSoloGround = !partyRoute && currentGround
            && !LevelingRoutes.isSpotAllowedForState(currentGround, state, { ...options, mode: 'solo' });
        let selected = fallbackSpot;
        try {
            if (!selected) selected = SpotProfiles.findForState(routeState, options);
        } catch (_) { selected = null; }
        if (unsafeSoloGround && selected) {
            const repeatsCurrentGround = String(selected.id || '') === String(currentId || '');
            const destinationSafeForSolo = LevelingRoutes.isSpotAllowedForState(
                selected,
                state,
                { ...options, mode: 'solo' }
            );
            if (repeatsCurrentGround || !destinationSafeForSolo) selected = null;
        }
        if (!selected && unsafeSoloGround) {
            // Normal routing respects destination capacity. If every suitable
            // field is full, that can leave a detached party member polling a
            // blocked dungeon forever. Only for this rare safety evacuation,
            // choose the least-bad allowed field and let admission exceed its
            // soft capacity by one.
            const emergencyCandidates = (index.profiles || [...index.spots.values()])
                .filter((profile) => String(profile.id) !== String(currentId || ''))
                .filter((profile) => !excludedSpotIds.has(String(profile.id)))
                .filter((profile) => LevelingRoutes.isSpotAllowedForState(
                    profile,
                    state,
                    { ...options, mode: 'solo' }
                ))
                .filter((profile) => SpotProfiles.hasCapacityForStates(
                    profile,
                    routedMembers,
                    index.occupancy,
                    { maxOverflowUnits: 1 }
                ))
                .filter((profile) => (
                    Number(profile.minLevel || 1) <= Number(state.level || 1) + 4
                    && Number(profile.maxLevel || profile.minLevel || 1) >= Number(state.level || 1) - 4
                ));
            const suitable = emergencyCandidates.filter((profile) => (
                SpotService.isSuitable(profile, Number(state.level || 1), options)
            ));
            selected = LevelingRoutes.bestSpot(
                suitable.length ? suitable : emergencyCandidates,
                state,
                { ...options, mode: 'solo' }
            )?.spot || null;
        }
        if (!selected) return null;

        if (String(selected.id) === String(currentId || '')) return null;

        const reserved = SpotProfiles.reserveCapacity(index.occupancy, selected, routedMembers, {
            maxOverflowUnits: unsafeSoloGround ? 1 : 0
        });
        if (!reserved) return null;

        const members = partyRoute ? partyMembers : [state];
        const destinations = {};
        for (const member of members) {
            let destination = null;
            try { destination = SpotService.arrivalPointForState(member, selected); } catch (_) { destination = null; }
            if (!destination) return null;
            destinations[String(member.characterId)] = destination;
        }
        const activeEquipmentPlan = state.stats?.equipmentPlan?.status === 'active';
        return {
            needed: true,
            mode: partyRoute ? 'party' : 'solo',
            currentSpotId: currentId,
            spotId: selected.id,
            regionName: selected.name || state.currentRegion || 'Hunting Ground',
            travelMs: HUNTING_TRAVEL_MS,
            reason: partyRoute
                ? 'party_spot_replan'
                : unsafeSoloGround ? 'unsafe_ground_evacuation'
                : spotBackoff ? 'death_pressure_replan'
                    : activeEquipmentPlan ? 'equipment_source_replan' : 'level_replan',
            ...(spotBackoff ? { cause: 'death_pressure', spotBackoff } : {}),
            to: destinations[String(state.characterId)] || null,
            destinations
        };
    }

    contextFor(state, index = this.contextIndex()) {
        let physical = null;
        try { physical = SpotService.findCurrentSpot(state.loc); } catch (_) { physical = null; }
        const spot = (physical && index.spots.get(String(physical.id)))
            || index.spots.get(String(state.spotId || ''))
            || null;
        let pressure = {};
        try { pressure = Director.pressureForState(state) || {}; } catch (_) { pressure = {}; }
        const party = index.parties.get(Number(state.characterId)) || null;
        const partyMembers = party
            ? (party.memberIds || []).map((characterId) => LifeState.cachedState(characterId)).filter(Boolean).map((member) => {
                const memberId = Number(member.characterId || 0);
                const compact = index.compactPartyMembers === true
                    || index.compactPartyMemberIds?.has(memberId);
                return compact ? compactPartyMemberContext(member) : member;
            })
            : [];
        return {
            spot,
            interactionMemory: invoke('GameServer/Social/InteractionMemoryRuntime').snapshot(Number(state.characterId)),
            pressure,
            targetNpcId: directDropTargetNpcId(state.stats?.equipmentPlan),
            isPartyLeader: !!party,
            party,
            partyMembers,
            route: this.routeFor(state, spot, party, partyMembers, index)
        };
    }

    snapshotEntry(state, index = this.contextIndex()) {
        return { state, context: this.contextFor(state, index) };
    }

    snapshotPressure() {
        const scheduler = Metrics.schedulerState || {};
        return {
            lagMs: Math.max(
                Number(Metrics.currentEventLoopLag?.() || 0),
                Number(scheduler.lagMs || 0)
            ),
            player: Number(scheduler.realPlayers || 0) > 0 || scheduler.mode === 'player'
        };
    }

    markDirty(state, options = {}) {
        if (!state?.characterId || !this.worker || !this.ready) {
            return { ok: false, reason: 'worker_not_ready' };
        }
        if (this.snapshotInFlightInitial && options.critical !== true) {
            return { ok: false, reason: 'full_snapshot_in_progress' };
        }
        const result = this.snapshotQueue.mark(state, options);
        if (result.ok && result.entry.critical && !this.snapshotInFlightInitial) {
            this.flushCriticalSnapshots().catch((error) => this.recordError(error));
        }
        if (this.snapshotQueue.size() >= this.snapshotQueue.pageSize) this.scheduleSnapshotContinuation();
        return result;
    }

    async sendSnapshotPage(rows, options = {}) {
        const payload = {
            rows,
            done: options.done === true,
            initial: options.initial === true,
            ...(options.priority ? { priority: options.priority } : {})
        };
        if (!this.post('snapshot_page', payload)) return false;
        this.counters.snapshotsSent += rows.length;
        this.counters.snapshotPages += 1;
        return true;
    }

    async sendIncrementalEntries(entries, index, pageSize, priority = null, deadlineAt = Infinity) {
        await invoke('GameServer/Social/InteractionMemoryRuntime').ensureMany(entries.map(entry => Number((entry.state || entry).characterId)));
        // Count each row once instead of serializing every growing page prefix.
        // post() still validates the complete envelope before worker delivery.
        const baseBytes = Protocol.byteLength(Protocol.envelope('snapshot_page', this.workerEpoch, {
            rows: [], done: false, initial: false, ...(priority ? { priority } : {})
        })) + 256;
        let pageBytes = baseBytes;
        let page = [];
        let rowsSent = 0;
        let pagesSent = 0;
        const flush = async () => {
            if (!page.length) return true;
            const rows = page;
            page = [];
            pageBytes = baseBytes;
            if (!await this.sendSnapshotPage(rows, { initial: false, priority })) return false;
            rowsSent += rows.length;
            pagesSent += 1;
            this.counters.snapshotYields += 1;
            await yieldToLoop();
            return true;
        };

        for (const entry of entries) {
            if (rowsSent + page.length > 0 && Date.now() >= deadlineAt) break;
            const row = this.snapshotEntry(entry.state || entry, index);
            const rowBytes = Protocol.byteLength([row]) - 2;
            const tooLarge = page.length > 0 && pageBytes + rowBytes + 1 > PAGE_BYTES;
            if (tooLarge || page.length >= pageSize) {
                if (!await flush()) return { ok: false, rowsSent, pagesSent };
            }
            pageBytes += rowBytes + (page.length ? 1 : 0);
            page.push(row);
        }
        if (!await flush()) return { ok: false, rowsSent, pagesSent };
        return { ok: true, rowsSent, pagesSent };
    }

    async sendFullSnapshot() {
        await this.reconcileOrphanedBackgroundParties();
        // Re-read after reconciliation: releasing an invalid party updates
        // cached member ownership and membership. Sending the pre-repair
        // array would immediately seed the worker with the stale party again.
        const states = LifeState.allStates(Math.max(1, Number(Config.maxPlayingPopulation) + 300 || 2000));
        const compactPartyMemberIds = new Set(states.map((state) => Number(state.characterId || 0)).filter(Boolean));
        const index = this.contextIndex({ compactPartyMemberIds });
        const pageSize = this.snapshotQueue.pageSize;
        const baseBytes = Protocol.byteLength(Protocol.envelope('snapshot_page', this.workerEpoch, {
            rows: [], done: false, initial: true
        })) + 256;
        let pageBytes = baseBytes;
        let page = [];
        let pendingPage = null;
        let rowsSent = 0;
        let pagesSent = 0;

        const emit = async (rows, done) => {
            if (!await this.sendSnapshotPage(rows, { done, initial: true })) return false;
            rowsSent += rows.length;
            pagesSent += 1;
            this.counters.snapshotYields += 1;
            await yieldToLoop();
            return true;
        };

        for (let stateIndex = 0; stateIndex < states.length; stateIndex++) {
            if (stateIndex % pageSize === 0) {
                await invoke('GameServer/Social/InteractionMemoryRuntime').ensureMany(
                    states.slice(stateIndex, stateIndex + pageSize).map(state => Number(state.characterId)));
            }
            const state = states[stateIndex];
            const row = this.snapshotEntry(state, index);
            const rowBytes = Protocol.byteLength([row]) - 2;
            const tooLarge = page.length > 0 && pageBytes + rowBytes + 1 > PAGE_BYTES;
            if (tooLarge || page.length >= pageSize) {
                if (pendingPage && !await emit(pendingPage, false)) return { ok: false, rowsSent, pagesSent };
                pendingPage = page;
                page = [];
                pageBytes = baseBytes;
            }
            pageBytes += rowBytes + (page.length ? 1 : 0);
            page.push(row);
        }
        if (page.length) {
            if (pendingPage && !await emit(pendingPage, false)) return { ok: false, rowsSent, pagesSent };
            pendingPage = page;
        }
        if (!pendingPage) pendingPage = [];
        if (!await emit(pendingPage, true)) return { ok: false, rowsSent, pagesSent };
        return { ok: true, rowsSent, pagesSent };
    }

    async reconcileOrphanedBackgroundParties() {
        const allStates = typeof LifeState.allStates === 'function'
            ? LifeState.allStates(Math.max(2000, Number(Config.maxPlayingPopulation || 0) + 300))
            : [];
        const invalid = BackgroundPartyState.active().map((party) => {
            const memberIds = (party.memberIds || []).map((id) => Number(id)).filter(Boolean);
            const states = memberIds.map((id) => LifeState.cachedState(id)).filter(Boolean);
            const statePartyId = (state) => state?.party?.partyId ?? state?.partyId ?? null;
            const attached = states.filter((state) => (
                String(statePartyId(state) || '') === String(party.partyId)
            ));
            const leaderAttached = attached.some((state) => Number(state.characterId) === Number(party.leaderId));
            const declared = new Set(memberIds);
            const extraAttached = allStates.some((state) => (
                String(statePartyId(state) || '') === String(party.partyId)
                && !declared.has(Number(state.characterId))
            ));
            const reason = !memberIds.length || !states.length
                ? 'orphaned_dissolved_party'
                : !leaderAttached || attached.length !== memberIds.length || extraAttached
                    ? 'party_membership_mismatch'
                    : null;
            return reason ? { party, reason } : null;
        }).filter(Boolean);
        for (const entry of invalid) {
            const { party, reason } = entry;
            const dissolved = await BackgroundPartyState.setStatus(party.partyId, 'dissolved');
            if (dissolved) {
                const released = await LifeState.releaseDissolvedPartyMembers(
                    party.partyId,
                    reason
                );
                console.info('ColdWorker :: dissolved invalid background party %s reason=%s declaredMembers=%d releasedMembers=%d',
                    party.partyId,
                    reason,
                    party.memberIds?.length || 0,
                    released);
            }
        }
        return invalid.map((entry) => entry.party);
    }

    startSnapshotJob(mode, work, pressure = {}) {
        const startedAt = Date.now();
        this.snapshotInFlightInitial = mode === 'full';
        const job = (async () => {
            try {
                const result = await work();
                this.snapshotLast = {
                    mode,
                    rows: Number(result?.rowsSent || 0),
                    pages: Number(result?.pagesSent || 0),
                    durationMs: Date.now() - startedAt,
                    deferred: false,
                    error: result?.ok === false ? 'send_failed' : null,
                    lagMs: Number(pressure.lagMs || 0),
                    player: pressure.player === true
                };
                return result;
            } catch (error) {
                this.snapshotLast = {
                    mode,
                    rows: 0,
                    pages: 0,
                    durationMs: Date.now() - startedAt,
                    deferred: false,
                    error: error?.message || String(error),
                    lagMs: Number(pressure.lagMs || 0),
                    player: pressure.player === true
                };
                throw error;
            } finally {
                this.snapshotInFlight = null;
                this.snapshotInFlightInitial = false;
                if (this.snapshotRefreshPending && this.started && !this.stopping) {
                    this.snapshotRefreshPending = false;
                    setImmediate(() => this.sendSnapshots(false).catch((error) => this.recordError(error)));
                }
                this.flushCriticalSnapshots().catch((error) => this.recordError(error));
                if (this.snapshotQueue.size()) this.scheduleSnapshotContinuation();
            }
        })();
        this.snapshotInFlight = job;
        return job;
    }

    async flushCriticalSnapshots() {
        if (!this.worker || !this.ready || this.snapshotInFlightInitial) return false;
        if (this.criticalSnapshotInFlight) return this.criticalSnapshotInFlight;

        const job = (async () => {
            while (this.worker && this.ready) {
                const entries = this.snapshotQueue.takeCritical(this.snapshotQueue.pageSize);
                if (!entries.length) break;
                const index = this.contextIndex({ compactPartyMembers: true });
                const result = await this.sendIncrementalEntries(entries, index, this.snapshotQueue.pageSize, 'P0');
                if (!result.ok) {
                    entries.forEach((entry) => this.snapshotQueue.restoreCritical(entry));
                    break;
                }
                entries.forEach((entry) => this.snapshotQueue.complete(entry, true));
                this.counters.snapshotCriticalRuns += 1;
            }
            return true;
        })();
        this.criticalSnapshotInFlight = job;
        job.finally(() => { this.criticalSnapshotInFlight = null; }).catch(() => null);
        return job;
    }

    scheduleSnapshotContinuation() {
        if (this.snapshotContinuationTimer || !this.started || this.stopping || !this.worker || !this.ready) return;
        this.snapshotContinuationTimer = setTimeout(() => {
            this.snapshotContinuationTimer = null;
            this.sendSnapshots(false, true).catch(error => this.recordError(error));
        }, 100);
        this.snapshotContinuationTimer.unref?.();
    }

    async sendSnapshots(initial = false, continuation = false) {
        if (!this.worker || !this.ready) return false;
        if (this.snapshotInFlight || this.criticalSnapshotInFlight) {
            this.snapshotRefreshPending = true;
            return false;
        }
        if (initial) {
            this.counters.snapshotFullRuns += 1;
            return this.startSnapshotJob('full', () => this.sendFullSnapshot());
        }

        if (!this.snapshotQueue.size()) return false;
        const pressure = this.snapshotPressure();
        const plan = this.snapshotQueue.takeNormal(pressure);
        if (plan.deferred) {
            this.counters.snapshotDeferrals += 1;
            this.snapshotLast = {
                mode: 'deferred',
                rows: 0,
                pages: 0,
                durationMs: 0,
                deferred: true,
                error: null,
                lagMs: pressure.lagMs,
                player: pressure.player
            };
            return false;
        }
        if (!plan.entries.length) return false;

        const governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
        let lease = null;
        if (continuation) {
            const admission = governor.admit({ job: 'cold_snapshots', resource: 'cold-snapshots',
                requestedBudgetMs: Math.max(1, Number(Config.schedulerSliceMs) || 12), minimumBudgetMs: 1,
                playerProtected: pressure.player, lagMs: pressure.lagMs });
            if (!admission.ok) { this.scheduleSnapshotContinuation(); return false; }
            lease = admission.lease;
        }

        this.counters.snapshotDirtyRuns += 1;
        return this.startSnapshotJob('dirty', async () => {
            const startedAt = Date.now();
            try {
                const index = this.contextIndex({ compactPartyMembers: true });
                const result = await this.sendIncrementalEntries(plan.entries, index, plan.pageSize, null,
                    startedAt + (lease?.budgetMs || Math.max(1, Number(Config.schedulerSliceMs) || 12)));
                if (result.ok) plan.entries.slice(0, result.rowsSent).forEach(entry => this.snapshotQueue.complete(entry, true));
                return result;
            } finally {
                if (lease) governor.complete(lease, { durationMs: Date.now() - startedAt });
            }
        }, pressure);
    }

    notifyState(state, options = {}) {
        if (!state) return { ok: false, reason: 'missing_state' };
        this.fencedBots.delete(Number(state.characterId));
        return this.markDirty(state, { ...options, critical: options.critical !== false });
    }

    async acceptColdState(state, timeoutMs = 500) {
        if (!state || !this.worker || !this.ready) return { ok: false, reason: 'worker_not_ready' };
        await invoke('GameServer/Social/InteractionMemoryRuntime').ensureMany([Number(state.characterId)]);
        this.fencedBots.delete(Number(state.characterId));
        const msgId = this.post('snapshot_page', {
            rows: [this.snapshotEntry(state)],
            done: false,
            ack: true,
            initial: false
        });
        if (!msgId) return { ok: false, reason: 'state_send_failed' };
        let timer = null;
        try {
            const payload = await new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('cold_worker_accept_timeout')), Math.max(50, Number(timeoutMs) || 500));
                this.waiters.set(msgId, { resolve, reject });
            });
            return { ok: true, reason: 'accepted', ...payload };
        } catch (error) {
            this.waiters.delete(msgId);
            return { ok: false, reason: error.message };
        } finally {
            clearTimeout(timer);
        }
    }

    async handleClaimRequest(message) {
        const candidates = [];
        const missing = [];
        const purposes = new Map();
        for (const candidate of message.payload.candidates || []) {
            const state = LifeState.cachedState(candidate.characterId);
            if (!state) {
                missing.push({ ok: false, characterId: Number(candidate.characterId), reason: 'missing_state' });
                continue;
            }
            const purpose = candidate.purpose || null;
            purposes.set(Number(candidate.characterId), purpose);
            if (purpose?.kind === 'party') {
                const expectedPartyId = String(purpose.partyId || '');
                const currentPartyId = String(state.party?.partyId || state.partyId || '');
                const party = BackgroundPartyState.find(expectedPartyId);
                const declaredMembers = new Set((party?.memberIds || []).map(Number).filter(Boolean));
                if (!expectedPartyId
                    || currentPartyId !== expectedPartyId
                    || party?.status !== 'active'
                    || !declaredMembers.has(Number(state.characterId))) {
                    Metrics.recordColdOwnerRejected('party_membership_changed');
                    missing.push({
                        ok: false,
                        characterId: Number(candidate.characterId),
                        reason: 'party_membership_changed'
                    });
                    continue;
                }
            }
            candidates.push({
                ...candidate,
                state,
                options: {
                    allowParty: candidate.purpose?.kind === 'party',
                    allowLifecycle: ['party', 'resolver'].includes(candidate.purpose?.kind)
                }
            });
            Metrics.recordColdOwnerSelected();
        }
        const claimed = await ColdSimulationOwner.claimBatch(candidates, {
            leaseMs: Math.max(2000, Number(Config.coldOwnerLeaseMs) || 30000)
        });
        const index = this.contextIndex({ compactPartyMembers: true });
        const rebaseIds = [...new Set((claimed.rejected || [])
            .filter((result) => OWNERSHIP_REBASE_REASONS.has(String(result.reason || '')))
            .map((result) => Number(result.characterId))
            .filter((characterId) => Number.isSafeInteger(characterId) && characterId > 0))];
        // Clan warehouse/contribution writes advance simulationRevision in the
        // same legacy row that the worker snapshots. A rejected claim must
        // rebase from SQLite; returning the cached row simply emits the same
        // stale CAS again and turns one legitimate handoff into an IPC storm.
        const authoritativeStates = rebaseIds.length
            ? await LifeState.statesByIds(rebaseIds)
            : [];
        const authoritativeById = new Map(authoritativeStates.map((state) => [
            Number(state.characterId), state
        ]));
        const rejected = [...missing, ...(claimed.rejected || [])].map((result) => {
            const state = authoritativeById.get(Number(result.characterId))
                || LifeState.cachedState(result.characterId);
            if (!state) return result;
            const needsRetryDelay = OWNERSHIP_REBASE_REASONS.has(String(result.reason || ''));
            return {
                ...result,
                ...(needsRetryDelay ? { retryAfterMs: Math.max(1000, Number(result.retryAfterMs) || 1000) } : {}),
                state,
                context: this.contextFor(state, index)
            };
        });
        this.postCollections('claim_ack', {
            grants: (claimed.grants || []).map((grant) => ({ ...grant, purpose: purposes.get(Number(grant.characterId)) || null })),
            rejected: rejected.map((result) => ({ ...result, purpose: purposes.get(Number(result.characterId)) || null }))
        }, message.msgId);
    }

    handleProposalBatch(message) {
        if (message.payload.capacityBlocked === true) this.queue.capacityBlocked = true;
        const rejected = [];
        (message.payload.proposals || []).forEach((proposal) => {
            const tokenValid = Protocol.validateToken(proposal.token);
            if (!tokenValid.ok || Number(proposal.characterId) !== Number(proposal.token?.characterId)) {
                rejected.push({ ok: false, characterId: Number(proposal.characterId || 0), reason: tokenValid.reason || 'token_character' });
                return;
            }
            const queued = this.queue.enqueue(proposal);
            if (!queued.ok) rejected.push({ ok: false, characterId: proposal.characterId, reason: queued.reason, proposal });
            else Metrics.recordColdOwnerResolved();
        });
        if (rejected.length) this.handleCommitResults(rejected).catch((error) => this.recordError(error));
    }

    async prepareProposal(proposal) {
        const state = LifeState.cachedState(proposal.characterId) || proposal.baseState;
        if (!state) return null;
        if (proposal.nextStateDelta) {
            // Never rebase a sparse result over a newer owner or revision.
            const current = state.simulation || {};
            if (current.ownerId !== proposal.token.ownerId
                || Number(current.revision) !== Number(proposal.token.revision)
                || current.leaseId !== proposal.token.leaseId) return null;
            proposal.nextState = ColdStateDelta.apply(state, proposal.nextStateDelta);
        }
        const claimedState = {
            ...state,
            simulation: {
                ownerId: proposal.token.ownerId,
                revision: proposal.token.revision,
                leaseId: proposal.token.leaseId,
                leaseUntil: proposal.token.leaseUntil
            }
        };
        const timestamp = Number(proposal.enqueuedAt || Date.now());
        const cleanupState = this.population?.prepareInventoryCleanupProposal?.(
            claimedState,
            timestamp,
            claimedState.simulation
        );
        if (cleanupState) {
            if (proposal.atomicGroup) return null;
            proposal.inventoryCleanupForced = true;
            proposal.result = {
                events: [],
                debug: { inventoryCleanup: true }
            };
            delete cleanupState.cleanup;
            return cleanupState;
        }
        if (proposal?.nextState) {
            let profiles = [];
            let occupancy = {};
            try {
                profiles = SpotProfiles.ensure() || [];
                occupancy = SpotProfiles.currentOccupancy(profiles) || {};
            } catch (_) { profiles = []; occupancy = {}; }
            const admission = admitSoloRouteTravelState(
                proposal.nextState,
                state,
                profiles,
                occupancy,
                Date.now()
            );
            if (admission.checked && !admission.admitted) this.counters.routeCapacityRejects += 1;
            return admission.state;
        }
        if (!proposal.result) return null;
        return LifeState.prepareResolve(claimedState, proposal.result, {
            persist: false,
            timestamp
        });
    }

    async afterCommit(entry) {
        const state = LifeState.cachedState(entry.nextState.characterId) || entry.nextState;
        await LifeEvents.recordMany(state.characterId, entry.proposal.result?.events || []);
        await LifeState.enqueueEquipmentGoalAdvanceForState(state)
            .catch((error) => {
                utils.infoWarn('BotGoals', 'equipment goal advance enqueue failed for %s: %s',
                    state.characterId, error?.message || error);
            });
        if (entry.proposal.partyResolution?.party) {
            const party = entry.proposal.partyResolution.party;
            await BackgroundPartyState.createOrUpdate(party);
            if (entry.proposal.result?.debug?.activity === 'party_session_review') {
                const review = party.stats?.sessionReview || {};
                const decisions = review.decisions || [];
                const departed = Math.max(0, decisions.length - (party.memberIds || []).length);
                this.partyReviews.committed += 1;
                this.partyReviews.departed += departed;
                this.partyReviews.dissolved += Number(party.status === 'dissolved');
                for (const decision of decisions) {
                    this.partyReviews.reasons[decision.reason] = (this.partyReviews.reasons[decision.reason] || 0) + 1;
                }
                this.partyReviews.recent.unshift({ partyId: party.partyId, at: review.at, departed, status: party.status, decisions });
                this.partyReviews.recent.length = Math.min(12, this.partyReviews.recent.length);
            }
            if (party.status === 'dissolved') {
                await LifeState.clearParty(
                    party.partyId,
                    party.stats?.partyBreakReason || 'party_dissolved'
                );
                Metrics.recordPartyDissolution();
            } else {
                Metrics.recordPartyResolve();
                if (entry.proposal.partyResolution.reviewGoals
                    && this.population?.reconcileWorkerPartyGoals) {
                    await this.population.reconcileWorkerPartyGoals(party, Number(entry.proposal.enqueuedAt || Date.now()))
                        .catch((error) => {
                            utils.infoWarn('BotGoals', 'worker party goal reconcile failed for %s: %s', party.partyId, error?.message || error);
                        });
                }
            }
        }
        Metrics.recordBackgroundResolve();
        Metrics.recordCombat(entry.proposal.result?.debug);
        Metrics.recordResolveDuration(Math.max(0, Date.now() - Number(entry.proposal.enqueuedAt || Date.now())));
        GlobalChat.maybeAnnounce(state, entry.proposal.result?.events || []);
        return state;
    }

    async handleCommitResults(results = []) {
        const releaseTokens = results.filter((result) => !result.ok && result.proposal?.token).map((result) => result.proposal.token);
        if (releaseTokens.length) await ColdSimulationOwner.releaseBatch(releaseTokens).catch(() => []);
        const index = this.contextIndex({ compactPartyMembers: true });
        const acknowledgements = results.map((result) => {
            const state = LifeState.cachedState(result.characterId) || result.nextState || result.proposal?.baseState || null;
            return {
                ok: !!result.ok,
                characterId: Number(result.characterId),
                reason: result.reason || (result.ok ? 'committed' : 'rejected'),
                revision: result.revision,
                state,
                context: state ? this.contextFor(state, index) : {}
            };
        });
        this.postCollections('commit_ack', { results: acknowledgements });
    }

    async handleReleaseRequest(message) {
        const tokens = (message.payload.releases || []).map((entry) => entry.token).filter(Boolean);
        const released = await ColdSimulationOwner.releaseBatch(tokens).catch(() => []);
        const index = this.contextIndex({ compactPartyMembers: true });
        const results = released.map((result) => {
            const state = LifeState.cachedState(result.characterId);
            return { ...result, state, context: state ? this.contextFor(state, index) : {} };
        });
        this.postCollections('release_ack', { results }, message.msgId);
    }

    handleCommandRequest(message) {
        const requests = message.payload.requests || [];
        this.commandTail = this.commandTail.then(async () => {
            const results = [];
            for (const request of requests) {
                this.counters.commands += 1;
                try {
                    const state = LifeState.cachedState(request.characterId) || request.state;
                    const id = Number(request.characterId);
                    Metrics.recordColdOwnerLegacyDeferred(`command_${String(state?.activity || 'unknown')}`);
                    if (this.fencedBots.has(id) || state?.phase !== 'cold') {
                        results.push({ ok: false, characterId: id, reason: 'hot_handoff_fenced', state });
                        continue;
                    }
                    let result;
                    const operation = Promise.resolve(this.population?.executeWorkerLifecycleCommand?.(state, request));
                    this.commandInflight.set(id, operation);
                    try { result = await operation; } finally { this.commandInflight.delete(id); }
                    const nextState = result?.state || LifeState.cachedState(request.characterId) || state;
                    results.push({
                        ok: result?.ok !== false,
                        characterId: request.characterId,
                        reason: result?.reason || (result?.ok === false ? 'command_rejected' : 'command_applied'),
                        state: nextState,
                        context: this.contextFor(nextState, this.contextIndex({ compactPartyMembers: true }))
                    });
                } catch (error) {
                    this.counters.commandErrors += 1;
                    results.push({ ok: false, characterId: request.characterId, reason: error?.message || 'command_error', retryAfterMs: 5000 });
                }
                await new Promise((resolve) => setImmediate(resolve));
            }
            this.postCollections('command_ack', { results }, message.msgId);
        }).catch((error) => this.recordError(error));
    }

    async fenceBot(characterId, timeoutMs = 500) {
        if (!this.worker || !this.ready) return { ok: true, reason: 'worker_not_ready' };
        const id = Number(characterId);
        this.fencedBots.add(id);
        this.counters.fences += 1;
        const msgId = this.post('fence', { characterId: id, deadlineAt: Date.now() + timeoutMs });
        if (!msgId) return { ok: false, reason: 'fence_send_failed' };
        let timer = null;
        const response = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('cold_worker_fence_timeout')), Math.max(50, Number(timeoutMs) || 500));
            this.waiters.set(msgId, { resolve, reject });
        });
        try {
            const fenced = await response;
            if (fenced.proposal) {
                this.queue.enqueue({ ...fenced.proposal, priority: 'P0' });
            }
            const command = this.commandInflight.get(id);
            if (command) await Promise.race([command.catch(() => null), wait(timeoutMs)]);
            await this.queue.flushCharacter(id);
            return { ok: true, reason: 'fenced', ...fenced };
        } catch (error) {
            this.counters.fenceTimeouts += 1;
            this.waiters.delete(msgId);
            return { ok: false, reason: error.message };
        } finally {
            clearTimeout(timer);
        }
    }

    watchdog() {
        if (!this.worker || this.stopping) return;
        this.syncWorkerPressure();
        const age = Date.now() - this.lastHeartbeatAt;
        if (age <= Math.max(5000, Number(Config.coldWorkerUnhealthyMs) || 5000)) {
            this.setPauseReason('heartbeat_stale', false);
            return;
        }
        this.setPauseReason('heartbeat_stale', true, { age });
        if (age > Math.max(10000, Number(Config.coldWorkerDeadMs) || 10000)) {
            this.worker.terminate().catch(() => null);
        }
    }

    desiredWorkerPressure() {
        const scheduler = Metrics.schedulerState || {};
        const lagMs = Math.max(
            Number(Metrics.currentEventLoopLag?.() || 0),
            Number(scheduler.lagMs || 0)
        );
        const player = Number(scheduler.realPlayers || 0) > 0 || scheduler.mode === 'player';
        const idleLimit = Math.max(1, Math.min(128, Number(Config.coldWorkerMaxInFlight) || 32));
        const playerLimit = Math.max(1, Math.min(idleLimit, Number(Config.coldWorkerPlayerMaxInFlight) || 8));
        const lagLimit = Math.max(1, Math.min(playerLimit, Number(Config.coldWorkerLagMaxInFlight) || 2));
        const throttleMs = Math.max(0, Number(Config.schedulerLagThrottleMs) || 0);
        const abortMs = Math.max(0, Number(Config.schedulerLagAbortMs) || 0);
        let maxInFlight = player ? playerLimit : idleLimit;

        if (abortMs > 0 && lagMs >= abortMs) {
            maxInFlight = lagLimit;
        } else if (throttleMs > 0 && lagMs > throttleMs) {
            maxInFlight = Math.max(lagLimit, Math.floor(maxInFlight / 2));
        }

        return { maxInFlight, lagMs, player };
    }

    syncWorkerPressure() {
        if (!this.worker || !this.ready) return null;
        const pressure = this.desiredWorkerPressure();
        if (this.workerMaxInFlight === pressure.maxInFlight) return pressure;
        this.workerMaxInFlight = pressure.maxInFlight;
        this.post('throttle', {
            maxInFlight: pressure.maxInFlight,
            lagMs: pressure.lagMs,
            player: pressure.player
        });
        return pressure;
    }

    setPauseReason(reason, active, detail = {}) {
        const key = String(reason || 'unknown');
        const wasPaused = this.pauseReasons.size > 0;
        if (active) this.pauseReasons.add(key);
        else this.pauseReasons.delete(key);
        const paused = this.pauseReasons.size > 0;
        if (!wasPaused && paused) this.post('pause', { reasons: [...this.pauseReasons], ...detail });
        else if (wasPaused && !paused) this.post('resume', { reason: key });
        return paused;
    }

    onWorkerError(error) {
        this.counters.workerErrors += 1;
        this.recordError(error);
    }

    onWorkerExit(code) {
        this.counters.workerExits += 1;
        this.worker = null;
        this.workerMaxInFlight = null;
        this.ready = false;
        this.snapshotsLoaded = false;
        this.waiters.forEach((waiter) => waiter.reject(new Error('cold_worker_exited')));
        this.waiters.clear();
        this.pauseReasons.delete('heartbeat_stale');
        if (this.stopping) return;
        ColdSimulationOwner.recoverStartupLeases().catch((error) => this.recordError(error));
        const delays = [1000, 2000, 5000, 10000, 30000];
        const restartDelay = delays[Math.min(this.restartCount, delays.length - 1)];
        this.restartCount += 1;
        this.counters.workerRestarts += 1;
        utils.infoWarn('ColdWorker', 'worker exited code=%d; restarting in %dms', Number(code || 0), restartDelay);
        this.restartTimer = setTimeout(() => this.startWorker(), restartDelay);
        this.restartTimer.unref?.();
    }

    recordError(error) {
        Metrics.recordColdOwnerError(error);
        utils.infoWarn('ColdWorker', '%s', error?.message || String(error));
    }

    async stop() {
        if (!this.started) return { stopped: true };
        this.stopping = true;
        await this.competitionActions.stop();
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        if (this.reconcileTimer) clearInterval(this.reconcileTimer);
        if (this.snapshotContinuationTimer) clearTimeout(this.snapshotContinuationTimer);
        if (this.recoveryTimer) clearInterval(this.recoveryTimer);
        if (this.renewalTimer) clearInterval(this.renewalTimer);
        if (this.historyCleanupTimer) clearInterval(this.historyCleanupTimer);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.watchdogTimer = null;
        this.reconcileTimer = null;
        this.snapshotContinuationTimer = null;
        this.recoveryTimer = null;
        this.renewalTimer = null;
        this.historyCleanupTimer = null;
        this.restartTimer = null;
        this.pauseReasons.clear();
        await Promise.race([this.snapshotInFlight || Promise.resolve(), wait(10000)]).catch(() => null);
        await Promise.race([this.criticalSnapshotInFlight || Promise.resolve(), wait(10000)]).catch(() => null);
        let drained = null;
        if (this.worker) {
            const msgId = this.post('shutdown', { deadlineAt: Date.now() + 10000 });
            if (msgId) {
                drained = await Promise.race([
                    new Promise((resolve, reject) => this.waiters.set(msgId, { resolve, reject })),
                    wait(10000).then(() => null)
                ]).catch(() => null);
            }
        }
        const queue = await this.queue.drain(10000);
        await Promise.race([this.commandTail.catch(() => null), wait(10000)]);
        await Promise.race([this.historyCleanupInFlight || Promise.resolve(), wait(10000)]).catch(() => null);
        this.historyCleanupInFlight = null;
        if (this.worker) await this.worker.terminate().catch(() => null);
        this.worker = null;
        await ColdSimulationOwner.recoverStartupLeases().catch(() => null);
        this.started = false;
        return { stopped: true, drained, queue };
    }

    snapshot() {
        return {
            ...this.counters,
            started: this.started,
            ready: this.ready,
            snapshotsLoaded: this.snapshotsLoaded,
            epoch: this.workerEpoch,
            heartbeatAgeMs: this.worker ? Math.max(0, Date.now() - this.lastHeartbeatAt) : null,
            worker: { ...this.lastWorkerSnapshot },
            competitionActions: this.competitionActions.snapshot(),
            partyReviews: this.partyReviews,
            queue: this.queue.snapshot(),
            snapshots: {
                ...this.snapshotQueue.snapshot(),
                inFlight: !!this.snapshotInFlight,
                inFlightInitial: this.snapshotInFlightInitial,
                refreshPending: this.snapshotRefreshPending,
                criticalInFlight: !!this.criticalSnapshotInFlight,
                last: { ...this.snapshotLast },
                fullRuns: this.counters.snapshotFullRuns,
                dirtyRuns: this.counters.snapshotDirtyRuns,
                criticalRuns: this.counters.snapshotCriticalRuns,
                yields: this.counters.snapshotYields,
                deferrals: this.counters.snapshotDeferrals
            }
        };
    }
}

module.exports = new ColdSimulationCoordinator();
module.exports.ColdSimulationCoordinator = ColdSimulationCoordinator;
module.exports.compactPartyMemberContext = compactPartyMemberContext;
module.exports.npcPlanningCatalogRows = npcPlanningCatalogRows;
module.exports.admitSoloRouteTravelState = admitSoloRouteTravelState;
