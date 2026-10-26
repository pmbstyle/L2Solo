const DiagnosticConfig = require('./PopulationConfig');
const { collectionPagesWithBytes, PAGE_BYTES } = require('./ColdMessagePages');
const StateWire = require('./ColdStateWire');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { Worker } = require('worker_threads');
const { performance } = require('perf_hooks');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Database = invoke('Database');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const DataCache = invoke('GameServer/DataCache');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const ClanSocial = invoke('GameServer/Clan/ClanSocialRuntime');
const HuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const RaidEncounterScope = invoke('GameServer/RaidBoss/RaidEncounterScope');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const CraftWorkshopService = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const AfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const ColdBuffService = invoke('GameServer/Bot/Economy/ColdBuffService');
const World = invoke('GameServer/World/World');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const HotBoardReview = invoke('GameServer/Bot/Economy/HotBoardReviewService');
const Protocol = require('./ColdSimulationProtocol');
const { ColdEconomyDecisions, echoHolds } = require('./ColdEconomyDecision');
const { TTL_MS: COMPETITION_TTL_MS } = require('./ColdCompetitionActions');
const { STEP_MS: PVP_STEP_MS } = require('./PvpEncounterBudget');
const ColdStateDelta = require('./ColdStateDelta');
const InventorySummary = require('./InventorySummary');
const { ColdCommitQueue, EARLY_COMMIT_ROW_BUDGET_MS } = require('./ColdCommitQueue');
const { ColdSnapshotQueue } = require('./ColdSnapshotQueue');
const ColdSafetyTransport = require('./ColdSafetyTransport');
const ColdNpcPlanningCatalog = require('./ColdNpcPlanningCatalog');
const TableChannel = require('./ColdTableChannel');
const TownNpcCatalog = require('../Economy/TownNpcCatalog');
const EconomyDiagnostics = require('../Economy/EconomyDiagnostics');
const EconomyCommit = require('../Economy/EconomyCommit');
const DecisionEvents = require('../AI/DecisionEvents');
const RecomputeGeneration = require('./RecomputeGeneration');

const ClanRaidRoster = require('../../Clan/ClanRaidRoster');
const BotRoute = require('./BotRoute');
const GeodataEngine = require('../../Geodata/GeodataEngine');
// Private main-thread provenance survives the queue's shallow clone but is
// excluded from JSON/wire sizing and cannot be supplied by a Worker message.
const PROPOSAL_SOURCE = Symbol('cold-proposal-source');
const CLAN_BEFORE = Symbol('cold-clan-before');
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Longest stretch the initial full snapshot builds rows without yielding.
const SNAPSHOT_SLICE_MS = 50;
function snapshotRefreshMs() {
    return Math.max(2000, Number(Config.coldWorkerSnapshotRefreshMs) || 10000);
}

function recipeKnowledgeFor(state) {
    return CraftShopService.isServiceCrafter(state)
        ? CraftWorkshopService.knowledgeFor(state.characterId) : {};
}

const yieldToLoop = require('../../EventLoopTurn');

function npcPlanningCatalogRows() {
    return ColdNpcPlanningCatalog.buildRows({
        items: DataCache.items || [],
        townNpcSellers: TownNpcCatalog.sellersByTown(),
        fetchForNpc: (npcSelfId) => NpcShopBuyLists.fetchForNpc(npcSelfId)
    });
}

const HEAP_SNAPSHOT_DIR = path.join(__dirname, '..', '..', '..', '..', 'tmp', 'heap');

// Diagnostics (coldWorkerHeapSnapshot): Node writes one snapshot of the worker's heap as it nears
// its cap (Heap.<date>.<time>.<pid>.<thread>.<seq>.heapsnapshot). Armed until this process has
// written one, so a restarted worker does not write another. The worker's execArgv carries only
// these flags: the server's own --openssl-legacy-provider is process-wide and a worker rejects it.
function heapSnapshotOptions() {
    if (Config.coldWorkerHeapSnapshot !== true) return {};
    try {
        fs.mkdirSync(HEAP_SNAPSHOT_DIR, { recursive: true });
        const own = `.${process.pid}.`;
        if (fs.readdirSync(HEAP_SNAPSHOT_DIR).some(name => name.includes(own) && name.endsWith('.heapsnapshot'))) return {};
    } catch (error) {
        utils.infoWarn('ColdWorker', 'heap snapshot disabled: %s', error.message);
        return {};
    }
    return { execArgv: ['--heapsnapshot-near-heap-limit=1', `--diagnostic-dir=${HEAP_SNAPSHOT_DIR}`] };
}

const emptyBusyWindow = () => ({ activeMs: 0, idleMs: 0, maxElu: 0, lagMs: 0 });

