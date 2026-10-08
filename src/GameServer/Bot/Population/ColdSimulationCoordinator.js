const DiagnosticConfig = require('./PopulationConfig');
const { collectionPagesWithBytes, PAGE_BYTES } = require('./ColdMessagePages');
const path = require('path');
const { randomUUID } = require('crypto');
const { Worker } = require('worker_threads');
const { performance } = require('perf_hooks');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const DataCache = invoke('GameServer/DataCache');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const HuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Protocol = require('./ColdSimulationProtocol');
const { ColdEconomyDecisions } = require('./ColdEconomyDecision');
const { TTL_MS: COMPETITION_TTL_MS } = require('./ColdCompetitionActions');
const ColdStateDelta = require('./ColdStateDelta');
const { ColdCommitQueue, EARLY_COMMIT_ROW_BUDGET_MS } = require('./ColdCommitQueue');
const { ColdSnapshotQueue } = require('./ColdSnapshotQueue');
const { ColdProjectionRetention } = require('./ColdProjectionRetention');
const ColdSafetyTransport = require('./ColdSafetyTransport');
const ColdNpcPlanningCatalog = require('./ColdNpcPlanningCatalog');
const TableChannel = require('./ColdTableChannel');
const TownNpcCatalog = require('../Economy/TownNpcCatalog');

const ColdTrip = require('./ColdTrip');
// Private main-thread provenance survives the queue's shallow clone but is
// excluded from JSON/wire sizing and cannot be supplied by a Worker message.
const PROPOSAL_SOURCE = Symbol('cold-proposal-source');
const CLAN_BEFORE = Symbol('cold-clan-before');
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

// Longest stretch the initial full snapshot builds rows without yielding.
const SNAPSHOT_SLICE_MS = 50;

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
    const spot = SpotIndex.spotById(profiles, travel.spotId);
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
        state: SpotRiskPolicy.withCapacityBackoff({
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
        }, travel.spotId, timestamp),
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
        this.tableChannel = options.tableChannel || TableChannel.shared;
        this.worker = null;
        this.workerEpoch = null;
        this.safetyTransport = null;
        this.projectionRetention = new ColdProjectionRetention({
            stateFor: id => LifeState.cachedState(id), epoch: () => this.workerEpoch,
            dependencies: (state, context) => {
                const memory = invoke('GameServer/Social/InteractionMemoryRuntime').snapshots.get(Number(state.characterId));
                const pressure = Director.pressureForState(state);
                const party = context.party ? BackgroundPartyState.find(context.party.partyId) : null;
                const leaf = !party ? this.economyDecisions.activity(state) : null;
                return {
                    catalog: SpotProfiles.cache, physicalCatalog: SpotService.spots,
                    partyGeneration: BackgroundPartyState.generation(), party,
                    pressure: [pressure.expMultiplier, pressure.deathChanceMultiplier, pressure.directorReason],
                    memory, memoryRevision: memory?.revision,
                    clanId: invoke('GameServer/Clan/ClanSocialRuntime').view.memberships.get(Number(state.characterId)) || 0,
                    escrow: invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(state.characterId),
                    targetNpcId: party ? require('./PartyHuntingTarget').npcId(party, state)
                        : leaf?.activity === 'hunting' ? (leaf.npcId || null) : null
                };
            }
        });
        this.population = null;
        this.started = false;
        this.stopping = false;
        this.stopPromise = null;
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
        this.leaseRenewalRound = null;
        this.leaseRenewalInFlight = null;
        this.historyCleanupTimer = null;
        this.historyCleanupInFlight = null;
        this.seen = new Set();
        this.economyDecisions = new ColdEconomyDecisions();
        this.economyRoutes = new (require('../Economy/EconomyRouteCache').EconomyRouteCache)({
            send: payload => !this.stopping && this.ready && !!this.post('economy_route_request', payload),
            prepared: (id, key) => {
                const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
                Economy.forgetContext(id, 'state_publication');
                const record = invoke('GameServer/World/World').registeredActorById(id);
                const session = record?.session;
                if (record && !record.retired && session?.actor === record.actor
                    && require('../Economy/EconomicTrip').key(Economy.stateForActor(record.actor, session)) === key)
                    require('../AI/DecisionEvents').prepared(session);
            }
        });
        this.unsubscribeWishRemovals = LifeState.subscribePublications(packet => {
            if (packet.kind !== 'remove') return;
            this.economyDecisions.forget(packet.characterId);
            this.economyRoutes.forget(packet.characterId);
            invoke('GameServer/Bot/Economy/EconomyContext').forget(packet.characterId);
        });
        this.seenOrder = [];
        this.waiters = new Map();
        this.commandTail = Promise.resolve();
        this.competitionFrameAdmission = null;
        this.competitionActions = new (require('./ColdCompetitionActions').ColdCompetitionActions)({
            life: LifeState, owner: ColdSimulationOwner,
            memory: invoke('GameServer/Social/InteractionMemoryRuntime'),
            parties: BackgroundPartyState,
            personaFor: state => invoke('GameServer/Bot/AI/BotPersona').of(state),
            conflictsEnabled: () => Config.coldCompetitionConflictsEnabled === true,
            pvpEnabled: () => Config.coldCompetitionPvpEnabled === true,
            incrementalPvp: true,
            onEncounter: encounter => invoke('GameServer/Bot/Population/PvpEncounterRuntime').register(encounter),
            contestContextAllowed: (state, event) => {
                const physical = SpotService.findCurrentSpot(state.loc);
                const spot = SpotProfiles.findById(event.spotId);
                return physical?.id === event.spotId && (event.action === 'revenge' || !!spot?.npcEntries?.some(row => Number(row.selfId) === event.npcId));
            },
            participantAllowed: id => !this.fencedBots.has(Number(id)),
            releaseForecasts: events => this.post('competition_release', { events: events.map(e => ({ at: e.at, action: e.action,
                actor: { id: e.actor.id, partyId: e.actor.partyId || null }, peer: { id: e.peer.id, partyId: e.peer.partyId || null } })) }),
            retreatRoute: (members, party, event, timestamp) => {
                const leader = members.find(s => s.characterId === party?.leaderId) || members[0];
                const index = this.contextIndex();
                index.timestamp = timestamp;
                const route = this.routeFor(leader, index.spots.get(String(event.spotId)), party, members, index);
                return route ? { ...route, cause: 'competition_avoid', reason: party ? 'party_spot_replan' : 'competition_avoid' } : null;
            },
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
            routeCapacityRejects: 0,
            afterCommitStepErrors: { partyCache: 0, raidCache: 0, raidSettlement: 0, economyDecision: 0,
                journal: 0, board: 0, equipment: 0, training: 0, improvement: 0, party: 0, metrics: 0, announce: 0,
                economyPlan: 0, clanEvents: 0, partyPlans: 0, buff: 0 }
        };
        this.economyPlanCount = 0;
        this.economyPlanTimes = [];
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
                const startedAt = Config.developerDiagnostics ? Date.now() : 0;
                this.handleCommitResults(results)
                    .catch((error) => this.recordError(error))
                    .finally(() => { if (Config.developerDiagnostics) this.queue.recordStage('ackBuild', Date.now() - startedAt); });
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
        if (this.stopPromise) return Promise.resolve(false);
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
            await require('./ColdRaidAuthority').init();
            await invoke('GameServer/Clan/ClanSocialRuntime').refresh(true);
            require('./ColdOccupationSources').initialise();
            this.queue.start();
            this.startWorker();
            this.watchdogTimer = setInterval(() => this.watchdog(), 1000);
            const encounters = invoke('GameServer/Bot/Population/PvpEncounterRuntime');
            LifeState.allStates(2000).forEach(s => encounters.register(s.stats?.pvpEncounter));
            this.pvpEncounterTimer = setInterval(() => {
                encounters.tick(this.competitionActions)?.catch(error => this.recordError(error));
            }, 1000);
            this.reconcileTimer = setInterval(() => {
                this.tableChannel.flush();
                this.sendSnapshots(false).catch((error) => this.recordError(error));
            }, Math.max(2000, Number(Config.coldWorkerSnapshotRefreshMs) || 10000));
            this.recoveryTimer = setInterval(() => {
                ColdSimulationOwner.recoverExpiredLeases().catch((error) => this.recordError(error));
            }, Math.max(1000, Number(Config.coldOwnerRecoveryIntervalMs) || 5000));
            this.renewalTimer = setInterval(() => {
                this.beginLeaseRenewalRound();
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
        this.cancelLeaseRenewalRound();
        this.workerEpoch = `cold-worker:${process.pid}:${randomUUID()}`;
        this.competitionFrameAdmission = null;
        this.projectionRetention.reset();
        this.ready = false;
        this.snapshotsLoaded = false;
        this.lastHeartbeatAt = Date.now();
        const worker = new this.WorkerClass(this.workerPath, {
            workerData: { workerEpoch: this.workerEpoch, developerDiagnostics: Config.developerDiagnostics === true },
            name: 'l2node-cold-simulation',
            resourceLimits: { maxOldGenerationSizeMb: Math.max(128, Number(Config.coldWorkerHeapMb) || 256) }
        });
        this.worker = worker;
        Metrics.beginColdSafetyEpoch(this.workerEpoch);
        this.attachSafetyTransport();
        DiagnosticConfig.developerDiagnostics && (this.counters.workersStarted += 1);
        const epoch = this.workerEpoch;
        worker.on('message', (message) => { this.onMessage(message, worker, epoch); });
        worker.on('error', (error) => {
            if (this.worker === worker && this.workerEpoch === epoch) this.onWorkerError(error);
        });
        worker.on('exit', (code) => this.onWorkerExit(code, worker, epoch));
    }

    remember(msgId) {
        if (this.seen.has(msgId)) return false;
        this.seen.add(msgId);
        this.seenOrder.push(msgId);
        if (this.seenOrder.length > 4096) this.seen.delete(this.seenOrder.shift());
        return true;
    }

    recordInvalid(reason = 'unknown') {
        DiagnosticConfig.developerDiagnostics && (this.counters.invalidMessages += 1);
        DiagnosticConfig.developerDiagnostics && (this.counters.invalidReasons[reason] = Number(this.counters.invalidReasons[reason] || 0) + 1);
    }

    post(type, payload = {}, msgId = null, bytes = null) {
        if (!this.worker || !this.workerEpoch) return null;
        const entries = type === 'snapshot_page' ? payload.rows
            : type === 'claim_ack' ? payload.rejected
                : ['commit_ack', 'release_ack', 'command_ack'].includes(type) ? payload.results : [];
        for (const entry of entries || []) {
            this.projectionRetention.remember(entry);
        }
        const message = Protocol.envelope(type, this.workerEpoch, payload, msgId);
        const valid = Protocol.validateEnvelope(message, 'main', { workerEpoch: this.workerEpoch, bytes });
        if (!valid.ok) {
            this.recordInvalid(`out_${type}_${valid.reason}`);
            return null;
        }
        DiagnosticConfig.developerDiagnostics && (this.counters.messagesOut += 1);
        DiagnosticConfig.developerDiagnostics && (this.counters.bytesOut += valid.bytes);
        message.bytes = valid.bytes;
        this.worker.postMessage(message);
        return message.msgId;
    }

    routeRows(state) {
        if (this.stopping || !this.ready) return null;
        const Trip = require('../Economy/EconomicTrip');
        return this.economyRoutes.read(state.characterId, Trip.key(state), Trip.frame(state));
    }

    requestEconomyLook(characterId) {
        const id = Number(characterId);
        if (this.stopping || !Number.isSafeInteger(id) || id <= 0
            || LifeState.cachedState(id)?.phase !== 'hot') return false;
        // A natural owner event requests its existing canonical worker row.
        // Empty rows retain neither an owner copy nor a snapshot/ACK cursor.
        return !!this.post('snapshot_page', { rows: [], economyOwnerId: id });
    }

    postCollections(type, collections = {}, msgId = null) {
        const pages = collectionPagesWithBytes(type, this.workerEpoch, collections, msgId, (value) => {
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
        for (const page of pages) if (this.post(type, page.payload, msgId, page.bytes)) sent++;
        return sent;
    }

    releaseCompetitionForecasts(events, worker, epoch) {
        if (this.stopping || this.worker !== worker || this.workerEpoch !== epoch) return null;
        return this.post('competition_release', { events: events.map(e => ({ at: e.at, action: e.action,
            actor: { id: e.actor.id, partyId: e.actor.partyId || null }, peer: { id: e.peer.id, partyId: e.peer.partyId || null } })) });
    }

    handleCompetitionForecast(forecast, worker, epoch) {
        if (this.stopping || this.worker !== worker || this.workerEpoch !== epoch || !forecast) return;
        const releaseForecasts = events => this.releaseCompetitionForecasts(events, worker, epoch);
        const frame = forecast.frame;
        if (frame === undefined) {
            if (Config.coldCompetitionActionsEnabled) this.competitionActions.submit(forecast, { releaseForecasts });
            return;
        }
        const reply = status => {
            if (this.stopping || this.worker !== worker || this.workerEpoch !== epoch) return;
            this.post('competition_release', { events: [], receipt: { frameId: frame.frameId, at: frame.at, status } });
        };
        const accepted = this.competitionFrameAdmission;
        if (accepted?.worker === worker && accepted.epoch === epoch) {
            if (accepted.frameId === frame.frameId && accepted.at === frame.at) {
                reply(accepted.status);
                return;
            }
            if (frame.frameId <= accepted.frameId) return;
        }
        const now = Date.now();
        if (frame.at > now) { reply('deferred'); return; }
        if (now - frame.at > COMPETITION_TTL_MS) { reply('expired'); return; }
        const status = Config.coldCompetitionActionsEnabled
            ? this.competitionActions.submit(frame, { framed: true, releaseForecasts }) ? 'accepted' : 'deferred'
            : 'observed';
        if (status === 'accepted' || status === 'observed') {
            // Install before sending: a lost receipt replays this admission,
            // even after TTL, without installing another action task.
            this.competitionFrameAdmission = { worker, epoch, frameId: frame.frameId, at: frame.at, status };
        }
        reply(status);
    }

    async onMessage(message, worker = this.worker, epoch = this.workerEpoch) {
        if (this.worker !== worker || this.workerEpoch !== epoch) return;
        if (message?.type === 'economy_diagnostics' && Config.developerDiagnostics && Config.economyDiagnostics && message.epoch === epoch) {
            if (!Number.isSafeInteger(message.id) || message.id <= 0) return;
            const diagnostics = require('../Economy/EconomyDiagnostics');
            const accepted = diagnostics.accept(message.records);
            if (this.diagnosticEpoch !== epoch) { this.diagnosticEpoch = epoch; this.diagnosticDropped = 0; }
            const dropped = Number(message.dropped);
            if (Number.isSafeInteger(dropped) && dropped >= this.diagnosticDropped) {
                diagnostics.noteDropped(dropped - this.diagnosticDropped); this.diagnosticDropped = dropped;
            }
            worker.postMessage({ type: 'economy_diagnostics_ack', epoch, id: message.id,
                accepted: Number.isSafeInteger(accepted) ? accepted : 0 }); return;
        }
        const valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: this.workerEpoch, bytes: message?.bytes });
        if (!valid.ok) {
            this.recordInvalid(`in_${valid.reason}`);
            return;
        }
        // A restarted worker numbers its requests from 1 again (claim:1,
        // release:1): a duplicate is the same id from the same worker epoch.
        if (!this.remember(`${epoch}:${message.msgId}`)) {
            DiagnosticConfig.developerDiagnostics && (this.counters.duplicateMessages += 1);
            return;
        }
        DiagnosticConfig.developerDiagnostics && (this.counters.messagesIn += 1);
        DiagnosticConfig.developerDiagnostics && (this.counters.bytesIn += valid.bytes);
        const payload = message.payload || {};
        switch (message.type) {
        case 'economy_route_result':
            if (!this.stopping) this.economyRoutes.accept(payload);
            break;
        case 'lease_renewal_candidates':
            await this.handleLeaseRenewalCandidates(message, worker, epoch);
            break;
        case 'ready':
            if (payload.phase === 'loaded') {
                this.sendPlanningCatalog();
                this.post('init', { config: this.workerConfig(), catalogVersion: utils.buildNumber() });
                try {
                    this.attachTableChannel();
                } catch (error) {
                    // Native source setup failed; use the existing Worker exit
                    // path rather than leave a running child without its feed.
                    this.onWorkerError(error);
                    worker.terminate?.()?.catch(failure => this.recordError(failure));
                }
            } else if (payload.phase === 'running') {
                this.ready = true;
                this.syncWorkerPressure();
                if (this.pauseReasons.size) this.post('pause', { reasons: [...this.pauseReasons] });
                await this.sendSnapshots(true);
            } else if (payload.phase === 'snapshots_loaded') {
                this.snapshotsLoaded = true;
                this.lastWorkerSnapshot = payload;
                utils.infoSuccess('ColdWorker', 'ready states=%d queueHead=%s', Number(payload.states || 0), payload.queueHead?.kind || 'unknown');
            } else if (payload.phase === 'state_loaded') {
                const waiter = this.waiters.get(message.msgId);
                if (waiter) {
                    this.waiters.delete(message.msgId);
                    waiter.resolve(payload);
                }
            } else if (payload.phase === 'economy_decided' && !this.stopping) {
                const id = Number(payload.characterId), state = LifeState.cachedState(id);
                const decision = payload.economyDecision ? require('./ColdEconomyDecision').compact(payload.economyDecision) : null;
                // Same worker generation plus the exact captured owner facts
                // fence hot publications; they never authorize native spending.
                if (state?.phase === 'hot' && decision && decision.updatedAt === Number(state.updatedAt || 0)
                    && decision.key === require('./ColdEconomyDecision').stateKey(state)) {
                    this.economyDecisions.accept(id, decision);
                    if (decision.feasibility) invoke('GameServer/Bot/Economy/HotBoardReviewService').preparedOwner(id);
                }
            } else if (payload.phase === 'economy_workshop_stale' && !this.stopping) {
                this.economyDecisions.staleWorkshop(Number(payload.characterId),
                    { updatedAt: Number(payload.updatedAt), key: payload.key });
            }
            break;
        case 'claim_request':
            // A claim writes SQLite; a busy database must not become an
            // unhandled rejection, which ends the process. Release already
            // tolerates it. The worker times out a lost claim acknowledgement
            // and queues the bot again.
            await this.handleClaimRequest(message).catch((error) => this.recordError(error));
            break;
        case 'proposal_batch':
            this.handleProposalBatch(message, worker, epoch);
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
            this.handleCommandRequest(message, worker, epoch);
            break;
        case 'heartbeat':
            this.lastHeartbeatAt = Date.now();
            this.lastWorkerSnapshot = payload;
            if (!this.stopping) Metrics.recordColdSafetyTotals(epoch, payload.safety);
            this.handleCompetitionForecast(payload.competition, worker, epoch);
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
        case 'table_resync':
            this.tableChannel.resync(this, message.workerEpoch, payload.names || []);
            break;
        case 'fault':
            DiagnosticConfig.developerDiagnostics && (this.counters.workerErrors += 1);
            utils.infoWarn('ColdWorker', 'worker fault: %s%s', payload.reason || 'unknown', payload.stack ? `\n${payload.stack}` : '');
            break;
        default:
            break;
        }
    }

    // A new worker epoch gets every table in full; later flushes send changes.
    attachTableChannel() {
        if (this.stopping) return;
        // ARCH-NOTE: no cold worker code reads hot actors. Keep its actor
        // recipient detached until a concrete worker reader needs this stream.
        const worker = this.worker;
        const epoch = this.workerEpoch;
        this.tableChannel.attach(this, epoch, (payload, payloadBytes) => {
            if (this.stopping || this.worker !== worker || this.workerEpoch !== epoch) return false;
            const bytes = Protocol.envelopeBytes(Protocol.envelope('table_page', epoch, {}), payloadBytes) + 256;
            return !!this.post('table_page', payload, null, bytes);
        });
    }

    workerConfig() {
        return {
            developerDiagnostics: Config.developerDiagnostics === true,
            ...(Config.developerDiagnostics && Config.economyDiagnostics ? { economyDiagnostics: true, economyDiagnosticsBotIds: Config.economyDiagnosticsBotIds } : {}),
            coldHonestTravel: Config.coldHonestTravel,
            pvpAggression: Config.pvpAggression,
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
            priorityClanIds: [...new Set((options.priorityClanIds || []).map(Number).filter(id => id > 0))].slice(0, 64),
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
            // Count each row once, as sendIncrementalEntries does, instead of
            // serialising every growing page prefix; post() trusts the count.
            const baseBytes = Protocol.byteLength(Protocol.envelope('catalog_page', this.workerEpoch, {
                catalog, rows: [], done: false
            })) + 256;
            let page = [];
            let pageBytes = baseBytes;
            const flush = (done = false) => {
                if (!page.length && !done) return;
                this.post('catalog_page', { catalog, rows: page, done }, null, pageBytes);
                page = [];
                pageBytes = baseBytes;
            };
            for (const row of rows) {
                const rowBytes = Protocol.byteLength([row]) - 2;
                if (page.length && pageBytes + rowBytes + 1 > PAGE_BYTES) flush(false);
                pageBytes += rowBytes + (page.length ? 1 : 0);
                page.push(row);
                if (page.length >= Protocol.MAX_BATCH) flush(false);
            }
            flush(true);
        });
    }

    contextIndex(options = {}) {
        let profiles = [];
        try { profiles = SpotProfiles.ensure() || []; } catch (_) { profiles = []; }
        // Every context of one spot catalog reads the same id table.
        const spots = SpotIndex.tableFor(profiles);
        const parties = new Map((BackgroundPartyState.active?.() || []).map((party) => [Number(party.leaderId || 0), party]));
        let occupancy = {};
        try { occupancy = SpotProfiles.currentOccupancy(profiles) || {}; } catch (_) { occupancy = {}; }
        return {
            spots,
            profiles,
            occupancy,
            parties,
            partyGeneration: BackgroundPartyState.generation(),
            compactPartyMembers: options.compactPartyMembers === true,
            compactPartyMemberIds: options.compactPartyMemberIds instanceof Set
                ? options.compactPartyMemberIds
                : null
        };
    }

    routeFor(state, currentSpot, party, partyMembers, index) {
        if (!state || state.phase !== 'cold' || state.stats?.travel) return null;
        if (!party && require('./ClanPartyDuty').waiting(state)) return null;
        const partyRoute = !!party;
        const eligibleActivity = state.activity === 'hunting'
            || (partyRoute && state.activity === 'grouped');
        if (!eligibleActivity) return null;
        if (partyRoute && partyMembers.some((member) => ['resting', 'traveling', 'dead'].includes(member.activity))) return null;

        let physical = null;
        try { physical = SpotService.findCurrentSpot(state.loc); } catch (_) { physical = null; }
        // Virtual raid profiles share the ordinary world grid with their
        // surrounding field. Once the party has arrived, its persisted raid
        // spot is the semantic destination; preferring the grid id here would
        // schedule another 25-second trip to the same coordinates forever.
        const declaredSpotId = party?.spotId || state.spotId || null;
        const declaredSpot = declaredSpotId
            ? index.spots?.get?.(String(declaredSpotId)) || SpotProfiles.findById(declaredSpotId)
            : null;
        const currentId = declaredSpot?.raidBoss === true
            ? declaredSpot.id
            : physical?.id || currentSpot?.id || declaredSpotId;
        const timestamp = Number(index.timestamp || Date.now());
        const routedMembers = partyRoute ? partyMembers : [state];
        const partyRisk = require('./PartySpotRiskPolicy');
        const excludedSpotIds = partyRoute ? partyRisk.excludedSpotIds(party, timestamp)
            : SpotRiskPolicy.excludedSpotIdsForStates(routedMembers, timestamp);
        const spotBackoff = partyRoute ? partyRisk.backoff(party, currentId, timestamp)
            : SpotRiskPolicy.backoffForStates(routedMembers, currentId, timestamp);

        const role = partyRoute ? PartyComposition.roleForState(state) : null;
        let fallbackSpot = null;
        if (!partyRoute && PartyWaitFallback.waiting(state, state.stats?.equipmentPlan, state.stats?.partyRequest)) {
            try {
                fallbackSpot = PartyWaitFallback.spotFor(
                    state,
                    state.stats?.equipmentPlan,
                    // Preserve catalog identity for the planner's source-index cache.
                    index.profiles || [...index.spots.values()],
                    { occupancy: index.occupancy, excludedSpotIds, timestamp }
                )?.spot || null;
            } catch (_) { fallbackSpot = null; }
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
        // Solo checks and a non-party search all judge this bot, as the only
        // capacity state, at this timestamp. Its combat profiles depend on the
        // bot, not the spot: build them once for the decision.
        let soloProfiles = null;
        const soloOptions = () => {
            soloProfiles = soloProfiles || invoke('GameServer/Bot/AI/BotTargetMatchup')
                .stateProfiles(state, { ...options, mode: 'solo' });
            return { ...options, mode: 'solo', matchupProfiles: soloProfiles };
        };
        const unsafeSoloGround = !partyRoute && currentGround
            && !LevelingRoutes.isSpotAllowedForState(currentGround, state, soloOptions());
        const leaf = partyRoute ? null : index.wishLeaf !== undefined ? index.wishLeaf
            : this.economyDecisions.activity(state);
        const wished = leaf?.activity === 'hunting' && leaf.spotId
            ? index.spots.get(String(leaf.spotId)) : null;
        const wishDestination = wished && wished.raidBoss !== true
            && !excludedSpotIds.has(String(wished.id))
            && LevelingRoutes.isSpotAllowedForState(wished, state, soloOptions())
            && SpotService.isSuitable(wished, Number(state.level || 1), options)
            && SpotProfiles.hasCapacityForStates(wished, routedMembers, index.occupancy) ? wished : null;
        const sharedSpot = party?.stats?.objective?.spotId;
        let selected = partyRoute && sharedSpot && !excludedSpotIds.has(String(sharedSpot))
            ? index.spots.get(String(sharedSpot)) || null : wishDestination || fallbackSpot;
        try {
            // A party-mode search of a lone member builds no profiles at all.
            if (!selected) selected = SpotProfiles.findForState(routeState, !partyRoute
                && LevelingRoutes.modeForState(routeState, options) !== 'party'
                ? { ...options, matchupProfiles: soloOptions().matchupProfiles }
                : options);
        } catch (_) { selected = null; }
        if (unsafeSoloGround && selected) {
            const repeatsCurrentGround = String(selected.id || '') === String(currentId || '');
            const destinationSafeForSolo = LevelingRoutes.isSpotAllowedForState(
                selected,
                state,
                soloOptions()
            );
            if (repeatsCurrentGround || !destinationSafeForSolo) selected = null;
        }
        if (!selected && unsafeSoloGround) {
            // Normal routing respects destination capacity. If every suitable
            // field is full, that can leave a detached party member polling a
            // blocked dungeon forever. Only for this rare safety evacuation,
            // choose the least-bad allowed field and let admission exceed its
            // soft capacity by one.
            const emergencyOptions = soloOptions();
            const candidatesWithRoom = (index.profiles || [...index.spots.values()])
                .filter((profile) => profile.raidBoss !== true)
                .filter((profile) => String(profile.id) !== String(currentId || ''))
                .filter((profile) => !excludedSpotIds.has(String(profile.id)))
                .filter((profile) => (
                    Number(profile.minLevel || 1) <= Number(state.level || 1) + 4
                    && Number(profile.maxLevel || profile.minLevel || 1) >= Number(state.level || 1) - 4
                ))
                .filter((profile) => SpotProfiles.hasCapacityForStates(
                    profile,
                    routedMembers,
                    index.occupancy,
                    { maxOverflowUnits: 1 }
                ));
            const emergencyCandidates = candidatesWithRoom.filter((profile) => (
                LevelingRoutes.isSpotAllowedForState(profile, state, emergencyOptions)
            ));
            const suitable = emergencyCandidates.filter((profile) => (
                SpotService.isSuitable(profile, Number(state.level || 1), options)
            ));
            selected = emergencyCandidates.length ? LevelingRoutes.bestSpot(
                suitable.length ? suitable : emergencyCandidates,
                state,
                emergencyOptions
            )?.spot || null : null;
        }
        if (!selected) return null;

        const repairingPartyPosition = partyRoute && String(selected.id) === String(party.spotId || '')
            && partyMembers.every(member => member.phase === 'cold' && member.vitals?.hp > 0
                && !member.stats?.pvpEncounter && !member.stats?.travel)
            && (!require('./PartyHuntingAssembly').nearby(partyMembers)
                || partyMembers.some(member => !SpotService.containsLocation(selected, member.loc)));
        if (String(selected.id) === String(currentId || '') && !repairingPartyPosition
            && (!partyRoute || String(party.spotId || '') === String(selected.id))) return null;

        // Coordinate repair may include teammates whose reservation is still
        // on another spot. Only bypass admission when every member is counted;
        // reserveCapacity adds missing members without counting existing ones twice.
        const reservedKeys = index.occupancy?.[selected.id]?.reservedKeys;
        const repairAlreadyReserved = repairingPartyPosition && reservedKeys instanceof Set
            && routedMembers.every(member => reservedKeys.has(String(member.characterId)));
        const reserved = repairAlreadyReserved || SpotProfiles.reserveCapacity(index.occupancy, selected, routedMembers, {
            maxOverflowUnits: unsafeSoloGround ? 1 : 0
        });
        if (!reserved) return null;

        const members = partyRoute ? partyMembers : [state];
        const destinations = partyRoute ? SpotService.arrivalPointsForParty(members, selected) : {};
        if (!destinations) return null;
        for (const member of partyRoute ? [] : members) {
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
            // The routed bot's trip time; a party's members all take it.
            travelMs: ColdTrip.spotTripMs(state, destinations[String(state.characterId)] || selected.center),
            reason: partyRoute
                ? 'party_spot_replan'
                : unsafeSoloGround ? 'unsafe_ground_evacuation'
                : spotBackoff ? 'death_pressure_replan'
                    : activeEquipmentPlan ? 'equipment_source_replan' : 'level_replan',
            ...(spotBackoff ? { cause: 'death_pressure', spotBackoff }
                : repairingPartyPosition ? { cause: 'position_mismatch' } : {}),
            to: destinations[String(state.characterId)] || null,
            destinations
        };
    }

    async ensureCraftRecipes(state) {
        if (invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(state)) {
            await require('../Economy/CraftWorkshopService').knownFor(state.characterId);
        }
    }

    contextFor(state, index = this.contextIndex()) {
        let physical = null;
        try { physical = SpotService.findCurrentSpot(state.loc); } catch (_) { physical = null; }
        const declared = index.spots.get(String(state.spotId || '')) || null;
        // A raid profile is virtual and sits inside an ordinary coordinate
        // sector. The party resolver needs the declared boss profile (HP,
        // drops, shared encounter key), not the surrounding leveling field.
        const spot = (declared?.raidBoss === true ? declared : null)
            || (physical && index.spots.get(String(physical.id)))
            || declared
            || null;
        let pressure = {};
        try { pressure = Director.pressureForState(state) || {}; } catch (_) { pressure = {}; }
        const party = index.parties.get(Number(state.characterId)) || null;
        const fullPartyMembers = party
            ? (party.memberIds || []).map((characterId) => LifeState.cachedState(characterId)).filter(Boolean) : [];
        const partyMembers = fullPartyMembers.map((member) => {
                const memberId = Number(member.characterId || 0);
                const compact = index.compactPartyMembers === true
                    || index.compactPartyMemberIds?.has(memberId);
                return compact ? compactPartyMemberContext(member) : member;
            });
        const interactionMemory = invoke('GameServer/Social/InteractionMemoryRuntime').snapshot(Number(state.characterId));
        const leaf = !party ? this.economyDecisions.activity(state) : null;
        const workshop = this.economyDecisions.workshopFor(state);
        const context = {
            // ARCH-NOTE: recipe DB rows are hydrated on main; the worker gets
            // <=8 numbers, never saved state or an extra recipe store.
            ...(invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(state)
                ? { knownShotRecipes: require('../Economy/ShotCraftPolicy').packKnown(
                    require('../Economy/CraftWorkshopService').cachedRecipes(state.characterId)) } : {}),
            ...(state.stats?.workshop?.entries?.length ? { workshop } : {}),
            spot: invoke('GameServer/RaidBoss/RaidEncounterScope').decorateSpot(spot),
            interactionMemory,
            clanHallServices: invoke('GameServer/ClanHall/ColdVisit').needed(state),
            pressure,
            goalReviewAt: Number(invoke('GameServer/Bot/Goals/GoalService').snapshot(state.characterId)?.current?.nextReviewAt || 0),
            // The worker cannot see AFK shops: hand it the Adena the bot's own
            // buy order holds, which still counts as purchase budget.
            buyOrderEscrow: invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(state.characterId),
            targetNpcId: party ? require('./PartyHuntingTarget').npcId(party, state)
                : leaf?.activity === 'hunting' ? (leaf.npcId || null) : null,
            isPartyLeader: !!party,
            party,
            partyMembers,
            requirementRefresh: !!party && this.population?.partyRequirementRefreshDue?.has(String(party.partyId)),
            route: this.routeFor(state, spot, party, fullPartyMembers, { ...index, memory: interactionMemory, wishLeaf: leaf })
        };
        this.projectionRetention.prepare(state, context, index.partyGeneration);
        return context;
    }

    snapshotEntry(state, index = this.contextIndex()) {
        return { state, context: this.contextFor(state, index) };
    }

    attachSafetyTransport() {
        if (!this.worker || !this.workerEpoch) return null;
        if (this.safetyTransport?.worker === this.worker && this.safetyTransport.epoch === this.workerEpoch
            && !this.safetyTransport.disposed) return this.safetyTransport;
        this.cancelSafety();
        this.safetyTransport = new ColdSafetyTransport({ worker: this.worker, epoch: this.workerEpoch,
            post: (type, payload, msgId) => this.post(type, payload, msgId),
            isCurrent: (worker, epoch) => this.worker === worker && this.workerEpoch === epoch
                && this.ready && this.snapshotsLoaded && !this.stopping,
            onTotals: (epoch, totals) => Metrics.recordColdSafetyTotals(epoch, totals),
            now: () => Date.now(), timeoutMs: Math.max(1000, Number(Config.coldOwnerResolveTimeoutMs) || 10000) });
        return this.safetyTransport;
    }

    safetyCurrent() {
        if (!this.worker || !this.workerEpoch || this.stopping) return null;
        this.attachSafetyTransport();
        return { worker: this.worker, epoch: this.workerEpoch, ready: this.ready && this.snapshotsLoaded };
    }

    safetyExcluded(characterId) {
        return !this.worker || !this.ready || !this.snapshotsLoaded || this.stopping || this.snapshotInFlightInitial
            || this.fencedBots.has(characterId) || this.commandInflight.has(characterId)
            || this.snapshotQueue.dirty.has(characterId);
    }

    canRepairSafety(checkpoint) {
        if (this.safetyExcluded(checkpoint?.characterId) || checkpoint?.phase !== 'cold') return false;
        const state = LifeState.cachedState(checkpoint.characterId);
        if (!state || !Protocol.sameSafetyCheckpoint(checkpoint, Protocol.safetyCheckpoint(state))) return false;
        const loc = state.stats?.craftShop?.loc || state.loc;
        if (![Number(loc?.locX), Number(loc?.locY)].every(Number.isFinite)
            || typeof this.population?.realPlayerSessionsNear !== 'function') return false;
        try { return !this.visibleToRealPlayer(state); } catch (_) { return false; }
    }

    requestSafety(kind, rows, expected) {
        const current = this.safetyCurrent();
        if (!current?.ready || current.worker !== expected?.worker || current.epoch !== expected?.epoch) {
            return Promise.resolve({ ok: false, results: [], reason: 'stale' });
        }
        return this.safetyTransport.request(kind, rows);
    }

    pollSafety(timestamp) {
        return this.safetyTransport?.pulse(timestamp) || false;
    }

    cancelSafety() {
        this.safetyTransport?.dispose();
        this.safetyTransport = null;
    }

    projectedEntryFor(characterId) {
        if (!this.worker || !this.ready || this.stopping || !this.snapshotsLoaded) {
            return { ok: false, reason: 'worker_not_ready' };
        }
        if (this.fencedBots.has(characterId) || this.commandInflight.has(characterId)) {
            return { ok: false, reason: 'projection_owner_busy' };
        }
        return this.projectionRetention.get(characterId);
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
        this.projectionRetention.invalidate(state);
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
        if (!this.post('snapshot_page', payload, null, options.bytes)) return false;
        DiagnosticConfig.developerDiagnostics && (this.counters.snapshotsSent += rows.length);
        DiagnosticConfig.developerDiagnostics && (this.counters.snapshotPages += 1);
        return true;
    }

    async sendIncrementalEntries(entries, index, pageSize, priority = null, deadlineAt = Infinity) {
        await invoke('GameServer/Social/InteractionMemoryRuntime').ensureMany(entries.map(entry => Number((entry.state || entry).characterId)));
        // Count each row once instead of serializing every growing page prefix.
        // post() checks the counted upper bound of the envelope against the limit.
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
            const bytes = pageBytes;
            page = [];
            pageBytes = baseBytes;
            if (!await this.sendSnapshotPage(rows, { initial: false, priority, bytes })) return false;
            rowsSent += rows.length;
            pagesSent += 1;
            DiagnosticConfig.developerDiagnostics && (this.counters.snapshotYields += 1);
            await yieldToLoop();
            return true;
        };

        for (const entry of entries) {
            if (rowsSent + page.length > 0 && Date.now() >= deadlineAt) break;
            await this.ensureCraftRecipes(entry.state || entry);
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
        invoke('GameServer/Clan/ClanSocialRuntime').send(this);
        await this.reconcileOrphanedBackgroundParties();
        // Re-read after reconciliation: releasing an invalid party updates
        // cached member ownership and membership. Sending the pre-repair
        // array would immediately seed the worker with the stale party again.
        const states = LifeState.everyState();
        const compactPartyMemberIds = new Set(states.map((state) => Number(state.characterId || 0)).filter(Boolean));
        const index = this.contextIndex({ compactPartyMemberIds });
        const pageSize = this.snapshotQueue.pageSize;
        const baseBytes = Protocol.byteLength(Protocol.envelope('snapshot_page', this.workerEpoch, {
            rows: [], done: false, initial: true
        })) + 256;
        let pageBytes = baseBytes;
        let page = [];
        let pendingPage = null;
        let pendingBytes = baseBytes;
        let rowsSent = 0;
        let pagesSent = 0;

        const emit = async (rows, done, bytes) => {
            if (!await this.sendSnapshotPage(rows, { done, initial: true, bytes })) return false;
            rowsSent += rows.length;
            pagesSent += 1;
            DiagnosticConfig.developerDiagnostics && (this.counters.snapshotYields += 1);
            await yieldToLoop();
            return true;
        };

        // A page of fresh routes can take most of a second on cold caches;
        // hand the loop back inside a page too, not only between pages.
        let sliceStartedAt = Date.now();
        for (let stateIndex = 0; stateIndex < states.length; stateIndex++) {
            if (Date.now() - sliceStartedAt >= SNAPSHOT_SLICE_MS) {
                DiagnosticConfig.developerDiagnostics && (this.counters.snapshotYields += 1);
                await yieldToLoop();
                sliceStartedAt = Date.now();
            }
            if (stateIndex % pageSize === 0) {
                await invoke('GameServer/Social/InteractionMemoryRuntime').ensureMany(
                    states.slice(stateIndex, stateIndex + pageSize).map(state => Number(state.characterId)));
            }
            const state = states[stateIndex];
            await this.ensureCraftRecipes(state);
            const row = this.snapshotEntry(state, index);
            const rowBytes = Protocol.byteLength([row]) - 2;
            const tooLarge = page.length > 0 && pageBytes + rowBytes + 1 > PAGE_BYTES;
            if (tooLarge || page.length >= pageSize) {
                if (pendingPage && !await emit(pendingPage, false, pendingBytes)) return { ok: false, rowsSent, pagesSent };
                pendingPage = page;
                pendingBytes = pageBytes;
                page = [];
                pageBytes = baseBytes;
            }
            pageBytes += rowBytes + (page.length ? 1 : 0);
            page.push(row);
        }
        if (page.length) {
            if (pendingPage && !await emit(pendingPage, false, pendingBytes)) return { ok: false, rowsSent, pagesSent };
            pendingPage = page;
            pendingBytes = pageBytes;
        }
        if (!pendingPage) pendingPage = [];
        if (!await emit(pendingPage, true, pendingBytes)) return { ok: false, rowsSent, pagesSent };
        return { ok: true, rowsSent, pagesSent };
    }

    async reconcileOrphanedBackgroundParties() {
        const statePartyId = (state) => state?.party?.partyId ?? state?.partyId ?? null;
        // Who claims each party, from one pass over every state, instead of
        // a pass over the states for every party.
        const attachedByParty = new Map();
        for (const state of LifeState.everyState()) {
            const partyId = String(statePartyId(state) || '');
            if (!partyId) continue;
            if (!attachedByParty.has(partyId)) attachedByParty.set(partyId, []);
            attachedByParty.get(partyId).push(Number(state.characterId));
        }
        const invalid = BackgroundPartyState.active().map((party) => {
            const memberIds = (party.memberIds || []).map((id) => Number(id)).filter(Boolean);
            const states = memberIds.map((id) => LifeState.cachedState(id)).filter(Boolean);
            const attached = states.filter((state) => (
                String(statePartyId(state) || '') === String(party.partyId)
            ));
            const leaderAttached = attached.some((state) => Number(state.characterId) === Number(party.leaderId));
            const declared = new Set(memberIds);
            const extraAttached = (attachedByParty.get(String(party.partyId)) || []).some((id) => !declared.has(id));
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
                Config.developerDiagnostics && console.info('ColdWorker :: dissolved invalid background party %s reason=%s declaredMembers=%d releasedMembers=%d',
                    party.partyId,
                    reason,
                    party.memberIds?.length || 0,
                    released);
            }
        }
        return invalid.map((entry) => entry.party);
    }

    startSnapshotJob(mode, work, pressure = {}) {
        const startedAt = Config.developerDiagnostics ? Date.now() : 0;
        this.snapshotInFlightInitial = mode === 'full';
        const job = (async () => {
            try {
                const result = await work();
                if (Config.developerDiagnostics) this.snapshotLast = {
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
                if (Config.developerDiagnostics) this.snapshotLast = {
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
                DiagnosticConfig.developerDiagnostics && (this.counters.snapshotCriticalRuns += 1);
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
        await invoke('GameServer/Clan/ClanSocialRuntime').refresh();
        await invoke('GameServer/Clan/ClanSocialRuntime').enforceOne(this);
        invoke('GameServer/Clan/ClanSocialRuntime').send(this);
        if (this.snapshotInFlight || this.criticalSnapshotInFlight) {
            this.snapshotRefreshPending = true;
            return false;
        }
        if (initial) {
            DiagnosticConfig.developerDiagnostics && (this.counters.snapshotFullRuns += 1);
            return this.startSnapshotJob('full', () => this.sendFullSnapshot());
        }

        if (!this.snapshotQueue.size()) return false;
        const pressure = this.snapshotPressure();
        const plan = this.snapshotQueue.takeNormal(pressure);
        if (plan.deferred) {
            DiagnosticConfig.developerDiagnostics && (this.counters.snapshotDeferrals += 1);
            if (Config.developerDiagnostics) this.snapshotLast = {
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

        DiagnosticConfig.developerDiagnostics && (this.counters.snapshotDirtyRuns += 1);
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
        await this.ensureCraftRecipes(state);
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
            const purpose = candidate.purpose || null;
            purposes.set(Number(candidate.characterId), purpose);
            const state = LifeState.cachedState(candidate.characterId);
            if (!state) {
                missing.push({ ok: false, characterId: Number(candidate.characterId), reason: 'missing_state' });
                continue;
            }
            const partyId = String(purpose?.partyId || state.party?.partyId || state.partyId || '');
            if (partyId && invoke('GameServer/Bot/Population/HotPartyLifecycle').pending.has(partyId)) {
                Metrics.recordColdOwnerRejected('party_hot_transition');
                missing.push({
                    ok: false,
                    characterId: Number(candidate.characterId),
                    reason: 'party_hot_transition',
                    retryAfterMs: Math.max(1000, Number(Config.phasePolicyIntervalMs) || 10000)
                });
                continue;
            }
            if (this.visibleToRealPlayer(state)) {
                Metrics.recordColdOwnerRejected('visible_to_player');
                missing.push({
                    ok: false,
                    characterId: Number(candidate.characterId),
                    reason: 'visible_to_player',
                    retryAfterMs: Math.max(1000, Number(Config.phasePolicyIntervalMs) || 10000)
                });
                continue;
            }
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

    visibleToRealPlayer(state) {
        if (!state || ['pk_hunting', 'traveling'].includes(state.activity) || state.stats?.supplyErrand) return false;
        const candidateLoc = state.stats?.craftShop?.loc || state.loc;
        if (!candidateLoc) return false;
        const queryLoc = { locX: Number(candidateLoc.locX), locY: Number(candidateLoc.locY), locZ: Number(candidateLoc.locZ) };
        if (![queryLoc.locX, queryLoc.locY].every(Number.isFinite)) return false;
        // The index searches XY; the original candidate still reaches the
        // floor policy, including its missing-height fallback.
        if (!Number.isFinite(queryLoc.locZ)) queryLoc.locZ = 0;
        const radius = Math.max(1, Number(Config.activationRadius) || 9000);
        const players = this.population?.realPlayerSessionsNear?.(queryLoc, radius) || [];
        if (!players.length) return false;
        const floor = invoke('GameServer/Bot/Population/FloorAwareActivationPolicy');
        return players.some((playerSession) => {
            const actor = playerSession?.actor;
            if (!actor) return false;
            const playerLoc = {
                locX: Number(actor.fetchLocX?.()),
                locY: Number(actor.fetchLocY?.()),
                locZ: Number(actor.fetchLocZ?.())
            };
            if (![playerLoc.locX, playerLoc.locY, playerLoc.locZ].every(Number.isFinite)) return false;
            const dx = Number(candidateLoc.locX) - playerLoc.locX;
            const dy = Number(candidateLoc.locY) - playerLoc.locY;
            if (!Number.isFinite(dx) || !Number.isFinite(dy) || dx * dx + dy * dy > radius * radius) return false;
            return floor.evaluateCandidate(state, {
                playerLoc,
                candidateLoc,
                reason: 'near_player'
            }).accepted === true;
        });
    }

    handleProposalBatch(message, worker = this.worker, epoch = this.workerEpoch) {
        if (message.payload.capacityBlocked === true) this.queue.capacityBlocked = true;
        const rejected = [];
        const sizes = message.payload.proposalBytes;
        const source = Object.freeze({ worker, epoch });
        (message.payload.proposals || []).forEach((proposal, index) => {
            proposal[PROPOSAL_SOURCE] = source;
            const tokenValid = Protocol.validateToken(proposal.token);
            if (!tokenValid.ok || Number(proposal.characterId) !== Number(proposal.token?.characterId)) {
                rejected.push({ ok: false, characterId: Number(proposal.characterId || 0), reason: tokenValid.reason || 'token_character', proposal });
                return;
            }
            const queued = this.queue.enqueue(proposal, Array.isArray(sizes) ? sizes[index] : null);
            if (!queued.ok) rejected.push({ ok: false, characterId: proposal.characterId, reason: queued.reason, proposal });
            else Metrics.recordColdOwnerResolved();
        });
        if (rejected.length) this.handleCommitResults(rejected).catch((error) => this.recordError(error));
    }

    async prepareProposal(proposal) {
        if (proposal.atomicGroup?.raidCommit) {
            if (!require('./ColdRaidAuthority').prepare(proposal.atomicGroup.raidCommit)) return null;
        }
        const state = LifeState.cachedState(proposal.characterId) || proposal.baseState;
        if (!state) return null;
        if (Number(state.stats?.clanId) > 0) proposal[CLAN_BEFORE] = { level: state.level, inventory: state.inventory };
        const partyId = String(state.party?.partyId || state.partyId || '');
        if ((partyId && invoke('GameServer/Bot/Population/HotPartyLifecycle').pending.has(partyId))
            || this.visibleToRealPlayer(state)) return null;
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
        // The worker's fight has already happened: a forced cleanup trip
        // starts from the state after it, so its exp, adena and loot stay.
        const resolvedState = proposal?.nextState || (proposal.result
            ? await LifeState.prepareResolve(claimedState, proposal.result, { persist: false, timestamp })
            : null);
        if (!resolvedState) return null;
        // The worker recorded this hunt's income: the main thread's level-band
        // table (the hour value of bots without a sample) learns it here.
        HuntEfficiency.observe(resolvedState);
        // An atomic group commits all members or none: as before, its cleanup
        // is decided on the claimed state, so a member its party releases in
        // this commit does not fail the whole group.
        const cleanupState = this.population?.prepareInventoryCleanupProposal?.(
            proposal.atomicGroup ? claimedState : resolvedState,
            timestamp,
            claimedState.simulation,
            claimedState
        );
        if (cleanupState) {
            if (proposal.atomicGroup) return null;
            proposal.inventoryCleanupForced = true;
            delete cleanupState.cleanup;
            return cleanupState;
        }
        if (!proposal?.nextState) return resolvedState;
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
        if (admission.checked && !admission.admitted) DiagnosticConfig.developerDiagnostics && (this.counters.routeCapacityRejects += 1);
        return admission.state;
    }

    async step(name, characterId, work) {
        try { return await work(); }
        catch (error) {
            DiagnosticConfig.developerDiagnostics && (this.counters.afterCommitStepErrors[name] += 1);
            utils.infoWarn('ColdWorker', 'postcommit %s failed for %s: %s', name, characterId, error?.message || error);
            return undefined;
        }
    }

    async afterCommit(entry, committed = {}) {
        if (Config.developerDiagnostics === true) require('../Economy/ConsumptionDiagnostics').publish(
            entry.nextState.characterId, entry.proposal.result?.consumptionDiagnostics, {
                source: 'cold_commit', commandId: entry.proposal.commandId,
                revision: entry.proposal.token?.revision, sequence: entry.proposal.sequence
            });
        const id = entry.nextState.characterId;
        const source = entry.proposal[PROPOSAL_SOURCE];
        const sourceCurrent = () => !this.stopping && (!source || source.worker === this.worker && source.epoch === this.workerEpoch);
        const beforeWrite = () => {
            if (!sourceCurrent()) throw Error('cold_postcommit_source_retired');
        };
        const committedPartyRow = committed.partyRow || committed.raidPartyRow;
        await this.step('partyCache', id, () => {
            if (committedPartyRow && Number(BackgroundPartyState.find(committedPartyRow.partyId)?.updatedAt || 0)
                < Number(committedPartyRow.updatedAt)) BackgroundPartyState.acceptRow(committedPartyRow);
        });
        await this.step('raidCache', id, () => {
            if (committed.raidRow) require('./ColdRaidAuthority').accept(committed.raidRow);
        });
        await this.step('raidSettlement', id, async () => {
            if (committed.raidPartyRow && entry.proposal.partyResolution?.party?.stats?.raidEncounter?.status === 'defeated') {
                await require('./ColdRaidWorldBridge').settle(entry.proposal.partyResolution.party, { respawnAt: committed.raidRespawnAt });
            }
        });
        let state = LifeState.cachedState(id) || entry.nextState;
        if (sourceCurrent()) await this.step('economyDecision', id,
            () => this.economyDecisions.accept(id, entry.proposal.economyDecision, committed));
        await this.step('journal', id, () => LifeEvents.recordMany(id, entry.proposal.result?.events || []));
        if (sourceCurrent() && entry.proposal.market) {
            // The resolve has already advanced native ownership. Capture its
            // accepted authority after commit, never the worker's old revision.
            const coldAuthority = { ownerId: state.simulation?.ownerId || 'legacy_main',
                revision: Number(state.simulation?.revision || 0), leaseId: state.simulation?.leaseId || null };
            const canCommitReview = () => {
                const current = LifeState.cachedState(id), actual = current?.simulation || {};
                return sourceCurrent() && current?.phase === 'cold'
                    && (actual.ownerId || 'legacy_main') === coldAuthority.ownerId
                    && Number(actual.revision || 0) === coldAuthority.revision
                    && (actual.leaseId || null) === coldAuthority.leaseId;
            };
            await this.step('board', id, () => invoke('GameServer/Bot/Economy/BotAfkMarketService')
                .applyReview(id, entry.proposal.market, { coldAuthority, canCommitReview }));
        }
        await this.step('equipment', id, () => LifeState.enqueueEquipmentGoalAdvanceForState(state));
        if (sourceCurrent() && entry.proposal.economyPlan) {
            const started = Config.developerDiagnostics ? performance.now() : 0;
            const decision = await this.step('improvement', id, () => this.economyDecisions.decided(state));
            // Native moves publish a new timestamp. Hold the worker's one
            // decision across this plan exactly as the town command does.
            this.economyDecisions.hold(id, decision);
            try {
                state = await this.step('improvement', id, () => this.reviewCommittedEconomy(state, beforeWrite, decision || null)) || state;
                const applied = await this.step('economyPlan', id, () => invoke('GameServer/Bot/Economy/BotAfkMarketService')
                    .executePlan(state, entry.proposal.economyPlan,
                        { beforeWrite, step: work => this.step('economyPlan', id, work) }));
                state = LifeState.cachedState(id) || applied?.state || state;
            } finally {
                this.economyDecisions.release(id);
                if (Config.developerDiagnostics) this.economyPlanCount++;
                if (Config.developerDiagnostics) this.economyPlanTimes.push(performance.now() - started);
                if (this.economyPlanTimes.length > 256) this.economyPlanTimes.shift();
            }
        }
        await this.step('clanEvents', id, () => require('../../Clan/ClanReviewEvents').committedMember(entry.proposal[CLAN_BEFORE], state));
        await this.step('party', id, async () => {
            if (entry.proposal.partyResolution?.party) {
                const party = entry.proposal.partyResolution.party;
                if (!committedPartyRow) await BackgroundPartyState.createOrUpdate(party);
                if (!committedPartyRow && party.stats?.raidEncounter?.status === 'defeated') {
                    await invoke('GameServer/Bot/Population/ColdRaidWorldBridge').settle(party)
                        .catch((error) => utils.infoWarn('RaidBoss', 'cold raid settlement failed for %s: %s',
                            party.partyId, error?.message || error));
                }
                if (party.stats?.raidEncounter?.status === 'failed') {
                    await invoke('GameServer/Clan/ClanEquipmentService').recordRaidFailure(party)
                        .catch((error) => utils.infoWarn('RaidBoss', 'raid failure planning failed for %s: %s',
                            party.partyId, error?.message || error));
                }
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
        });
        if (entry.proposal.partyResolution?.party && this.population?.applyWorkerPartyRequirements) {
            await this.step('partyPlans', id, () => this.population.applyWorkerPartyRequirements(
                BackgroundPartyState.find(entry.proposal.partyResolution.partyId) || entry.proposal.partyResolution.party,
                entry.proposal.partyResolution));
        }
        if (entry.proposal.buffOffer) {
            await this.step('buff', id, () => invoke('GameServer/Bot/Economy/ColdBuffService')
                .applyOffer(entry.proposal.buffOffer, { beforeWrite }));
        }
        if (Config.developerDiagnostics) await this.step('metrics', id, () => {
            Metrics.recordBackgroundResolve();
            Metrics.recordCombat(entry.proposal.result?.debug);
            Metrics.recordResolveDuration(Math.max(0, Date.now() - Number(entry.proposal.enqueuedAt || Date.now())));
        });
        await this.step('announce', id, () => GlobalChat.maybeAnnounce(state, entry.proposal.result?.events || []));
        return state;
    }

    async reviewCommittedEconomy(state, beforeWrite, decisionOverride) {
        // The native commit has released its lease before these actions.
        // Each action validates the current row again inside its writer.
        state = LifeState.cachedState(state.characterId) || state;
        const decision = decisionOverride === undefined
            ? await this.step('improvement', state.characterId, () => this.economyDecisions.decided(state)) : decisionOverride;
        state = await this.step('training', state.characterId, () => LifeState.reviewTrainingAfterCommit(state, { beforeWrite }))
            || LifeState.cachedState(state.characterId) || state;
        const improved = await this.step('improvement', state.characterId, () => invoke('GameServer/Bot/Economy/BotImprovementService')
            .reviewCold(state, { beforeWrite, decide: () => decision }));
        return improved?.state || LifeState.cachedState(state.characterId) || state;
    }

    async handleCommitResults(results = []) {
        const worker = this.worker, epoch = this.workerEpoch;
        results = results.filter(result => {
            const source = result.proposal?.[PROPOSAL_SOURCE];
            return !source || (source.worker === worker && source.epoch === epoch);
        });
        if (!results.length) {
            this.tableChannel.flush();
            return;
        }
        const releaseTokens = results.filter((result) => !result.ok && result.proposal?.token).map((result) => result.proposal.token);
        if (releaseTokens.length) await ColdSimulationOwner.releaseBatch(releaseTokens, { releaseInvalidated: true }).catch(() => []);
        if (this.worker !== worker || this.workerEpoch !== epoch) {
            this.tableChannel.flush();
            return;
        }
        const index = this.contextIndex({ compactPartyMembers: true });
        for (const result of results) {
            const state = LifeState.cachedState(result.characterId) || result.nextState;
            if (state) await this.step('economyPlan', result.characterId, () => this.ensureCraftRecipes(state));
        }
        if (this.worker !== worker || this.workerEpoch !== epoch) {
            this.tableChannel.flush();
            return;
        }
        const acknowledgements = results.flatMap((result) => {
            const inputToken = Protocol.leaseRenewalToken(result.proposal?.token);
            const proposalId = result.proposal?.proposalId;
            if (!inputToken || inputToken.characterId !== Number(result.characterId)
                || typeof proposalId !== 'string' || !proposalId || proposalId.length > 240) return [];
            const state = LifeState.cachedState(result.characterId) || result.nextState || result.proposal?.baseState || null;
            return [{
                ok: !!result.ok,
                characterId: Number(result.characterId),
                inputToken,
                proposalId,
                reason: result.reason || (result.ok ? 'committed' : 'rejected'),
                revision: result.revision,
                raidStepId: result.proposal?.raidStepId,
                state,
                context: state ? this.contextFor(state, index) : {}
            }];
        });
        // Table changes reach the worker before the commits that made them.
        this.tableChannel.flush();
        this.postCollections('commit_ack', { results: acknowledgements });
    }

    async handleReleaseRequest(message) {
        const worker = this.worker, epoch = this.workerEpoch;
        const tokens = (message.payload.releases || []).map((entry) => entry.token).filter(Boolean);
        const original = new Map();
        for (const token of tokens) {
            const inputToken = Protocol.leaseRenewalToken(token);
            if (!inputToken) continue;
            // Ambiguous repeated ids cannot identify an original request.
            original.set(inputToken.characterId, original.has(inputToken.characterId) ? null : inputToken);
        }
        const released = await ColdSimulationOwner.releaseBatch(tokens, { releaseInvalidated: true }).catch(() => []);
        if (this.worker !== worker || this.workerEpoch !== epoch) return;
        const index = this.contextIndex({ compactPartyMembers: true });
        const results = released.flatMap((result) => {
            const inputToken = original.get(Number(result.characterId));
            if (!inputToken) return [];
            const state = LifeState.cachedState(result.characterId);
            return [{ ...result, inputToken, releaseRequestId: message.msgId,
                state, context: state ? this.contextFor(state, index) : {} }];
        });
        this.postCollections('release_ack', { results }, message.msgId);
    }

    handleCommandRequest(message, worker = this.worker, epoch = this.workerEpoch) {
        const sourceCurrent = () => this.worker === worker && this.workerEpoch === epoch;
        const requests = (message.payload.requests || []).flatMap((request) => {
            const parsed = Protocol.commandIdentity(request);
            const identity = parsed && { characterId: parsed.characterId, commandId: parsed.commandId,
                commandCheckpoint: parsed.checkpoint };
            if (!identity || request.kind !== 'lifecycle'
                || !Protocol.sameCommandCheckpoint(identity.commandCheckpoint, request.state)) return [];
            return [{ request, identity }];
        });
        this.commandTail = this.commandTail.then(async () => {
            if (!sourceCurrent()) return;
            const results = [];
            for (const { request, identity } of requests) {
                if (!sourceCurrent()) return;
                DiagnosticConfig.developerDiagnostics && (this.counters.commands += 1);
                try {
                    const state = LifeState.cachedState(request.characterId);
                    const id = identity.characterId;
                    Metrics.recordColdOwnerLegacyDeferred(`command_${String(state?.activity || 'unknown')}`);
                    if (this.fencedBots.has(id) || state?.phase !== 'cold') {
                        results.push({ ...identity, ok: false, reason: 'hot_handoff_fenced',
                            ...(state ? { state } : {}) });
                        continue;
                    }
                    if (!Protocol.sameCommandCheckpoint(identity.commandCheckpoint, state)) {
                        results.push({ ...identity, ok: false, reason: 'stale_command', retryAfterMs: 1000,
                            state, context: this.contextFor(state, this.contextIndex({ compactPartyMembers: true })) });
                        continue;
                    }
                    let result;
                    const operation = this.executeLifecycleCommand(request, identity, sourceCurrent);
                    this.commandInflight.set(id, operation);
                    try { result = await operation; } finally {
                        if (this.commandInflight.get(id) === operation) this.commandInflight.delete(id);
                    }
                    if (!sourceCurrent()) return;
                    const nextState = LifeState.cachedState(request.characterId) || result?.state;
                    results.push({
                        ...identity,
                        ok: result?.ok !== false,
                        reason: result?.reason || (result?.ok === false ? 'command_rejected' : 'command_applied'),
                        ...(result?.ok === false ? { retryAfterMs: Math.max(1000,
                            Number(result.retryAfterMs) || (result.reason === 'missing_spot' ? 30000 : 5000)) } : {}),
                        ...(nextState ? { state: nextState } : {}),
                        context: nextState ? this.contextFor(nextState, this.contextIndex({ compactPartyMembers: true })) : {}
                    });
                } catch (error) {
                    if (!sourceCurrent()) return;
                    DiagnosticConfig.developerDiagnostics && (this.counters.commandErrors += 1);
                    const state = LifeState.cachedState(request.characterId);
                    results.push({ ...identity, ok: false, reason: error?.message || 'command_error', retryAfterMs: 5000,
                        ...(state ? { state } : {}) });
                }
                await new Promise((resolve) => setImmediate(resolve));
            }
            if (!sourceCurrent()) return;
            this.postCollections('command_ack', { results }, message.msgId);
        }).catch((error) => { if (sourceCurrent()) this.recordError(error); });
    }

    async executeLifecycleCommand(request, identity, sourceCurrent) {
        // A previous native writer can hold the character beyond the worker
        // lifetime. Own this entire promise and admit the computation only
        // after the existing writer has settled against the current cache.
        await LifeState.settleWrites([identity.characterId]);
        if (!sourceCurrent()) return { ok: false, reason: 'stale_worker_source' };
        const state = LifeState.cachedState(identity.characterId);
        const refusal = reason => ({ ok: false, reason, retryAfterMs: 1000, ...(state ? { state } : {}) });
        if (this.stopping) return refusal('coordinator_stopping');
        if (!state) return refusal('missing_state');
        if (this.fencedBots.has(identity.characterId) || state.phase !== 'cold') return refusal('hot_handoff_fenced');
        if (!Protocol.sameCommandCheckpoint(identity.commandCheckpoint, state)) return refusal('stale_command');
        const owned = this.commandInflight.get(identity.characterId);
        if (!(owned instanceof Promise)) return refusal('stale_command');
        const checkpoint = Object.freeze({ ...Protocol.commandCheckpoint(identity.commandCheckpoint) });
        const workerAdmission = Object.freeze({
            characterId: identity.characterId, commandId: identity.commandId, commandCheckpoint: checkpoint,
            check: () => {
                if (!sourceCurrent()) return { reason: 'stale_worker_source' };
                if (this.stopping) return { reason: 'coordinator_stopping' };
                if (this.commandInflight.get(identity.characterId) !== owned) return { reason: 'stale_command' };
                const latest = LifeState.cachedState(identity.characterId);
                if (!latest) return { reason: 'missing_state' };
                if (this.fencedBots.has(identity.characterId) || latest.phase !== 'cold') {
                    return { reason: 'hot_handoff_fenced' };
                }
                return Protocol.sameCommandCheckpoint(checkpoint, latest) ? null : { reason: 'stale_command' };
            }
        });
        const result = await this.population?.executeWorkerLifecycleCommand?.(state, request, { workerAdmission });
        if (result?.ok && sourceCurrent() && !this.stopping) {
            const current = LifeState.cachedState(identity.characterId);
            if (current) result.state = await this.step('improvement', identity.characterId, () => this.reviewCommittedEconomy(current, () => {
                if (!sourceCurrent() || this.stopping) throw Error('cold_postcommit_source_retired');
            })) || current;
        }
        return result;
    }

    async fenceBot(characterId, timeoutMs = 500) {
        const id = Number(characterId);
        this.economyDecisions.forget(id);
        invoke('GameServer/Bot/Economy/EconomyContext').forget(id);
        if (!this.worker || !this.ready) return { ok: true, reason: 'worker_not_ready' };
        this.fencedBots.add(id);
        this.economyRoutes.forget(id);
        DiagnosticConfig.developerDiagnostics && (this.counters.fences += 1);
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
            DiagnosticConfig.developerDiagnostics && (this.counters.fenceTimeouts += 1);
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

    currentLeaseRenewalRound(round) {
        return !!round && this.leaseRenewalRound === round && !round.cancelled
            && this.worker === round.worker && this.workerEpoch === round.epoch
            && this.ready && this.snapshotsLoaded && !this.stopping && Date.now() < round.replyBy;
    }

    canRenewLease(round, token) {
        if (!this.currentLeaseRenewalRound(round) || this.fencedBots.has(token.characterId)
            || this.commandInflight.has(token.characterId)) return false;
        const cached = LifeState.cachedState(token.characterId), current = cached?.simulation;
        return cached?.phase === 'cold' && current?.ownerId === token.ownerId
            && current.revision === token.revision && current.leaseId === token.leaseId;
    }

    cancelLeaseRenewalRound(round = this.leaseRenewalRound) {
        if (!round) return;
        round.cancelled = true;
        if (this.leaseRenewalRound === round) this.leaseRenewalRound = null;
        // Actual native work retains its exclusion token until finally. A
        // replacement worker must not overlap the old character flush/SQL.
    }

    beginLeaseRenewalRound() {
        const previous = this.leaseRenewalRound;
        if (previous && !this.currentLeaseRenewalRound(previous)) this.cancelLeaseRenewalRound(previous);
        if (this.leaseRenewalRound || this.leaseRenewalInFlight || !this.worker || !this.ready
            || !this.snapshotsLoaded || this.stopping) return false;
        const round = {
            worker: this.worker, epoch: this.workerEpoch, msgId: randomUUID(),
            replyBy: Date.now() + Math.max(1000, Math.trunc(Number(Config.coldOwnerRenewalIntervalMs) || 5000)),
            nextPage: 0, pendingPages: 0, doneSeen: false, cancelled: false,
            ids: new Set(), tail: Promise.resolve()
        };
        this.leaseRenewalRound = round;
        try {
            if (this.post('lease_renewal_probe', { replyBy: round.replyBy }, round.msgId) === round.msgId) return true;
        } catch (error) { this.recordError(error); }
        this.cancelLeaseRenewalRound(round);
        return false;
    }

    handleLeaseRenewalCandidates(message, worker, epoch) {
        const round = this.leaseRenewalRound, payload = message.payload;
        if (!this.currentLeaseRenewalRound(round) || round.worker !== worker || round.epoch !== epoch
            || payload.requestId !== round.msgId || payload.pageIndex !== round.nextPage || round.doneSeen) return Promise.resolve(false);
        // The Kernel ownership window is at most 128 claims; each can hold a
        // partial batch of at most MAX_BATCH grants. This is not a bot catalog.
        if (round.ids.size + payload.tokens.length > 128 * Protocol.MAX_BATCH
            || (!payload.done && !payload.tokens.length)
            || payload.tokens.some(token => round.ids.has(token.characterId))) {
            this.cancelLeaseRenewalRound(round);
            return Promise.resolve(false);
        }
        // Reserve before awaiting: onMessage handlers can overlap while a
        // native character flush is pending. A final page still owns its work.
        round.nextPage += 1;
        payload.tokens.forEach(token => round.ids.add(token.characterId));
        round.pendingPages += 1;
        round.doneSeen = payload.done;
        const job = round.tail.then(async () => {
            if (!this.currentLeaseRenewalRound(round)) return false;
            const flight = { round, msgId: message.msgId };
            this.leaseRenewalInFlight = flight;
            try {
                const renewals = await ColdSimulationOwner.renewActiveLeases(payload.tokens, {
                    now: Date.now,
                    leaseMs: Math.max(2000, Math.trunc(Number(Config.coldOwnerLeaseMs) || 30000)),
                    canRenew: token => this.canRenewLease(round, token)
                });
                if (!this.currentLeaseRenewalRound(round)) return false;
                const accepted = renewals.filter(result => result.ok && this.canRenewLease(round, result));
                // Even an empty page needs its exact acknowledgement so the
                // worker can continue its bounded, backpressured iterator.
                return this.post('lease_renewal', { renewals: accepted }, message.msgId) === message.msgId;
            } finally {
                if (this.leaseRenewalInFlight === flight) this.leaseRenewalInFlight = null;
            }
        }).catch(error => {
            this.recordError(error);
            this.cancelLeaseRenewalRound(round);
            return false;
        }).finally(() => {
            round.pendingPages -= 1;
            if (!round.pendingPages && (round.doneSeen || !this.currentLeaseRenewalRound(round))) {
                this.cancelLeaseRenewalRound(round);
            }
        });
        round.tail = job;
        return job;
    }

    onWorkerError(error) {
        DiagnosticConfig.developerDiagnostics && (this.counters.workerErrors += 1);
        this.recordError(error);
    }

    onWorkerExit(code, worker = this.worker, epoch = this.workerEpoch) {
        if (this.worker !== worker || this.workerEpoch !== epoch) return;
        this.cancelLeaseRenewalRound();
        this.cancelSafety();
        Metrics.clearColdSafetyEpoch(epoch);
        this.projectionRetention.reset();
        this.economyDecisions.clear();
        this.economyRoutes.clear();
        DiagnosticConfig.developerDiagnostics && (this.counters.workerExits += 1);
        this.tableChannel.detach(this);
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
        DiagnosticConfig.developerDiagnostics && (this.counters.workerRestarts += 1);
        utils.infoWarn('ColdWorker', 'worker exited code=%d; restarting in %dms', Number(code || 0), restartDelay);
        this.restartTimer = setTimeout(() => this.startWorker(), restartDelay);
        this.restartTimer.unref?.();
    }

    recordError(error) {
        Metrics.recordColdOwnerError(error);
        utils.infoWarn('ColdWorker', '%s', error?.message || String(error));
    }

    stop() {
        if (this.stopPromise) return this.stopPromise;
        const pending = this.stopCurrent(this.worker, this.workerEpoch).finally(() => {
            if (this.stopPromise === pending) this.stopPromise = null;
        });
        this.stopPromise = pending;
        return pending;
    }

    async stopCurrent(worker, epoch) {
        // Fence posted continuations before cancellation, early returns or any
        // drain await. A stopped same-epoch recipient cannot be rearmed.
        this.tableChannel.stopActorRecipient?.(this, epoch);
        this.cancelLeaseRenewalRound();
        this.cancelSafety();
        this.projectionRetention.reset();
        this.economyDecisions.clear();
        this.economyRoutes.clear();
        if (!this.started) return { stopped: true };
        this.stopping = true;
        if (this.pvpEncounterTimer) clearInterval(this.pvpEncounterTimer);
        await invoke('GameServer/Bot/Population/PvpEncounterRuntime').stop();
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
        if (worker && this.worker === worker && this.workerEpoch === epoch) {
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
        if (worker) await worker.terminate().catch(() => null);
        Metrics.clearColdSafetyEpoch(epoch);
        if (this.worker === worker) this.worker = null;
        if (this.workerEpoch !== epoch) return { stopped: true, drained, queue };
        await ColdSimulationOwner.recoverStartupLeases().catch(() => null);
        this.started = false;
        return { stopped: true, drained, queue };
    }

    snapshot() {
        return {
            ...(Config.developerDiagnostics ? this.counters : { diagnosticsEnabled: false }),
            started: this.started,
            ready: this.ready,
            snapshotsLoaded: this.snapshotsLoaded,
            epoch: this.workerEpoch,
            heartbeatAgeMs: this.worker ? Math.max(0, Date.now() - this.lastHeartbeatAt) : null,
            worker: { ...this.lastWorkerSnapshot },
            competitionActions: Config.developerDiagnostics ? this.competitionActions.snapshot() : null,
            economyDecisions: Config.developerDiagnostics ? { hits: this.economyDecisions.hits, misses: this.economyDecisions.misses, held: this.economyDecisions.byId.size } : null,
            partyReviews: Config.developerDiagnostics ? this.partyReviews : null,
            economyPlans: Config.developerDiagnostics ? { count: this.economyPlanCount, perCommit: this.economyPlanCount / Math.max(1, this.queue.snapshot().committed || 0), p95Ms: [...this.economyPlanTimes].sort((a, b) => a - b)[Math.max(0, Math.ceil(this.economyPlanTimes.length * .95) - 1)] || 0 } : null,
            queue: this.queue.snapshot(),
            snapshots: {
                ...this.snapshotQueue.snapshot(),
                inFlight: !!this.snapshotInFlight,
                inFlightInitial: this.snapshotInFlightInitial,
                refreshPending: this.snapshotRefreshPending,
                criticalInFlight: !!this.criticalSnapshotInFlight,
                ...(Config.developerDiagnostics ? {
                last: { ...this.snapshotLast },
                fullRuns: this.counters.snapshotFullRuns,
                dirtyRuns: this.counters.snapshotDirtyRuns,
                criticalRuns: this.counters.snapshotCriticalRuns,
                yields: this.counters.snapshotYields,
                deferrals: this.counters.snapshotDeferrals
                } : {})
            }
        };
    }
}

module.exports = new ColdSimulationCoordinator();
module.exports.ColdSimulationCoordinator = ColdSimulationCoordinator;
module.exports.compactPartyMemberContext = compactPartyMemberContext;
module.exports.npcPlanningCatalogRows = npcPlanningCatalogRows;
module.exports.admitSoloRouteTravelState = admitSoloRouteTravelState;