class ColdSimulationCoordinator {
    constructor(options = {}) {
        this.WorkerClass = options.WorkerClass || Worker;
        this.workerPath = options.workerPath || path.join(__dirname, 'ColdSimulationWorker.js');
        this.tableChannel = options.tableChannel || TableChannel.shared;
        this.worker = null;
        this.workerEpoch = null;
        this.safetyTransport = null;
        this.population = null;
        this.started = false;
        this.stopping = false;
        this.stopPromise = null;
        this.ready = false;
        this.snapshotsLoaded = false;
        this.lastHeartbeatAt = 0;
        this.busyWindow = emptyBusyWindow();
        this.lastWorkerMessage = null;
        this.terminateCause = null;
        this.lastWatchdogAt = 0;
        this.lastWorkerSnapshot = {};
        this.workerDiagnostics = null;
        this.workerDiagnosticsSeq = 0;
        this.diagnosticsResyncAt = 0;
        this.partyReviews = { committed: 0, departed: 0, dissolved: 0, reasons: {}, recent: [] };
        // Always on (PopulationStatus.nearText): the near decisions the bodies
        // took, refused as older than the held one, or dropped (the bot cooled
        // or has no body before its decision arrived).
        this.nearDecisions = { accepted: 0, refused: 0, dropped: 0 };
        this.workerMaxInFlight = null;
        this.restartCount = 0;
        this.loadedAt = 0;
        this.restartTimer = null;
        this.watchdogTimer = null;
        this.reconcileTimer = null;
        this.snapshotContinuationTimer = null;
        this.historyCleanupTimer = null;
        this.historyCleanupInFlight = null;
        this.seen = new Set();
        this.economyDecisions = new ColdEconomyDecisions();
        this.unsubscribeWishRemovals = LifeState.subscribePublications(packet => {
            if (packet.kind !== 'remove') return;
            this.economyDecisions.forget(packet.characterId);
            EconomyContext.forget(packet.characterId);
        });
        this.seenOrder = [];
        this.waiters = new Map();
        this.partyGoalRequests = 0;
        this.commandTail = Promise.resolve();
        this.competitionFrameAdmission = null;
        this.competitionActions = new (invoke('GameServer/Bot/Population/ColdCompetitionActions').ColdCompetitionActions)({
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
                return physical?.id === event.spotId && (['revenge', 'clan_war'].includes(event.action) || !!spot?.npcEntries?.some(row => Number(row.selfId) === event.npcId));
            },
            participantAllowed: id => !this.fencedBots.has(Number(id)),
            releaseForecasts: events => this.post('competition_release', { events: events.map(e => ({ at: e.at, action: e.action,
                actor: { id: e.actor.id, partyId: e.actor.partyId || null }, peer: { id: e.peer.id, partyId: e.peer.partyId || null } })) }),
            retreatRoute: (members, party, event, timestamp) => {
                const leader = members.find(s => s.characterId === party?.leaderId) || members[0];
                const spots = SpotProfiles.ensure() || [];
                const route = BotRoute.route(leader, SpotIndex.spotById(spots, event.spotId), party, members, { spots, timestamp });
                return route ? { ...route, cause: 'competition_avoid', reason: party ? 'party_spot_replan' : 'competition_avoid' } : null;
            },
            formParty: (members, event, options) => this.population?.formCompetitionParty?.(members, event, options),
            onState: id => {
                const state = LifeState.cachedState(id);
                if (state) this.markDirty(state, { critical: true, reason: 'competition_action' });
            },
            canRun: () => !this.stopping && this.ready && this.snapshotsLoaded && !this.pauseReasons.size
                && !this.queue?.flushing && !Database.pending()
                && Number(Metrics.currentEventLoopLag()) < 40
        });
        this.commandInflight = new Map();
        this.commitAcknowledgements = new Map();
        // characterId -> { startedAt, ack }: a leader whose ack waits for its deferred
        // party work (overdueReason reads the age; stop() waits for the acks).
        this.heldAcks = new Map();
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
        this.snapshotBootstrapPending = false;
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
            afterCommitStepErrors: { partyCache: 0, raidCache: 0, raidSettlement: 0, economyDecision: 0,
                board: 0, boardLimits: 0, equipment: 0, training: 0, improvement: 0, party: 0, metrics: 0, announce: 0,
                economyPlan: 0, clanEvents: 0, partyGoals: 0, partyPlans: 0, buff: 0 }
        };
        // Refused commits by reason and stale_command answers,
        // counted always (cheap): the live read of how often a main write
        // lands under a step or leaves the cached copy behind the row.
        this.refusals = { commitRefused: {}, staleCommand: 0 };
        // Review commands answered (always counted, like the refusals): how many
        // came, how they ended (refused by reason) and which steps they carried.
        this.reviews = { sent: 0, ok: 0, refused: {}, plan: 0, buff: 0, training: 0 };
        // Ok commit acks with the state and with the commit's numbers only
        // (ackNumbers), always counted.
        this.ackState = { with: 0, without: 0 };
        this.queue = new ColdCommitQueue({
            targetMs: Config.coldWorkerOrdinaryFlushMs || 2000,
            hardMs: Config.coldWorkerOrdinaryHardMaxMs || 5000,
            p1TargetMs: Config.coldWorkerCriticalFlushMs || 100,
            maxRows: Config.coldWorkerCommitBatchSize || 32,
            maxEntries: Config.coldWorkerQueueMaxEntries || 1024,
            maxBytes: Config.coldWorkerQueueMaxBytes || 4 * 1024 * 1024,
            prepare: (proposal) => this.prepareProposal(proposal),
            // The journal rides the commit transaction (the world outbox), not a write per bot after it.
            // The step commits on the revision it started from (entry.revision).
            commit: (entries) => ColdSimulationOwner.commitBatch(entries.map((entry) => ({ ...entry,
                lifeEvents: LifeEvents.resolvePayload(entry.nextState.characterId, entry.proposal.result?.events) }))),
            afterCommit: (entry, result) => this.afterCommit(entry, result),
            onResults: (results) => {
                // A party leader with deferred party work is acked when that work settles
                // (afterCommit ARCH-NOTE); every other result is acked now.
                const held = results.filter((result) => result.deferred), now = results.filter((result) => !result.deferred);
                const startedAt = Config.developerDiagnostics ? Date.now() : 0;
                this.handleCommitResults(now)
                    .catch((error) => { this.finishCommitAcknowledgements(now, false); this.recordError(error); })
                    .finally(() => { if (Config.developerDiagnostics) this.queue.recordStage('ackBuild', Date.now() - startedAt); });
                if (!held.length) return;
                // The flush is over here: the deferred party work starts now, not inside it.
                const ack = Promise.all(held.map((result) => result.deferred()))
                    .then(() => this.handleCommitResults(held))
                    .catch((error) => { this.finishCommitAcknowledgements(held, false); this.recordError(error); })
                    .finally(() => {
                        for (const result of held) {
                            const id = Number(result.characterId);
                            if (this.heldAcks.get(id)?.ack === ack) this.heldAcks.delete(id);
                        }
                        if (Config.developerDiagnostics) this.queue.recordStage('partyAck', Date.now() - startedAt);
                    });
                const holding = { startedAt: Date.now(), ack };
                for (const result of held) this.heldAcks.set(Number(result.characterId), holding);
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
            await invoke('GameServer/Bot/Population/ColdRaidAuthority').init();
            await ClanSocial.refresh(true);
            await invoke('GameServer/Clan/ClanWarRuntime').refresh(true);
            invoke('GameServer/Bot/Population/ColdOccupationSources').initialise();
            this.queue.start();
            this.startWorker();
            this.watchdogTimer = setInterval(() => this.watchdog(), 1000);
            const encounters = invoke('GameServer/Bot/Population/PvpEncounterRuntime');
            LifeState.allStates(2000).forEach(s => encounters.register(s.stats?.pvpEncounter));
            this.pvpEncounterTimer = setInterval(() => {
                encounters.tick(this.competitionActions)?.catch(error => this.recordError(error));
            }, PVP_STEP_MS);
            this.reconcileTimer = setInterval(() => {
                // The hunted bosses' rows: players engaging or the boss dying.
                RaidEncounterScope.reviewBosses(BackgroundPartyState.raidBossKeys());
                this.tableChannel.flush();
                this.sendSnapshots(false).catch((error) => this.recordError(error));
            }, snapshotRefreshMs());
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
        this.workerDiagnostics = null;
        this.workerDiagnosticsSeq = 0;
        this.diagnosticsResyncAt = 0;
        this.competitionFrameAdmission = null;
        this.ready = false;
        this.snapshotsLoaded = false;
        this.lastHeartbeatAt = Date.now();
        this.lastWorkerMessage = null;
        this.terminateCause = null;
        const worker = new this.WorkerClass(this.workerPath, {
            workerData: { workerEpoch: this.workerEpoch, developerDiagnostics: Config.developerDiagnostics === true,
                sharedGeodata: GeodataEngine.sharedDescriptor() },
            name: 'l2node-cold-simulation',
            resourceLimits: { maxOldGenerationSizeMb: Math.max(128, Number(Config.coldWorkerHeapMb) || 512) },
            ...heapSnapshotOptions()
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

    // The worker's heartbeat carries only the counters changed since its last sent delta. This keeps the
    // table metrics() would give; readers take it from lastWorkerSnapshot.developerDiagnostics and must not modify it.
    mergeDiagnostics(delta) {
        if (delta?.enabled !== true) return;
        if (delta.full === true) {
            const { enabled, thread, counts, durations, detail } = delta;
            this.workerDiagnostics = { enabled, thread, counts: { ...counts }, durations: { ...durations }, detail };
        } else if (this.workerDiagnostics && delta.seq === this.workerDiagnosticsSeq + 1) {
            const table = this.workerDiagnostics;
            Object.assign(table.counts, delta.counts);
            Object.assign(table.durations, delta.durations);
            table.detail = delta.detail;
        } else {
            // A gap, a repeat, or a delta before any full table: ask for a full one, at most once per 5 s.
            if (Date.now() - this.diagnosticsResyncAt > 5000) {
                this.diagnosticsResyncAt = Date.now();
                this.post('diagnostics_resync', {});
            }
            return;
        }
        this.workerDiagnosticsSeq = delta.seq;
    }

    // The health line's worker numbers since its last line (PopulationStatus.goalText takes them):
    // the busy share as summed active / idle ms, the busiest beat and the longest loop delay.
    noteBusy(payload) {
        const window = this.busyWindow;
        window.activeMs += Number(payload.eluActiveMs) || 0;
        window.idleMs += Number(payload.eluIdleMs) || 0;
        window.maxElu = Math.max(window.maxElu, Number(payload.eventLoopUtilization) || 0);
        window.lagMs = Math.max(window.lagMs, Number(payload.eventLoopLagMaxMs) || 0);
    }

    takeBusyWindow() {
        const window = this.busyWindow;
        this.busyWindow = emptyBusyWindow();
        return window;
    }

    // With diagnostics off the payload is stored as sent; with them on the kept table stands in for the delta,
    // also on a trimmed beat and on the "snapshots loaded" payload, which carry none.
    storeWorkerSnapshot(payload, heartbeat) {
        if (!DiagnosticConfig.developerDiagnostics) {
            this.lastWorkerSnapshot = payload;
            return;
        }
        if (heartbeat) this.mergeDiagnostics(payload.developerDiagnostics);
        this.lastWorkerSnapshot = { ...payload, developerDiagnostics: this.workerDiagnostics };
    }

    post(type, payload = {}, msgId = null, bytes = null) {
        if (!this.worker || !this.workerEpoch) return null;
        // The worker has no kernel before it reports `running`: a snapshot page sent earlier only faults
        // (kernel_not_initialized). Every page sender funnels here, so this is the one gate; dropped, not queued.
        if (type === 'snapshot_page' && !this.ready) return null;
        const entries = type === 'snapshot_page' ? payload.rows
            : ['commit_ack', 'command_ack'].includes(type) ? payload.results : [];
        // Table changes reach the worker before the states that read them
        // (parties, memory, goals, pressure, recipes, the board's escrow).
        if (entries?.length) this.tableChannel.flush();
        const packed = StateWire.packPayload(type, payload);
        if (packed !== payload) { payload = packed; bytes = null; }
        const message = Protocol.envelope(type, this.workerEpoch, payload, msgId);
        const valid = Protocol.validateEnvelope(message, 'main', { workerEpoch: this.workerEpoch, bytes });
        if (!valid.ok) {
            this.recordInvalid(`out_${type}_${valid.reason}`);
            return null;
        }
        DiagnosticConfig.developerDiagnostics && (this.counters.messagesOut += 1);
        DiagnosticConfig.developerDiagnostics && (this.counters.bytesOut += valid.bytes);
        if (!['command_request', 'command_ack'].includes(type)
            || !(payload.requests || payload.results || []).some(row => row.kind === 'meeting')) message.bytes = valid.bytes;
        this.worker.postMessage(message);
        return message.msgId;
    }

    meetingTermsDigest(input) {
        const request = invoke('GameServer/AfkTrade/TradeMeeting').canonical(input);
        const immutable = [request.token, request.actorA, request.actorB, request.seqA, request.seqB, request.town,
            [request.point.locX, request.point.locY, request.point.locZ],
            request.parties.map(party => [party.phase, party.hotAt, party.revision, party.sequence]),
            request.lines.map(line => [line.payer, line.itemId, line.selfId, line.enchant, line.count, line.price, line.adId, line.adRevision])];
        return require('node:crypto').createHash('sha256').update(JSON.stringify(immutable)).digest('hex');
    }

    requestMeetingPreparation(characterId, request) {
        const id = Number(characterId), token = request?.token;
        if (!this.worker || !this.ready || this.stopping || !request || ![request.actorA, request.actorB].includes(id))
            return Promise.reject(Error('trade_meeting_worker_unavailable'));
        const held = this.commandInflight.get(id);
        if (held?.meetingToken === token) return held;
        if (held?.meetingPending?.meetingToken === token) return held.meetingPending;
        if (held?.meetingToken || held?.meetingPending) return Promise.reject(Error('trade_meeting_preparation_busy'));
        const worker = this.worker, epoch = this.workerEpoch;
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        Object.assign(promise, { meetingToken: token, epoch, worker, termsDigest: this.meetingTermsDigest(request), resolve, reject, frames: [], reservedPages: 0, reservedBytes: 0 });
        promise.timer = setTimeout(() => {
            this.post('command_ack', { results: [{ kind: 'meeting', characterId: id, commandId: token,
                pageIndex: -1, ok: false, reason: 'preparation_timeout' }] });
            this.finishMeetingPreparation(id, promise, null, Error('trade_meeting_preparation_timeout'));
        }, 15000);
        promise.timer.unref?.();
        if (held) held.meetingPending = promise; else this.commandInflight.set(id, promise);
        // This call may originate inside a lifecycle command. Its ACK must
        // release the worker owner before the read-only preparation starts.
        // A postcommit market review can start consent before its resolver's
        // commit_ack clears in_flight in the worker. Wait for this owner's ACK,
        // independently of unrelated commits and the lifecycle command tail.
        const commitAck = this.commitAcknowledgements.get(id)?.promise;
        Promise.all([this.commandTail, commitAck]).then(([, acknowledged]) => {
            if (promise.settled) return;
            if (acknowledged === false) throw Error('trade_meeting_source_retired');
            if (!this.commandInflight.has(id)) this.commandInflight.set(id, promise);
            if (this.commandInflight.get(id) !== promise || this.worker !== worker || this.workerEpoch !== epoch || this.stopping)
                throw Error('trade_meeting_source_retired');
            const state = LifeState.cachedState(id);
            if (!state) throw Error('trade_meeting_missing_state');
            this.postCollections('snapshot_page', { rows: [{ state }] });
            const codec = invoke('GameServer/AfkTrade/TradeMeetingCodec');
            const msgId = `meeting:${id}:${token}`;
            const envelope = frame => Protocol.envelope('command_request', epoch,
                { requests: [{ kind: 'meeting', characterId: id, commandId: token, frame }] }, `${msgId}:3`);
            const frames = codec.commandPages(request, envelope, null, { incoming: request.incoming || request.parties.map(party => party.acceptedIncoming || {}) });
            const bytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(envelope(frame))), 0);
            // Reserve response headroom in the same global staging budget.
            invoke('GameServer/AfkTrade/TradeMeetingService').adjustTransportPages(4, Math.max(bytes, 4 * 768));
            promise.reservedPages = 4; promise.reservedBytes = Math.max(bytes, 4 * 768);
            for (const frame of frames) if (!this.post('command_request', { requests: [
                { kind: 'meeting', characterId: id, commandId: token, frame }] }, `${msgId}:${frame[2]}`))
                throw Error('trade_meeting_send_failed');
        }).catch(error => this.finishMeetingPreparation(id, promise, null, error));
        return promise;
    }

    finishMeetingPreparation(id, promise, proof, error) {
        const held = this.commandInflight.get(Number(id));
        if (promise.settled) return;
        promise.settled = true;
        clearTimeout(promise.timer);
        if (held === promise) this.commandInflight.delete(Number(id)); else if (held?.meetingPending === promise) delete held.meetingPending;
        if (promise.reservedPages) invoke('GameServer/AfkTrade/TradeMeetingService')
            .adjustTransportPages(-promise.reservedPages, -promise.reservedBytes);
        promise.frames = null;
        if (error) promise.reject(error); else promise.resolve(proof);
    }

    cancelMeetingPreparation(token) {
        for (const [id, held] of this.commandInflight) {
            const promise = held.meetingToken === token ? held : held.meetingPending?.meetingToken === token ? held.meetingPending : null;
            if (!promise) continue;
            this.post('command_ack', { results: [{ kind: 'meeting', characterId: id, commandId: token,
                pageIndex: -1, ok: false, reason: 'preparation_discarded' }] });
            this.finishMeetingPreparation(id, promise, null, Error('trade_meeting_preparation_discarded'));
        }
    }

    meetingPreparationCurrent(proof, request) {
        if (!proof || proof.epoch !== this.workerEpoch || proof.worker !== this.worker || this.stopping) return false;
        const state = LifeState.cachedState(proof.characterId);
        if (!state || !EconomyCommit.sameAuthority(EconomyCommit.authority(state), proof.authority)) return false;
        const board = invoke('GameServer/AfkTrade/AfkTradeService').boardIndex();
        const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
        if (!proof.dependencies?.every(([id, boardToken, marketToken, workshopToken]) => {
            const scope = Counters.counterOf(id), grouped = boardToken.startsWith('g:');
            return (grouped ? `g:${board.groupFingerprint(scope)}` : board.itemFingerprint(id)) === boardToken
                && Counters.meetingRevisionOf(scope) === marketToken
                && (grouped ? `g:${CraftWorkshopService.publicScopeDigest(scope)}` : String(CraftWorkshopService.publicRecipeDigest(id))) === workshopToken;
        })) return false;
        return proof.sources.every(([recordId, revision]) => {
            const rows = board.records.get(recordId);
            return rows?.length && rows.every(row => row.revision === revision);
        }) && proof.token === request.token;
    }

    handleMeetingRequest(message, worker, epoch) {
        for (const request of message.payload.requests || []) {
            const identity = Protocol.meetingIdentity(request);
            if (!identity || !request.frame) continue;
            const held = this.commandInflight.get(identity.characterId);
            if (!held || held.meetingToken !== identity.commandId || held.worker !== worker || held.epoch !== epoch) {
                this.post('command_ack', { results: [{ ...identity, pageIndex: request.frame[2], ok: true }] }, message.msgId);
                continue;
            }
            let ok = true, error;
            try {
                const previous = held.frames[request.frame[2]];
                if (previous && JSON.stringify(previous) !== JSON.stringify(request.frame)) throw Error('trade_meeting_consent_changed');
                held.frames[request.frame[2]] = request.frame;
                if (held.frames.filter(Boolean).length === request.frame[3]) {
                    const result = invoke('GameServer/AfkTrade/TradeMeetingCodec').fromPages(held.frames);
                    if (this.meetingTermsDigest(result) !== held.termsDigest) throw Error('trade_meeting_consent_changed');
                    const side = result.actorA === identity.characterId ? 0 : 1;
                    const own = result.parties[side];
                    const proof = { token: result.token, characterId: identity.characterId, sequence: own.sequence,
                        authority: { phase: own.phase, hotAt: own.hotAt, revision: own.revision },
                        route: own.route, certificates: result.lines.map(line => line.payer === side ? line.certificate : null),
                        dependencies: result.dependencies || [], sources: result.lines.map(line => [line.adId, line.adRevision]), epoch, worker, approved: true };
                    this.finishMeetingPreparation(identity.characterId, held, proof);
                }
            } catch (caught) { ok = false; error = caught; this.finishMeetingPreparation(identity.characterId, held, null, caught); }
            this.post('command_ack', { results: [{ ...identity, pageIndex: request.frame[2], ok,
                ...(error ? { reason: error.message } : {}) }] }, message.msgId);
        }
    }

    requestEconomyRefresh(characterId) {
        const id = Number(characterId), state = LifeState.cachedState(id);
        if (!state || this.stopping || !this.ready) return false;
        const owned = this.commandInflight.get(id);
        if (owned) {
            if (!owned.meetingToken && !owned.economyRefreshPending) {
                owned.economyRefreshPending = true;
                this.commandTail.then(() => {
                    if (this.commandInflight.get(id) !== owned) this.requestEconomyRefresh(id);
                }).catch(error => this.recordError(error));
            }
            return true;
        }
        this.postCollections('snapshot_page', { rows: [{ state }] });
        return !!this.post('snapshot_page', { rows: [], economyOwnerId: id, reconcile: true });
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
        collections = StateWire.packPayload(type, collections);
        const pages = collectionPagesWithBytes(type, this.workerEpoch, collections, msgId, (value) => {
            this.recordInvalid(`out_${type}_single_item_too_large`);
            return value?.state ? {
                ...value, state: null,
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
            const diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
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
        try {
            const payload = StateWire.unpackPayload(message.type, message.payload);
            if (payload !== message.payload) message = { ...message, payload };
            this.lastWorkerMessage = message.type === 'ready' ? `ready:${payload?.phase}` : message.type;
        } catch (error) {
            this.recordInvalid(`in_${message.type}_${error.message}`);
            return;
        }
        // A restarted worker numbers its messages from 1 again: a duplicate
        // is the same id from the same worker epoch.
        if (!this.remember(`${epoch}:${message.msgId}`)) {
            DiagnosticConfig.developerDiagnostics && (this.counters.duplicateMessages += 1);
            if (message.type === 'command_request' && message.payload.requests?.some(row => row.kind === 'meeting'))
                this.handleMeetingRequest(message, worker, epoch);
            return;
        }
        DiagnosticConfig.developerDiagnostics && (this.counters.messagesIn += 1);
        DiagnosticConfig.developerDiagnostics && (this.counters.bytesIn += valid.bytes);
        const payload = message.payload || {};
        switch (message.type) {
        case 'command_ack':
            for (const result of payload.results || []) {
                const held = this.commandInflight.get(result.characterId);
                if (held?.meetingToken === result.commandId && result.ok === false)
                    this.finishMeetingPreparation(result.characterId, held, null, Error(result.reason || 'trade_meeting_preparation_refused'));
            }
            break;
        case 'ready':
            if (payload.phase === 'loaded') {
                this.sendPlanningCatalog();
                this.post('init', { config: this.workerConfig(), catalogVersion: utils.buildNumber(),
                    recomputeGeneration: RecomputeGeneration.metadata() });
                this.stopDiagnosticSelection?.();
                this.stopDiagnosticSelection = Config.developerDiagnostics && Config.economyDiagnostics
                    ? EconomyDiagnostics.followSelection(ownerIds => {
                        if (!this.stopping && this.worker === worker && this.workerEpoch === epoch)
                            worker.postMessage({ type: 'economy_diagnostics_selection', epoch, ownerIds });
                    }) : null;
                try {
                    this.attachTableChannel();
                } catch (error) {
                    // Native source setup failed; use the existing Worker exit
                    // path rather than leave a running child without its feed.
                    this.onWorkerError(error);
                    this.terminateWorker('table_channel_setup_failed');
                }
            } else if (payload.phase === 'running') {
                this.ready = true;
                utils.infoSuccess('ColdWorker', 'running after a %d ms boot', Date.now() - this.lastHeartbeatAt);
                this.lastHeartbeatAt = Date.now();
                this.syncWorkerPressure();
                if (this.pauseReasons.size) this.post('pause', { reasons: [...this.pauseReasons] });
                await this.sendSnapshots(true);
            } else if (payload.phase === 'snapshots_loaded') {
                this.snapshotsLoaded = true;
                this.loadedAt = Date.now();
                this.storeWorkerSnapshot(payload, false);
                utils.infoSuccess('ColdWorker', 'ready states=%d queueHead=%s', Number(payload.states || 0), payload.queueHead?.kind || 'unknown');
            } else if (payload.phase === 'state_loaded') {
                const waiter = this.waiters.get(message.msgId);
                if (waiter) {
                    this.waiters.delete(message.msgId);
                    waiter.resolve(payload);
                }
            } else if (payload.phase === 'economy_plan_ready' && !this.stopping) {
                const id = Number(payload.characterId), state = LifeState.cachedState(id);
                if (state && EconomyCommit.sameAuthority(EconomyCommit.authority(state), payload.authority)) {
                    const beforeWrite = () => {
                        if (this.worker !== worker || this.workerEpoch !== epoch) throw Error('economy_refresh_source_retired');
                    };
                    const decision = payload.economyDecision;
                    if (!decision || decision.updatedAt !== Number(state.updatedAt || 0)
                        || !echoHolds(state, decision.echo)) break;
                    this.economyDecisions.hold(id, decision);
                    try {
                        const result = await AfkMarket.executePlan(state, payload.economyPlan, { beforeWrite, preparedState: state })
                            .catch(error => { this.recordError(error); return null; });
                        if (result?.buyPending) this.requestEconomyRefresh(id);
                    } finally { this.economyDecisions.release(id); }
                }
            } else if (payload.phase === 'economy_decided' && !this.stopping) {
                // A near bot's decision, taken on its post (payload.near.nearSeq).
                // The body keeps the newest one it got: an older post's decision
                // arriving after it is refused. It never authorizes native spending.
                const id = Number(payload.characterId), state = LifeState.cachedState(id);
                const session = World.registeredActorById(id)?.session;
                if (state?.phase !== 'hot' || !payload.economyDecision || !payload.near || !session?.actor) {
                    this.nearDecisions.dropped++; break;
                }
                if (Number(payload.near.nearSeq || 0) < Number(session.heldNearSeq || 0)) { this.nearDecisions.refused++; break; }
                this.nearDecisions.accepted++;
                // The held card is the one compact (accept) the body's view reads.
                const decision = this.economyDecisions.accept(id, payload.economyDecision);
                DecisionEvents.receive(session, decision, payload.near);
                if (decision?.feasibility) HotBoardReview.preparedOwner(id);
            } else if (payload.phase === 'economy_workshop_stale' && !this.stopping) {
                this.economyDecisions.staleWorkshop(Number(payload.characterId),
                    { updatedAt: Number(payload.updatedAt), echo: payload.echo });
            }
            break;
        case 'proposal_batch':
            this.handleProposalBatch(message, worker, epoch);
            break;
        case 'party_goal_result':
        case 'party_formation_proposal': {
            const waiter = this.waiters.get(message.msgId);
            if (waiter && (!waiter.expectedType || waiter.expectedType === message.type)) {
                this.waiters.delete(message.msgId);
                waiter.resolve(payload);
            }
            break;
        }
        case 'command_request':
            this.handleCommandRequest(message, worker, epoch);
            break;
        case 'heartbeat':
            this.lastHeartbeatAt = Date.now();
            this.noteBusy(payload);
            this.storeWorkerSnapshot(payload, true);
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
            ...(Config.developerDiagnostics && Config.economyDiagnostics ? { economyDiagnostics: true, economyDiagnosticsBotIds: EconomyDiagnostics.ownerIds() } : {}),
            coldHonestTravel: Config.coldHonestTravel,
            pvpAggression: Config.pvpAggression,
            maxBatch: Math.max(1, Math.min(64, Number(Config.coldWorkerBatchSize) || 64)),
            maxInFlight: this.desiredWorkerPressure().maxInFlight,
            // Normal ambient parties keep their configured cap, while a clan
            // equipment operation may use the native C4 party limit of nine.
            maxAtomicPartySize: Math.max(9, Number(Config.partyMaxSize) || 5),
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

    async requestPartyGoals(party, members, options = {}) {
        const Calculation = invoke('GameServer/Bot/Population/PartyGoalCalculation');
        if (!Calculation.validMembers(party, members)) return { ok: false, reason: 'invalid_party_members' };
        if (!this.worker || !this.ready || !this.snapshotsLoaded || this.stopping)
            return { ok: false, reason: 'worker_not_ready' };
        if (this.partyGoalRequests >= 2) return { ok: false, reason: 'party_goal_busy' };
        const worker = this.worker, epoch = this.workerEpoch;
        const timestamp = Number(options.timestamp || Date.now());
        const replyBy = Date.now() + Math.max(50, Math.min(5000, Number(options.timeoutMs) || 5000));
        const expected = Calculation.sources(members);
        const escrowFor = member => AfkMarket.buyOrderEscrow(member.characterId);
        const escrows = members.map(escrowFor);
        const recipeKnowledge = members.map(recipeKnowledgeFor);
        const msgId = randomUUID();
        let timer, waitStarted;
        this.partyGoalRequests++;
        try {
            const result = await new Promise((resolve, reject) => {
                this.waiters.set(msgId, { resolve, reject, expectedType: 'party_goal_result' });
                timer = setTimeout(() => reject(new Error('party_goal_timeout')), Math.max(1, replyBy - Date.now()));
                const payload = { party, members, escrows, recipeKnowledge, timestamp, replyBy };
                const bytes = Protocol.byteLength(Protocol.envelope('party_goal_request', epoch, payload, msgId));
                const pages = bytes <= Protocol.MAX_MESSAGE_BYTES ? [{ payload, bytes }]
                    : members.map((member, pageIndex) => {
                        const page = { ...(pageIndex === 0 ? { party } : { partyId: party.partyId }),
                            members: [member], escrows: [escrows[pageIndex]], recipeKnowledge: [recipeKnowledge[pageIndex]], timestamp, replyBy,
                            pageIndex, pageCount: members.length };
                        return { payload: page, bytes: Protocol.byteLength(Protocol.envelope('party_goal_request', epoch, page, msgId)) };
                    });
                if (pages.some(page => page.bytes > Protocol.MAX_MESSAGE_BYTES)
                    || pages.some(page => !this.post('party_goal_request', page.payload, msgId, page.bytes)))
                    reject(new Error('party_goal_send_failed'));
                waitStarted = performance.now();
            });
            if (options.onWorkerWait && waitStarted !== undefined) options.onWorkerWait(performance.now() - waitStarted);
            if (this.worker !== worker || this.workerEpoch !== epoch || this.stopping || Date.now() >= replyBy)
                return { ok: false, reason: 'party_goal_stale_worker' };
            if (!result.ok) return result;
            if (JSON.stringify(result.sources) !== JSON.stringify(expected)
                || JSON.stringify(members.map(escrowFor)) !== JSON.stringify(escrows)
                || JSON.stringify(members.map(recipeKnowledgeFor)) !== JSON.stringify(recipeKnowledge))
                return { ok: false, reason: 'party_goal_source_changed' };
            return result;
        } catch (error) {
            return { ok: false, reason: error.message };
        } finally {
            clearTimeout(timer);
            this.waiters.delete(msgId);
            this.partyGoalRequests--;
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

    // Loads a service crafter's recipes into main's cache; the first load
    // publishes its 'recipes' row (CraftWorkshopService), which the worker
    // plans the crafter from.
    async ensureCraftRecipes(state) {
        if (CraftShopService.isServiceCrafter(state)) {
            await CraftWorkshopService.knownFor(state.characterId);
        }
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
        // The safety repair projects from main's own cached state.
        const state = LifeState.cachedState(characterId);
        return state ? { ok: true, entry: { state } } : { ok: false, reason: 'missing_state' };
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
        // Deferred inventory/memory notifications can still carry the object
        // from before a native paid leg. Coalescing that object over the new
        // leg leaves the worker waiting at the old meeting state indefinitely.
        const current = LifeState.cachedState(Number(state?.characterId));
        if (current && (Number(current.simulation?.revision || 0) > Number(state?.simulation?.revision || 0)
            || Number(current.simulation?.revision || 0) === Number(state?.simulation?.revision || 0)
                && Number(current.updatedAt || 0) > Number(state?.updatedAt || 0))) state = current;
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

    async sendIncrementalEntries(entries, pageSize, priority = null, deadlineAt = Infinity) {
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
            const row = StateWire.packEntry({ state: entry.state || entry });
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
        ClanSocial.send(this);
        await this.reconcileOrphanedBackgroundParties();
        // Re-read after reconciliation: releasing an invalid party updates
        // cached member ownership and membership. Sending the pre-repair
        // array would immediately seed the worker with the stale party again.
        const states = LifeState.everyState();
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

        // A page of fresh recipe loads can take most of a second on cold caches;
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
            const row = StateWire.packEntry({ state });
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
        if (!this.worker || !this.ready || this.snapshotInFlightInitial || this.snapshotBootstrapPending) return false;
        if (this.criticalSnapshotInFlight) return this.criticalSnapshotInFlight;

        const job = (async () => {
            while (this.worker && this.ready) {
                const entries = this.snapshotQueue.takeCritical(this.snapshotQueue.pageSize);
                if (!entries.length) break;
                const result = await this.sendIncrementalEntries(entries, this.snapshotQueue.pageSize, 'P0');
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
        job.finally(() => {
            this.criticalSnapshotInFlight = null;
            if (this.snapshotRefreshPending && this.started && !this.stopping) {
                this.snapshotRefreshPending = false;
                setImmediate(() => this.sendSnapshots(false).catch(error => this.recordError(error)));
            }
        }).catch(() => null);
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
        // Preserve bootstrap intent across a concurrent critical publication.
        // An incremental continuation has no final initial-ready marker.
        if (initial) this.snapshotBootstrapPending = true;
        await ClanSocial.refresh();
        await invoke('GameServer/Clan/ClanWarRuntime').refresh();
        await ClanSocial.enforceOne(this);
        ClanSocial.send(this);
        if (this.snapshotInFlight || this.criticalSnapshotInFlight) {
            this.snapshotRefreshPending = true;
            return false;
        }
        if (this.snapshotBootstrapPending) {
            this.snapshotBootstrapPending = false;
            DiagnosticConfig.developerDiagnostics && (this.counters.snapshotFullRuns += 1);
            return this.startSnapshotJob('full', async () => {
                const result = await this.sendFullSnapshot();
                if (!result?.ok) utils.infoWarn('ColdWorker', 'initial snapshot failed after %d states in %d pages',
                    Number(result?.rowsSent || 0), Number(result?.pagesSent || 0));
                return result;
            });
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
                const result = await this.sendIncrementalEntries(plan.entries, plan.pageSize, null,
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
        // The row alone: the worker's copy keeps the bot's decision and its
        // first far row restores the card from the bot's saved copy.
        const msgId = this.post('snapshot_page', { rows: [{ state }], done: false, ack: true, initial: false });
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
            // The step's base revision: the commit's only fence.
            if (!Number.isSafeInteger(proposal.revision) || proposal.revision < 0) {
                rejected.push({ ok: false, characterId: Number(proposal.characterId || 0), reason: 'invalid_revision', proposal });
                return;
            }
            const queued = this.queue.enqueue(proposal, Array.isArray(sizes) ? sizes[index] : null);
            if (!queued.ok) rejected.push({ ok: false, characterId: proposal.characterId, reason: queued.reason, proposal });
            else this.trackCommitAcknowledgement(proposal, source);
        });
        if (rejected.length) this.handleCommitResults(rejected).catch((error) => this.recordError(error));
    }

    trackCommitAcknowledgement(proposal, source) {
        const id = Number(proposal.characterId), previous = this.commitAcknowledgements.get(id);
        if (previous?.proposalId === proposal.proposalId && previous.source.worker === source.worker
            && previous.source.epoch === source.epoch) return;
        previous?.resolve(false);
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        // One small waiter per admitted queue owner; no retained state copy.
        this.commitAcknowledgements.set(id, { proposalId: proposal.proposalId, source, promise, resolve,
            memberIds: proposal.atomicGroup?.memberIds });
    }

    finishCommitAcknowledgements(results, acknowledged = true) {
        for (const result of results) {
            const id = Number(result.characterId), held = this.commitAcknowledgements.get(id);
            const source = result.proposal?.[PROPOSAL_SOURCE];
            if (!held || held.proposalId !== result.proposal?.proposalId
                || source && (held.source.worker !== source.worker || held.source.epoch !== source.epoch)) continue;
            this.commitAcknowledgements.delete(id);
            held.resolve(acknowledged);
        }
    }

    async prepareProposal(proposal) {
        if (proposal.atomicGroup?.raidCommit) {
            if (!invoke('GameServer/Bot/Population/ColdRaidAuthority').prepare(proposal.atomicGroup.raidCommit)) return null;
        }
        // No base state travels with a proposal: a bot main does not hold is
        // refused (prepare_rejected) and the worker requeues it.
        const state = LifeState.cachedState(proposal.characterId);
        if (!state) return null;
        if (Number(state.stats?.clanId) > 0) proposal[CLAN_BEFORE] = { level: state.level, sp: state.sp, inventory: state.inventory };
        const partyId = String(state.party?.partyId || state.partyId || '');
        if ((partyId && invoke('GameServer/Bot/Population/HotPartyLifecycle').pending.has(partyId))
            || this.visibleToRealPlayer(state)) return null;
        if (proposal.nextStateDelta) {
            // Never rebase a sparse result over a newer revision.
            if (Number(state.simulation?.revision) !== proposal.revision) return null;
            proposal.nextState = ColdStateDelta.apply(state, proposal.nextStateDelta);
        }
        // The step runs on the revision it started from; the commit refuses a moved one.
        const stepState = { ...state, simulation: { ...state.simulation, revision: proposal.revision } };
        const timestamp = Number(proposal.enqueuedAt || Date.now());
        // The worker's fight has already happened: a forced cleanup trip
        // starts from the state after it, so its exp, adena and loot stay.
        const resolvedState = proposal.nextState;
        if (!resolvedState) return null;
        // The worker recorded this hunt's income: the main thread's level-band
        // table (the hour value of bots without a sample) learns it here.
        HuntEfficiency.observe(resolvedState);
        // The worker decided the forced cleanup on this solo step (cleanupNeed);
        // main only starts the trip.
        const cleanupState = proposal.cleanupNeed ? this.population?.prepareInventoryCleanupProposal?.(
            resolvedState, timestamp, stepState.simulation, stepState, proposal.cleanupNeed) : null;
        if (cleanupState) {
            proposal.inventoryCleanupForced = true;
            delete cleanupState.cleanup;
            // The trip pays here (scroll, fee): the worker's bag flag and
            // emptied stacks did not see it, so the commit adds what it moved.
            // A set union: preparing the same proposal again adds nothing twice
            // (a flag left true by it costs one physical write, never a skip).
            const paid = InventorySummary.bagChange(resolvedState.inventory, cleanupState.inventory);
            if (paid.bagChanged) proposal.bagChanged = true;
            if (paid.removedItemIds) proposal.removedItemIds = [...new Set([...(proposal.removedItemIds || []), ...paid.removedItemIds])];
            return cleanupState;
        }
        // The worker's step result commits as it is: the room at a spot is
        // checked in the worker when the bot arrives there.
        return resolvedState;
    }

    async step(name, characterId, work) {
        try { return await work(); }
        catch (error) {
            DiagnosticConfig.developerDiagnostics && (this.counters.afterCommitStepErrors[name] += 1);
            utils.infoWarn('ColdWorker', 'postcommit %s failed for %s: %s', name, characterId, error?.message || error);
            return undefined;
        }
    }

    // One top-level afterCommit step: its time joins the flush's sum for that
    // step name (gs: afterCommitSteps). Nested steps run untimed inside it.
    // A deferred step runs after the flush and records its own sample.
    async timedStep(entry, name, work, record) {
        if (!entry.stepMs) return this.step(name, entry.nextState.characterId, work);
        const startedAt = performance.now();
        try { return await this.step(name, entry.nextState.characterId, work); }
        finally {
            const ms = performance.now() - startedAt;
            if (record) record(ms); else entry.stepMs[name] = (entry.stepMs[name] || 0) + ms;
        }
    }

    async afterCommit(entry, committed = {}) {
        if (Config.developerDiagnostics === true) invoke('GameServer/Bot/Economy/ConsumptionDiagnostics').publish(
            entry.nextState.characterId, entry.proposal.result?.consumptionDiagnostics, {
                source: 'cold_commit', commandId: entry.proposal.commandId, proposalId: entry.proposal.proposalId,
                revision: committed.revision ?? committed.row?.simulationRevision ?? entry.proposal.revision, sequence: entry.proposal.sequence
            });
        const id = entry.nextState.characterId;
        const step = (name, work) => this.timedStep(entry, name, work);
        const source = entry.proposal[PROPOSAL_SOURCE];
        const sourceCurrent = () => !this.stopping && (!source || source.worker === this.worker && source.epoch === this.workerEpoch);
        const beforeWrite = () => {
            if (!sourceCurrent()) throw Error('cold_postcommit_source_retired');
        };
        // Party work that runs after this flush, in order, while the leader's ack waits.
        const deferred = [];
        const later = (name, work) => deferred.push(() => this.timedStep(entry, name, work,
            (ms) => this.queue.recordStep(name, ms)));
        const committedPartyRow = committed.partyRow || committed.raidPartyRow;
        await step('partyCache', () => {
            // Every member receives the shared row, but only the group's
            // publisher owns it. Its postcommit review may already dissolve
            // the party; a later follower receipt must not resurrect the cache.
            if (committedPartyRow && entry.proposal.partyResolution?.partyId === committedPartyRow.partyId
                && Number(BackgroundPartyState.find(committedPartyRow.partyId)?.revision ?? -1)
                < Number(committedPartyRow.revision)) BackgroundPartyState.acceptRow(committedPartyRow);
        });
        await step('raidCache', () => {
            if (committed.raidRow) invoke('GameServer/Bot/Population/ColdRaidAuthority').accept(committed.raidRow);
        });
        await step('raidSettlement', async () => {
            if (committedPartyRow && entry.proposal.partyResolution?.party?.stats?.raidEncounter?.status === 'defeated') {
                await invoke('GameServer/Bot/Population/ColdRaidWorldBridge').settle(entry.proposal.partyResolution.party, { respawnAt: committed.raidRespawnAt });
            }
        });
        let state = LifeState.cachedState(id) || entry.nextState;
        if (sourceCurrent()) await step('economyDecision',
            () => this.economyDecisions.accept(id, entry.proposal.economyDecision, committed, state));
        if (sourceCurrent() && entry.proposal.market) {
            // The resolve has already advanced native ownership. Capture its
            // accepted authority after commit, never the worker's old revision.
            const coldAuthority = { revision: Number(state.simulation?.revision || 0) };
            const canCommitReview = () => {
                const current = LifeState.cachedState(id);
                return sourceCurrent() && current?.phase === 'cold'
                    && Number(current.simulation?.revision || 0) === coldAuthority.revision;
            };
            await step('board', () => AfkMarket
                .applyReview(id, entry.proposal.market, { coldAuthority, canCommitReview }));
        }
        await step('equipment', () => LifeState.enqueueEquipmentGoalAdvanceForState(state));
        // The bot's own plan, buff and training run in the review command the
        // worker sends on this commit's ack (reviewSteps, executeReviewCommand).
        // Correct only this owner's standing bids against the committed state,
        // even when wish preparation or a board write was deferred; a review
        // that runs a plan corrects them again after it.
        if (sourceCurrent()) await step('boardLimits', async () => {
            const checked = await AfkMarket
                .reviewPurchaseLimits(state, { beforeWrite });
            state = checked.state || state;
        });
        await step('clanEvents', () => invoke('GameServer/Clan/ClanReviewEvents').committedMember(entry.proposal[CLAN_BEFORE], state));
        await step('party', async () => {
            if (entry.proposal.partyResolution?.party) {
                const party = entry.proposal.partyResolution.party;
                // A pending join main recorded after the worker took its copy of
                // the row outlives this blind write; a step that read it answers
                // it (recruitCheck) and writes the row without it.
                const pending = !committedPartyRow && !entry.proposal.partyResolution.recruitCheck && party.status !== 'dissolved'
                    && BackgroundPartyState.find(party.partyId)?.stats?.pendingRecruits;
                if (!committedPartyRow) await BackgroundPartyState.createOrUpdate(pending
                    ? { ...party, stats: { ...(party.stats || {}), pendingRecruits: pending } } : party);
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
                    // ARCH-NOTE: the goal review and the member plans run after the flush
                    // but before the leader's commit_ack. Until that ack the kernel holds
                    // every member inFlight (ColdSimulationKernel claim check), so no party
                    // commit can land the party row while main reviews it: the worker's
                    // hunt commit writes that row through createOrUpdate ->
                    // saveBackgroundParty, a blind statsJson upsert. The ack then carries
                    // the reviewed leader state after the table changes (handleCommitResults),
                    // so the leader is never acked first and reviewed later.
                    if (entry.proposal.partyResolution.reviewGoals
                        && this.population?.reconcileWorkerPartyGoals) {
                        const enqueuedAt = Number(entry.proposal.enqueuedAt || Date.now());
                        later('partyGoals', () => this.population.reconcileWorkerPartyGoals(party, enqueuedAt)
                            .catch((error) => {
                                utils.infoWarn('BotGoals', 'worker party goal reconcile failed for %s: %s', party.partyId, error?.message || error);
                            }));
                    }
                }
            }
        });
        // It writes member rows and the party row: deferred and held like the goal review, after it.
        if (entry.proposal.partyResolution?.party && this.population?.applyWorkerPartyRequirements) {
            later('partyPlans', () => this.population.applyWorkerPartyRequirements(
                BackgroundPartyState.find(entry.proposal.partyResolution.partyId) || entry.proposal.partyResolution.party,
                entry.proposal.partyResolution));
        }
        // The recruit check the leader's step ran on the party's pending join.
        if (entry.proposal.partyResolution?.recruitCheck && this.population?.applyWorkerPartyJoin) {
            later('partyJoin', () => this.population.applyWorkerPartyJoin(entry.proposal.partyResolution.partyId,
                entry.proposal.partyResolution.recruitCheck));
        }
        if (Config.developerDiagnostics) await step('metrics', () => {
            Metrics.recordBackgroundResolve();
            Metrics.recordCombat(entry.proposal.result?.debug);
            Metrics.recordResolveDuration(Math.max(0, Date.now() - Number(entry.proposal.enqueuedAt || Date.now())));
        });
        // Main replaced the worker's resolved state with a paid forced cleanup
        // trip: the plan was prepared before that fare and activity change, so
        // no review runs it (reviewSteps) and the worker plans afresh.
        if (sourceCurrent() && entry.proposal.inventoryCleanupForced && entry.proposal.economyPlan)
            this.requestEconomyRefresh(id);
        await step('announce', () => GlobalChat.maybeAnnounce(state, entry.proposal.result?.events || []));
        // onResults starts it after the flush. A member's own review command (its
        // training, buff, plan) runs meanwhile: a party write holds on the revision
        // it read (LifeState.writePartyRequirementPlan, a departure through
        // LifeState.leaveParty heldOnRevision), so a member write landing
        // in between wins and the party write is skipped. A replaced worker or a stop skips the rest: its kernel no longer holds these
        // members inFlight.
        if (deferred.length) entry.deferred = async () => {
            for (const work of deferred) {
                if (this.stopping || source && (source.worker !== this.worker || source.epoch !== this.workerEpoch)) return;
                await work();
            }
        };
        return state;
    }

    // `trained.done` tells the review command its training step already ran.
    async reviewCommittedEconomy(state, beforeWrite, decisionOverride, trained = {}) {
        if (invoke('GameServer/AfkTrade/TradeMeetingService').hasPreparation(state.characterId)) return LifeState.cachedState(state.characterId) || state;
        // The native commit has released its lease before these actions.
        // Each action validates the current row again inside its writer.
        state = LifeState.cachedState(state.characterId) || state;
        const decision = decisionOverride === undefined
            ? await this.step('improvement', state.characterId, () => this.economyDecisions.decided(state)) : decisionOverride;
        const source = LifeState.cachedState(state.characterId) === state;
        const reviewed = await this.step('training', state.characterId, () => LifeState.reviewTrainingAfterCommit(state, { beforeWrite }));
        // Done only when the review saw the cached state and had nothing to train. A stale source (it returns the newer
        // state untrained), a failed step or a new row from training leaves the review command's training step to run.
        trained.done = source && reviewed === state;
        state = reviewed || LifeState.cachedState(state.characterId) || state;
        const improved = await this.step('improvement', state.characterId, () => invoke('GameServer/Bot/Economy/BotImprovementService')
            .reviewCold(state, { beforeWrite, decide: () => decision }));
        return improved?.state || LifeState.cachedState(state.characterId) || state;
    }

    async handleCommitResults(results = []) {
        const worker = this.worker, epoch = this.workerEpoch;
        for (const result of results) {
            if (!result.ok) this.refusals.commitRefused[result.reason] = (this.refusals.commitRefused[result.reason] || 0) + 1;
        }
        // A committed dissolve of a marked unopened party (the resolver's cancel)
        // wakes its clan once; the atomic group commits all members or none.
        const dissolved = new Set();
        for (const result of results) {
            const change = result.ok ? result.proposal?.atomicGroup?.partyChanges?.[0] : null;
            if (change?.status !== 'dissolved' || dissolved.has(change.partyId)) continue;
            dissolved.add(change.partyId);
            try { ClanRaidRoster.wakeCancelled({ stats: JSON.parse(change.statsJson || '{}') }); }
            catch (error) { this.recordError(error); }
        }
        const current = results.filter(result => {
            const source = result.proposal?.[PROPOSAL_SOURCE];
            return !source || (source.worker === worker && source.epoch === epoch);
        });
        // A retired source gets no ack: its meeting waiters learn it here.
        if (current.length < results.length) this.finishCommitAcknowledgements(results.filter(result => !current.includes(result)), false);
        results = current;
        if (!results.length) {
            this.tableChannel.flush();
            return;
        }
        // A refused commit hands back the row it read: the ack's state carries
        // what main wrote under the step and the next proposal is built on it.
        for (const result of results) {
            if (!result.ok && result.row) LifeState.acceptNewerLifecycleRow(result.row);
        }
        const cancelled = new Set();
        for (const result of results) {
            if (!ClanRaidRoster.CANCEL_REASONS.includes(result.detail)) continue;
            const change = result.proposal?.atomicGroup?.partyChanges?.[0];
            if (!change || cancelled.has(change.partyId)) continue;
            cancelled.add(change.partyId);
            const party = BackgroundPartyState.find(change.partyId);
            if (party?.revision === change.expectedPartyRevision) await ClanRaidRoster.cancelUnopened(party, result.detail);
        }
        if (this.worker !== worker || this.workerEpoch !== epoch) {
            this.finishCommitAcknowledgements(results, false);
            this.tableChannel.flush();
            return;
        }
        const acknowledgements = results.flatMap((result) => {
            const characterId = Number(result.characterId), proposalId = result.proposal?.proposalId;
            if (!Number.isSafeInteger(characterId) || characterId <= 0
                || typeof proposalId !== 'string' || !proposalId || proposalId.length > 240) return [];
            const state = LifeState.cachedState(result.characterId) || result.nextState || null;
            const numbers = result.ok ? this.ackNumbers(result, state) : null;
            if (result.ok) this.ackState[numbers ? 'without' : 'with'] += 1;
            return [{
                ok: !!result.ok,
                characterId,
                proposalId,
                reason: result.reason || (result.ok ? 'committed' : 'rejected'),
                // A refused atomic group names its cause here (e.g. party_revision_stale).
                ...(result.detail ? { detail: result.detail } : {}),
                revision: result.revision,
                raidStepId: result.proposal?.raidStepId,
                ...(result.ok && Number.isFinite(result.eventWaitMs) && result.eventWaitMs > 0
                    ? { eventWaitMs: result.eventWaitMs } : {}),
                ...(numbers || { state }),
                ...(result.ok ? this.reviewSteps(result.proposal, state) : {})
            }];
        });
        // Table changes reach the worker before the commits that made them.
        this.tableChannel.flush();
        const sent = this.postCollections('commit_ack', { results: acknowledgements });
        this.finishCommitAcknowledgements(results, sent > 0);
    }

    // An ok ack carries the commit's numbers, not the state, when main's cache
    // is the commit's own entry built from the worker's proposal: the worker
    // rebuilds it (Protocol.committedState). Otherwise main changed what it
    // committed and the state goes: a forced cleanup trip or a state main
    // resolved itself (prepareProposal), a later write over the entry (an
    // afterCommit step, the party work), a row the commit re-read (a board
    // settlement, a PvP tally, a PK drop, a party payment: SQL wrote its bag or
    // stats), or the economy leaf the row kept over the proposal's (a different
    // one): the committed stats are then a new object (ColdSimulationOwner
    // withEconomyLeaf), the proposal's own object when the leaves match.
    ackNumbers(result, cached) {
        const proposal = result.proposal, row = result.row;
        if (!proposal?.nextState || proposal.inventoryCleanupForced
            || !result.cached || cached !== result.cached
            || result.settled || result.pkDrops?.length || result.partyPayment
            || !row || typeof row.statsJson === 'string'
            || result.cached.stats !== proposal.nextState.stats) return null;
        // The ack's revision is already the commit's (result.revision, the cache's too).
        return { updatedAt: cached.updatedAt, inventoryRevision: cached.bagRevision,
            skillsRevision: cached.skillsRevision, hennaRevision: cached.hennaRevision };
    }

    // The steps of the review command the worker sends on this ok ack, decided
    // here where the facts are: the plan unless main forced a cleanup trip over
    // it, the buff offer, training when the committed state needs it (a level,
    // a class or a skill book in the bag). None: no review.
    reviewSteps(proposal, state) {
        const review = [];
        if (proposal?.economyPlan && !proposal.inventoryCleanupForced) review.push('plan');
        if (proposal?.buffOffer) review.push('buff');
        if (LifeState.trainingNeeded(state)) review.push('training');
        return review.length ? { review } : {};
    }

    handleCommandRequest(message, worker = this.worker, epoch = this.workerEpoch) {
        if ((message.payload.requests || []).some(request => request.kind === 'meeting')) {
            this.handleMeetingRequest(message, worker, epoch); return;
        }
        const sourceCurrent = () => this.worker === worker && this.workerEpoch === epoch;
        const requests = (message.payload.requests || []).flatMap((request) => {
            const parsed = Protocol.commandIdentity(request);
            const identity = parsed && { characterId: parsed.characterId, commandId: parsed.commandId,
                commandCheckpoint: parsed.checkpoint };
            if (!identity || (request.kind !== 'lifecycle' && request.kind !== 'review')
                || request.kind === 'lifecycle' && !Protocol.sameCommandCheckpoint(identity.commandCheckpoint, request.state)) return [];
            return [{ request, identity }];
        });
        this.commandTail = this.commandTail.then(async () => {
            if (!sourceCurrent()) return;
            const results = [];
            for (const { request, identity } of requests) {
                if (!sourceCurrent()) return;
                DiagnosticConfig.developerDiagnostics && (this.counters.commands += 1);
                try {
                    let state = LifeState.cachedState(request.characterId);
                    const id = identity.characterId;
                    Metrics.recordColdOwnerLegacyDeferred(`command_${String(state?.activity || 'unknown')}`);
                    if (this.fencedBots.has(id) || state?.phase !== 'cold') {
                        results.push({ ...identity, ok: false, reason: 'hot_handoff_fenced',
                            ...(state ? { state } : {}) });
                        continue;
                    }
                    if (!Protocol.sameCommandCheckpoint(identity.commandCheckpoint, state)) {
                        this.refusals.staleCommand += 1;
                        state = await this.reloadStaleCommand(id);
                        results.push({ ...identity, ok: false, reason: 'stale_command', retryAfterMs: 1000,
                            state });
                        continue;
                    }
                    let result;
                    const operation = request.kind === 'review' ? this.executeReviewCommand(request, identity, sourceCurrent)
                        : this.executeLifecycleCommand(request, identity, sourceCurrent);
                    this.commandInflight.set(id, operation);
                    try { result = await operation; } finally {
                        if (this.commandInflight.get(id) === operation) this.commandInflight.delete(id);
                    }
                    if (!sourceCurrent()) return;
                    if (result?.reason === 'stale_command') this.refusals.staleCommand += 1;
                    const nextState = LifeState.cachedState(request.characterId) || result?.state;
                    results.push({
                        ...identity,
                        ok: result?.ok !== false,
                        reason: result?.reason || (result?.ok === false ? 'command_rejected' : 'command_applied'),
                        ...(result?.ok === false ? { retryAfterMs: Math.max(1000,
                            Number(result.retryAfterMs) || (result.reason === 'missing_spot' ? 30000 : 5000)) } : {}),
                        ...(nextState ? { state: nextState } : {})
                    });
                } catch (error) {
                    if (!sourceCurrent()) return;
                    DiagnosticConfig.developerDiagnostics && (this.counters.commandErrors += 1);
                    const state = LifeState.cachedState(request.characterId);
                    results.push({ ...identity, ok: false, reason: error?.message || 'command_error', retryAfterMs: 5000,
                        ...(state ? { state } : {}) });
                }
                await yieldToLoop();
            }
            if (!sourceCurrent()) return;
            // Each request answered once, in order.
            requests.forEach(({ request }, index) => request.kind === 'review' && this.countReview(request, results[index]));
            this.postCollections('command_ack', { results }, message.msgId);
            // A refused review ran no plan and its ack made the worker forget it
            // as sent (ColdSimulationKernel.forgetSentPlan): it plans afresh, as
            // after a forced cleanup. A hot or fenced bot plans on its own side.
            requests.forEach(({ request }, index) => {
                const id = Number(request.characterId);
                if (request.kind === 'review' && request.economyPlan && !results[index]?.ok
                    && LifeState.cachedState(id)?.phase === 'cold' && !this.fencedBots.has(id)) this.requestEconomyRefresh(id);
            });
        }).catch((error) => { if (sourceCurrent()) this.recordError(error); });
    }

    // A stale_command answers with the row read back, not the cached copy that
    // refused it: a main write that moved the row past the cache would refuse
    // the next command again. The cached copy when the row is not a far one
    // owned by main (a handoff or lease is published by its owner).
    async reloadStaleCommand(characterId) {
        return await LifeState.reloadRow(characterId).catch(() => null) || LifeState.cachedState(characterId);
    }

    countReview(request, result) {
        this.reviews.sent += 1;
        if (request.economyPlan) this.reviews.plan += 1;
        if (request.buffOffer) this.reviews.buff += 1;
        if (request.training) this.reviews.training += 1;
        if (result?.ok) this.reviews.ok += 1;
        else this.reviews.refused[result?.reason] = (this.reviews.refused[result?.reason] || 0) + 1;
    }

    // A worker command's admission on main: { refused } or { state, owned }.
    // A previous native writer can hold the character beyond the worker
    // lifetime. Own this entire promise and admit the computation only
    // after the existing writer has settled against the current cache.
    async admitWorkerCommand(identity, sourceCurrent) {
        await LifeState.settleWrites([identity.characterId]);
        if (!sourceCurrent()) return { refused: { ok: false, reason: 'stale_worker_source' } };
        const state = LifeState.cachedState(identity.characterId);
        const refusal = reason => ({ refused: { ok: false, reason, retryAfterMs: 1000, ...(state ? { state } : {}) } });
        const staleCommand = async () => ({ refused: { ...refusal('stale_command').refused,
            state: await this.reloadStaleCommand(identity.characterId) } });
        if (this.stopping) return refusal('coordinator_stopping');
        if (!state) return refusal('missing_state');
        if (this.fencedBots.has(identity.characterId) || state.phase !== 'cold') return refusal('hot_handoff_fenced');
        if (!Protocol.sameCommandCheckpoint(identity.commandCheckpoint, state)) return staleCommand();
        const owned = this.commandInflight.get(identity.characterId);
        if (!(owned instanceof Promise)) return staleCommand();
        return { state, owned };
    }

    async executeLifecycleCommand(request, identity, sourceCurrent) {
        const { refused, state, owned } = await this.admitWorkerCommand(identity, sourceCurrent);
        if (refused) return refused;
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

    // The far bot's own actions after its commit, in this order: improvement
    // and the worker's economy plan (its standing bids corrected after it), the
    // buff it bought, its class training. Admitted once on the commit's
    // checkpoint; each step then validates the row inside its own writer (the
    // plan's writes move the revision), so the guard is only the source.
    async executeReviewCommand(request, identity, sourceCurrent) {
        const id = identity.characterId;
        const admitted = await this.admitWorkerCommand(identity, sourceCurrent);
        if (admitted.refused) return admitted.refused;
        let state = admitted.state;
        const beforeWrite = () => {
            if (!sourceCurrent() || this.stopping || this.commandInflight.get(id) !== admitted.owned)
                throw Error('cold_postcommit_source_retired');
        };
        const trained = { done: false };
        if (request.economyPlan) {
            const decision = await this.step('improvement', id, () => this.economyDecisions.decided(state));
            // Native moves publish a new timestamp. Hold the worker's one
            // decision across this plan exactly as the town command does.
            this.economyDecisions.hold(id, decision);
            const preparedState = state;
            try {
                state = await this.step('improvement', id, () => this.reviewCommittedEconomy(state, beforeWrite, decision || null, trained)) || state;
                const applied = await this.step('economyPlan', id, () => AfkMarket
                    .executePlan(state, request.economyPlan,
                        { beforeWrite, preparedState, step: work => this.step('economyPlan', id, work) }));
                state = LifeState.cachedState(id) || applied?.state || state;
                if (applied?.buyPending) this.requestEconomyRefresh(id);
            } finally {
                this.economyDecisions.release(id);
            }
            // The plan may have just started a trip or changed the money packet.
            await this.step('boardLimits', id, async () => {
                const checked = await AfkMarket
                    .reviewPurchaseLimits(state, { beforeWrite });
                state = checked.state || state;
            });
        }
        if (request.buffOffer) await this.step('buff', id, () => ColdBuffService
            .applyOffer(request.buffOffer, { beforeWrite }));
        // Hunts and party rewards can raise a level without any market work.
        // Train after the prepared actions so their checked revision holds.
        if (request.training && !trained.done) state = await this.step('training', id, () => LifeState.reviewTrainingAfterCommit(
            LifeState.cachedState(id) || state, { beforeWrite })) || state;
        return { ok: true, state: LifeState.cachedState(id) || state };
    }

    async fenceBot(characterId, timeoutMs = 500) {
        const id = Number(characterId);
        this.economyDecisions.forget(id);
        EconomyContext.forget(id);
        if (!this.worker || !this.ready) return { ok: true, reason: 'worker_not_ready' };
        const worker = this.worker, epoch = this.workerEpoch;
        this.fencedBots.add(id);
        DiagnosticConfig.developerDiagnostics && (this.counters.fences += 1);
        const commitAcks = new Set();
        const captureCommitAcks = () => {
            for (const [ownerId, held] of this.commitAcknowledgements) {
                if (ownerId === id || held.memberIds?.includes(id)) commitAcks.add(held.promise);
            }
        };
        // The member may already be acked while its leader's deferred work
        // still precedes handoff. Keep those exact promises across both waits.
        captureCommitAcks();
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
                this.handleProposalBatch({ payload: { proposals: [{ ...fenced.proposal, priority: 'P0' }] } }, worker, epoch);
            }
            // A proposal can arrive before the fence reply, including in it.
            captureCommitAcks();
            const command = this.commandInflight.get(id);
            if (command) await Promise.race([command.catch(() => null), wait(timeoutMs)]);
            await this.queue.flushCharacter(id);
            await Promise.all(commitAcks);
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
        const now = Date.now();
        // While the main thread itself stood still (the Mac slept, a long pause)
        // it could receive no heartbeat, so that time is no evidence against the worker.
        const stalled = this.lastWatchdogAt ? now - this.lastWatchdogAt - 1000 : 0;
        this.lastWatchdogAt = now;
        if (stalled > 1000) this.lastHeartbeatAt = Math.min(now, this.lastHeartbeatAt + stalled);
        const age = now - this.lastHeartbeatAt;
        if (!this.ready) {
            // Boot (module load, datapack load, catalog transfer, init) sends no heartbeat and
            // slows with the Mac's load ('running after N ms boot'); a restart would only boot again.
            const bootLimit = Math.max(10000, Number(Config.coldWorkerBootMs) || 60000);
            if (age > bootLimit) this.terminateWorker('watchdog_boot', age, bootLimit);
            return;
        }
        if (age <= Math.max(5000, Number(Config.coldWorkerUnhealthyMs) || 5000)) {
            this.setPauseReason('heartbeat_stale', false);
            return;
        }
        this.setPauseReason('heartbeat_stale', true, { age });
        const deadLimit = Math.max(10000, Number(Config.coldWorkerDeadMs) || 10000);
        if (age > deadLimit) this.terminateWorker('watchdog_dead', age, deadLimit);
    }

    // Every kill main decides is logged before it happens and named again by the exit line;
    // an exit with no cause set is the worker's own (crash, OOM, resourceLimits).
    terminateWorker(cause, ageMs = null, limitMs = null) {
        if (!this.worker || this.terminateCause) return;
        this.terminateCause = cause;
        utils.infoWarn('ColdWorker', 'terminating the worker: %s, heartbeat age %s ms (limit %s ms), last message %s, restarts so far %d',
            cause, ageMs === null ? '-' : ageMs, limitMs === null ? '-' : limitMs, this.lastWorkerMessage || 'none', this.restartCount);
        this.worker.terminate().catch(() => null);
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
        // The worker limit follows sustained lag only. The raw max above (the latest 1 s reading, or the same reading
        // held 5 s in schedulerState) dropped the limit 32 -> 2 on one GC or burst task: 14% of summaries at 2 on
        // 2026-10-14 (L118). Early-flush admission and the governor still read the raw lagMs returned below.
        const limitLagMs = Number(Metrics.sustainedEventLoopLag?.() || 0);

        if (abortMs > 0 && limitLagMs >= abortMs) {
            maxInFlight = lagLimit;
        } else if (throttleMs > 0 && limitLagMs > throttleMs) {
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
        DiagnosticConfig.developerDiagnostics && (this.counters.workerErrors += 1);
        this.recordError(error);
    }

    onWorkerExit(code, worker = this.worker, epoch = this.workerEpoch) {
        if (this.worker !== worker || this.workerEpoch !== epoch) return;
        for (const held of this.commitAcknowledgements.values()) held.resolve(false);
        this.commitAcknowledgements.clear();
        for (const [id, held] of this.commandInflight) {
            const preparation = held.meetingToken ? held : held.meetingPending;
            if (preparation) this.finishMeetingPreparation(id, preparation, null, Error('trade_meeting_worker_exited'));
        }
        this.stopDiagnosticSelection?.();
        this.stopDiagnosticSelection = null;
        this.cancelSafety();
        Metrics.clearColdSafetyEpoch(epoch);
        this.economyDecisions.clear();
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
        // A run that stayed up 30 s after loading its world was healthy: back off from the first delay again.
        if (this.loadedAt && Date.now() - this.loadedAt > 30000) this.restartCount = 0;
        this.loadedAt = 0;
        const delays = [1000, 2000, 5000, 10000, 30000];
        const restartDelay = delays[Math.min(this.restartCount, delays.length - 1)];
        this.restartCount += 1;
        DiagnosticConfig.developerDiagnostics && (this.counters.workerRestarts += 1);
        utils.infoWarn('ColdWorker', 'worker exited code=%d cause=%s last message %s; restarting in %dms',
            Number(code || 0), this.terminateCause || 'worker_own_exit', this.lastWorkerMessage || 'none', restartDelay);
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
        this.stopDiagnosticSelection?.();
        this.stopDiagnosticSelection = null;
        this.cancelSafety();
        for (const held of this.commitAcknowledgements.values()) held.resolve(false);
        this.commitAcknowledgements.clear();
        this.economyDecisions.clear();
        if (!this.started) return { stopped: true };
        this.stopping = true;
        if (this.pvpEncounterTimer) clearInterval(this.pvpEncounterTimer);
        await invoke('GameServer/Bot/Population/PvpEncounterRuntime').stop();
        await this.competitionActions.stop();
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        if (this.reconcileTimer) clearInterval(this.reconcileTimer);
        if (this.snapshotContinuationTimer) clearTimeout(this.snapshotContinuationTimer);
        if (this.historyCleanupTimer) clearInterval(this.historyCleanupTimer);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.watchdogTimer = null;
        this.reconcileTimer = null;
        this.snapshotContinuationTimer = null;
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
        await Promise.race([Promise.allSettled([...this.heldAcks.values()].map((held) => held.ack)), wait(10000)]);
        await Promise.race([this.commandTail.catch(() => null), wait(10000)]);
        await Promise.race([this.historyCleanupInFlight || Promise.resolve(), wait(10000)]).catch(() => null);
        this.historyCleanupInFlight = null;
        if (worker) await worker.terminate().catch(() => null);
        Metrics.clearColdSafetyEpoch(epoch);
        if (this.worker === worker) this.worker = null;
        if (this.workerEpoch !== epoch) return { stopped: true, drained, queue };
        this.started = false;
        return { stopped: true, drained, queue };
    }

    // Why a due bot has not stepped, from what this thread owns: its lifecycle
    // command still runs, a hot handoff fences it, or the worker has not
    // claimed it; the heartbeat says whether the worker's slots are full.
    // How long this leader's commit_ack has waited for its party work (0: not held).
    heldAckAgeMs(characterId) {
        const held = this.heldAcks.get(Number(characterId));
        return held ? Math.max(1, Date.now() - held.startedAt) : 0;
    }

    overdueReason(characterId) {
        const heldMs = this.heldAckAgeMs(characterId);
        if (heldMs) return `held_ack:${Math.round(heldMs / 1000)}s`;
        if (!this.worker || !this.ready) return 'worker_not_ready';
        if (this.commandInflight.has(characterId)) return 'command_inflight';
        if (this.fencedBots.has(characterId)) return 'hot_handoff_fenced';
        const beat = this.lastWorkerSnapshot || {};
        const occupied = Number(beat.inFlight || 0) + Number(beat.commanding || 0);
        const max = Number(this.workerMaxInFlight || 0);
        return `${max > 0 && occupied >= max ? 'worker_full' : 'unclaimed'}:${occupied}/${max || '-'}`;
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
            refusals: { commitRefused: { ...this.refusals.commitRefused },
                staleCommand: this.refusals.staleCommand },
            reviews: { ...this.reviews, refused: { ...this.reviews.refused } },
            heldAcks: this.heldAcks.size,
            ackState: { ...this.ackState },
            soloHolds: invoke('GameServer/Bot/Population/PartyIncomeComparison').soloHoldStats(),
            nearDecisions: { ...this.nearDecisions },
            competitionActions: Config.developerDiagnostics ? this.competitionActions.snapshot() : null,
            economyDecisions: Config.developerDiagnostics ? { hits: this.economyDecisions.hits, misses: this.economyDecisions.misses, held: this.economyDecisions.byId.size } : null,
            partyReviews: Config.developerDiagnostics ? this.partyReviews : null,
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
module.exports.npcPlanningCatalogRows = npcPlanningCatalogRows;
