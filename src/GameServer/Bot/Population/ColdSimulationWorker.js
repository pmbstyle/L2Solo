const { parentPort, workerData } = require('worker_threads');
const epoch = String(workerData?.workerEpoch || 'cold-worker');
const CharacterLocationRuntime = require('../../World/CharacterLocationRuntime');
const workerProjectorRole = CharacterLocationRuntime.beginWorkerProjectorRole(epoch);
const path = require('path');
const { performance, monitorEventLoopDelay } = require('perf_hooks');

const srcRoot = path.resolve(__dirname, '../../..');
require(path.join(srcRoot, 'Global'));

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const originalInvoke = global.invoke;
const forbidden = /^(Database|GameServer\/World(?:\/|$)|GameServer\/Bot\/BotManager|GameServer\/Network(?:\/|$)|Server$)/;
const stubs = new Map([
    ['Database', new Proxy({ isReady: () => false }, {
        get(target, property) {
            if (property in target) return target[property];
            return () => Promise.reject(new Error(`cold worker database call forbidden: ${String(property)}`));
        }
    })],
    ['GameServer/Effects/EffectStore', {
        BUFF_LIMIT: 20,
        DEBUFF_RESERVED_SLOTS: 4,
        includedInBuffCount: (effect) => effect?.type !== 'debuff'
            && effect?.type !== 'item_passive'
            && effect?.toggle !== true
            && !['hp_recover', 'life_force_orc'].includes(effect?.stackFamily),
        list: () => []
    }],
    ['GameServer/Skills/ChargeLifecycle', { EXPIRY_MS: 600000 }],
    ['GameServer/Bot/AI/BotRaidSafety', {
        isRaidBoss: (target) => target?.raidBoss === true
            || target?.template?.raidBoss === true
            || String(target?.kind || '').toLowerCase() === 'boss'
            || String(target?.template?.kind || '').toLowerCase() === 'boss',
        isProtectedRaidEntity: (target) => target?.raidBoss === true
            || target?.template?.raidBoss === true
            || String(target?.kind || '').toLowerCase() === 'boss'
            || String(target?.template?.kind || '').toLowerCase() === 'boss'
            || Number(target?.minionBossObjectId || target?.minionBossTemplateId || 0) > 0
    }],
    // The board comes from the 'board' table (boardIndex below); NPC rows from
    // the planning catalog (ColdNpcPlanningCatalog).
    ['GameServer/Bot/Economy/MarketOpportunity', {
        TOWN_NPC_SELLERS: {},
        npcOffersAll: () => [],
        bestOffer: (selfId, options = {}) => require('../Economy/OfferQuery').bestSellOffer(boardReady(), selfId, {
            towns: options.town ? [options.town] : options.towns || null,
            excludeOwner: options.buyerCharacterId,
            budget: options.budget,
            cost: options.cost,
            accept: options.accept
        })
    }],
    // Immutable map boundaries only; no live World, geodata or database access.
    ['GameServer/World/WorldAreaCatalog', { resolve: originalInvoke('GameServer/World/WorldAreaCatalog').resolve }],
    // The game clock is a pure function of the timestamp (cold night bonuses).
    ['GameServer/World/GameTime', originalInvoke('GameServer/World/GameTime')],
    ['GameServer/World/WorldConstants', originalInvoke('GameServer/World/WorldConstants')],
    ['GameServer/World/Generics/NpcShopBuyLists', { allEntries: () => [] }]
]);

global.invoke = (module) => {
    if (stubs.has(module)) return stubs.get(module);
    if (forbidden.test(String(module || ''))) {
        throw new Error(`cold worker forbidden dependency: ${module}`);
    }
    return originalInvoke(module);
};

const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
BotMarketPricing.useNpcOfferSnapshot([]);
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const GearPlanSelection = invoke('GameServer/Bot/AI/GearPlanSelection');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const LifeStateProjector = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const Protocol = require('./ColdSimulationProtocol');
const ColdEconomyDecision = require('./ColdEconomyDecision');
const RequiredPartyFormation = require('./RequiredPartyFormation');
const { ColdCompetitionMonitor } = require('./ColdCompetitionMonitor');
const ColdCompetitionCandidates = require('./ColdCompetitionCandidates');
const { ColdSimulationKernel } = require('./ColdSimulationKernel');
const { beginHuntingTrip } = require('./HuntingTravel');
const ColdNpcPlanningCatalog = require('./ColdNpcPlanningCatalog');
const TableMirror = require('./TableMirror');
const { BoardIndex, recordOf } = require('../../AfkTrade/BoardIndex');
const BoardReviewEvents = require('../Economy/BoardReviewEvents');
const { MarketBuyerWaiters } = require('../Economy/MarketBuyerWaiters');
const SpotIndex = require('../AI/SpotIndex');
const forbiddenLoaded = Object.keys(require.cache).filter((filename) => (
    /[\\/]src[\\/]Database\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]World[\\/]World\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Bot[\\/]BotManager\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Network[\\/]/i.test(filename)
));
if (forbiddenLoaded.length) throw new Error(`cold worker loaded forbidden modules: ${forbiddenLoaded.join(', ')}`);

let kernel = null;
let loopTimer = null;
let flushTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;
let competition = null;
let competitionCandidates = null;
let competitionReady = false;
let safetyStateReady = false;
let leaseProbe = null;
let safetyStateRepairs = 0;
let safetyBoardRepairs = 0;
let previousElu = performance.eventLoopUtilization();
let planningSpots = [];
let planningNpcOfferRows = [];
const tables = new TableMirror({ actorProjectorRole: workerProjectorRole });
const actorSources = require('../../World/CharacterActorSources').native();
const actorOwner = tables.attachStore('actors', actorSources.createStore);
const ColdActorTableReceiver = require('./ColdActorTableReceiver');
const actorTables = new ColdActorTableReceiver({ mirror: tables, owner: actorOwner,
    onResync: names => send('table_resync', { names }) });
// The board's offers, built from the main thread's 'board' table as it changes.
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const boardIndex = new BoardIndex({ groupOf: MarketCounters.counterOf });
const marketEvents = new BoardReviewEvents({ board: boardIndex,
    counter: (key) => MarketCounters.counter(key).deals });
const marketCommands = new Map();
const buyerWaiters = new MarketBuyerWaiters({
    stateFor: id => kernel?.states.get(id)?.state,
    demandsFor: (state, timestamp) => invoke('GameServer/Bot/Economy/MarketDemandIndex').signalsOfState(state, timestamp),
    wake: (id, timestamp) => kernel?.wakeBuyer(id, timestamp) === true
});
const boardFollower = boardIndex.follower();
let boardReplacing = false;
tables.watch('board', {
    reset: () => { boardReplacing = true; boardFollower.reset(); marketEvents.resetBoardCoverage(); },
    put: (key, row) => {
        const previous = boardIndex.records.get(Number(key)) || [];
        boardFollower.put(key, row);
        marketEvents.ownerChanged(recordOf(row).ownerId, { current: false });
        if (!boardReplacing && tables.ready('board')) buyerWaiters.recordChanged(recordOf(row), previous);
    },
    remove: (key) => {
        const ownerId = boardIndex.records.get(Number(key))?.[0]?.ownerId;
        boardFollower.remove(key);
        if (ownerId) marketEvents.ownerChanged(ownerId, { current: tables.ready('board') && tables.ready('market') });
    }
});
tables.watch('market', {
    reset: () => marketEvents.resetCounterHistory(),
    put: (key, row) => {
        if (String(key).startsWith('c:')) marketEvents.counterChanged(String(key).slice(2), Number(row[1]));
    }
});
// The market counters come from the main thread's 'market' table.
MarketCounters.useTable(() => tables.rows('market'));
MarketCounters.useSpots(() => planningSpots);
function boardReady() {
    return tables.ready('board') ? boardIndex : null;
}

function safetyTotals() {
    return { stateRepairs: safetyStateRepairs, boardRepairs: safetyBoardRepairs,
        coverageRepairs: kernel?.stats.orphanRecoveries || 0 };
}

function sendLeasePage() {
    const probe = leaseProbe;
    if (!probe || shuttingDown || !kernel || kernel.stopping || Date.now() >= probe.replyBy) {
        leaseProbe = null; return;
    }
    const page = probe.pages.next();
    const tokens = page.done ? [] : page.value;
    const msgId = Protocol.envelope('lease_renewal_candidates', epoch).msgId;
    // One page remains outstanding. The next page is built only after main
    // acknowledges this one, so native pressure cannot grow a queued inventory.
    probe.waiting = msgId;
    probe.done = page.done;
    probe.tokens = new Map(tokens.map(token => [token.characterId, token]));
    send('lease_renewal_candidates', { requestId: probe.requestId,
        pageIndex: probe.pageIndex++, done: page.done, tokens }, msgId);
}

function safetyPresence(checkpoint) {
    const id = checkpoint.characterId, entry = kernel?.states.get(id);
    const result = { characterId: id, checkpoint, observedCheckpoint: Protocol.safetyCheckpoint(entry?.state),
        workerVersion: kernel?.versions.get(id) || 0,
        normal: { status: 'deferred', reason: 'state_catalog_loading' },
        board: { status: 'deferred', reason: 'state_catalog_loading', coverageVersion: marketEvents.coverageVersion(id) } };
    const gate = (status, reason) => {
        result.normal = { status, reason };
        result.board = { status, reason, coverageVersion: marketEvents.coverageVersion(id) };
        return result;
    };
    if (!kernel || !safetyStateReady) return result;
    if (shuttingDown || kernel.stopping) return gate('deferred', 'worker_shutdown');
    if (checkpoint.phase !== 'cold') return gate('ineligible', 'not_cold');
    if (checkpoint.simulationOwner !== 'legacy_main' || checkpoint.simulationLeaseId !== null
        || checkpoint.simulationLeaseUntil > 0) return gate('deferred', 'native_ownership_active');
    // Native ownership can be ahead of the cached row during ACK processing.
    if (kernel.busy(id) || marketCommands.has(id)) return gate('deferred', 'worker_busy');
    const normalCovered = kernel.hasNormalCoverage(id);
    if (!normalCovered && kernel.hasAcceptedPartyGrant(id)) return gate('deferred', 'partial_party_accepted');
    if (entry && !Protocol.sameSafetyCheckpoint(checkpoint, entry.state)) return gate('deferred', 'checkpoint_changed');
    result.normal = normalCovered ? { status: 'covered', reason: 'normal_schedule' }
        : kernel.paused ? { status: 'deferred', reason: 'worker_paused' }
            : !entry ? { status: 'uncovered', reason: 'missing_state' }
                : kernel.needsNormalSchedule(id) ? { status: 'deferred', reason: 'local_coverage_missing' }
                    : { status: 'ineligible', reason: 'no_normal_schedule' };
    if (!tables.ready('board') || !tables.ready('market')) {
        result.board = { status: 'deferred', reason: 'table_not_ready', coverageVersion: marketEvents.coverageVersion(id) };
    } else if (!entry) {
        result.board = { status: 'deferred', reason: 'state_projection_required', coverageVersion: marketEvents.coverageVersion(id) };
    } else if (marketEvents.pending.has(id) || marketEvents.inFlight.has(id)) {
        const deferred = !marketEvents.ready.has(id) && !marketEvents.inFlight.has(id);
        result.board = { status: deferred ? 'deferred' : 'covered', reason: deferred ? 'intentional_pending' : 'board_event',
            coverageVersion: marketEvents.coverageVersion(id) };
    } else if (kernel.paused) {
        result.board = { status: 'deferred', reason: 'worker_paused', coverageVersion: marketEvents.coverageVersion(id) };
    } else {
        const status = marketEvents.ownerStatus(id), edge = status.behind ? marketEvents.edgeOf(id) : null;
        if (status.behind && edge && marketEvents.lastAcceptedEdge(id) !== edge && kernel.hasAcceptedPartyGrant(id)) {
            result.board = { status: 'deferred', reason: 'partial_party_accepted',
                coverageVersion: marketEvents.coverageVersion(id) };
            return result;
        }
        result.board = { status: !status.priced || !status.behind ? 'ineligible'
            : !edge || marketEvents.lastAcceptedEdge(id) === edge ? 'deferred' : 'uncovered',
        reason: !status.priced ? 'no_priced_lines' : !status.behind ? 'checkpoint_current'
            : !edge ? 'board_edge_unavailable' : marketEvents.lastAcceptedEdge(id) === edge ? 'edge_already_accepted' : 'board_event_absent',
        coverageVersion: marketEvents.coverageVersion(id) };
    }
    return result;
}

function safetyRepair(row) {
    const checkpoint = Protocol.safetyCheckpoint(row.checkpoint), id = checkpoint.characterId;
    let presence = safetyPresence(checkpoint);
    const receipt = (status, reason) => ({ edgeId: row.edgeId, characterId: id, kind: row.kind, status, reason,
        checkpoint, observedCheckpoint: presence.observedCheckpoint, workerVersion: presence.workerVersion,
        boardCoverageVersion: presence.board.coverageVersion });
    if (presence.workerVersion !== row.expectedWorkerVersion) return receipt('stale', 'worker_version_changed');
    if (row.kind === 'board' && presence.board.coverageVersion !== row.expectedBoardCoverageVersion) {
        return receipt('stale', 'board_coverage_changed');
    }
    const coverage = row.kind === 'state' ? presence.normal : presence.board;
    if (coverage.status !== 'uncovered') return receipt(coverage.status, coverage.reason);
    if (row.kind === 'state') {
        if (coverage.reason !== 'missing_state') return receipt('deferred', 'local_safety_owns_schedule');
        const entry = row.entry, state = entry?.state, context = entry?.context;
        const object = value => value && typeof value === 'object' && !Array.isArray(value);
        if (!object(state) || !object(context) || !Object.keys(context).length
            || !object(state.inventory) || !object(state.stats) || !object(state.timing) || !object(state.simulation)) {
            return receipt('deferred', 'projection_unavailable');
        }
        if (!Protocol.sameSafetyCheckpoint(checkpoint, state)) return receipt('stale', 'projection_checkpoint_changed');
        if (!kernel.upsert(entry)) return receipt('stale', 'projection_not_accepted');
        marketEvents.rearm(id);
        marketEvents.ownerChanged(id, { current: tables.ready('board') && tables.ready('market') });
        presence = safetyPresence(checkpoint);
        if (!Protocol.sameSafetyCheckpoint(presence.observedCheckpoint, checkpoint)) return receipt('stale', 'checkpoint_changed');
        safetyStateRepairs++;
        return receipt('accepted', 'state_delivery_restored');
    }
    if (kernel.hasAcceptedPartyGrant(id)) return receipt('deferred', 'partial_party_accepted');
    const edge = marketEvents.edgeOf(id);
    if (!edge || marketEvents.lastAcceptedEdge(id) === edge) return receipt('deferred', 'edge_already_accepted');
    marketEvents.acceptSafetyEdge(id, edge);
    presence = safetyPresence(checkpoint);
    safetyBoardRepairs++;
    return receipt('accepted', 'board_event_restored');
}
let planningNpcCatalog = ColdNpcPlanningCatalog.createLookup([], boardReady);
let planningOccupancyCache = null;
let planningOccupancyCachedAt = 0;
// Personas come from the main thread's 'personas' table (BotPersona.loadAll).
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
BotPersona.useRowSource((characterId) => tables.rows('personas').get(characterId));
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

// A changed board counter makes the bot review its own lines. The review
// checkpoints observations even when its standing quote remains best.
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
function reviewMarket(state, timestamp) {
    const board = boardReady();
    if (!board || state?.phase !== 'cold') return null;
    const lines = board.ownerLines(state.characterId);
    if (!lines.length) return null;
    const ctx = MarketPricing.traderContext(state, {
        timestamp, board, persona: BotPersona.of(state),
        npcOffersFor: (selfId) => planningNpcCatalog.offersFor(selfId),
        findSpot: (spotId) => SpotIndex.spotById(planningSpots, spotId)
    });
    const looked = MarketPricing.look(state, lines, ctx);
    if (!looked) return null;
    return looked;
}

function drainMarketEvents() {
    if (!kernel || kernel.paused || shuttingDown || !tables.ready('board') || !tables.ready('market')) return;
    const capacity = Math.max(0, kernel.maxInFlight
        - kernel.claiming.size - kernel.inFlight.size - kernel.commanding.size);
    for (const id of marketEvents.take(Math.min(8, kernel.maxBatch, capacity))) {
        const entry = kernel.states.get(id);
        if (!entry) { marketEvents.defer(id); continue; }
        if (entry.state.phase !== 'cold') { marketEvents.forget(id); continue; }
        if (kernel.busy(id)) { marketEvents.defer(id); continue; }
        const market = reviewMarket(entry.state, Date.now());
        if (!market || !(market.updates?.length || market.reprices?.length || market.withdrawals?.length)) {
            marketEvents.defer(id);
            continue;
        }
        const attempt = kernel.beginCommand(id, 'market_review');
        if (!attempt) { marketEvents.defer(id); continue; }
        const commandId = attempt.commandId;
        marketCommands.set(id, commandId);
        attempt.sent = true;
        if (!send('command_request', { requests: [{ kind: 'market_review', characterId: id,
            commandId, commandCheckpoint: attempt.checkpoint, state: entry.state, context: entry.context, market }] })) {
            marketCommands.delete(id);
            kernel.cancelCommand(id, attempt);
            marketEvents.defer(id);
        }
    }
}

function currentPlanningOccupancy(timestamp = Date.now()) {
    if (planningOccupancyCache && timestamp - planningOccupancyCachedAt < 1000) {
        return planningOccupancyCache;
    }
    planningOccupancyCache = kernel
        ? SpotProfiles.indexedOccupancy(kernel.occupancy, planningSpots)
        : SpotProfiles.occupancySnapshot(planningSpots, []);
    planningOccupancyCachedAt = timestamp;
    return planningOccupancyCache;
}

// payloadBytes: the payload's JSON size when the caller already counted it
// (the kernel's proposal batches); the 256 KB limit is checked against it.
function send(type, payload = {}, msgId = null, payloadBytes = null) {
    const message = Protocol.envelope(type, epoch, payload, msgId);
    const bytes = Number.isFinite(payloadBytes) ? Protocol.envelopeBytes(message, payloadBytes) : null;
    const valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch, bytes });
    if (!valid.ok) {
        if (type !== 'fault') {
            parentPort.postMessage(Protocol.envelope('fault', epoch, {
                reason: `out_${type}_${valid.reason}`,
                bytes: Number(valid.bytes || 0)
            }));
        }
        return false;
    }
    message.bytes = valid.bytes;
    parentPort.postMessage(message);
    return true;
}

function stopTimers() {
    if (loopTimer) clearInterval(loopTimer);
    if (flushTimer) clearInterval(flushTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    loopTimer = null;
    flushTimer = null;
    heartbeatTimer = null;
}

function startKernel(config = {}) {
    if (kernel) return;
    // Use the main process's resolved setting, including programmatic overrides.
    Config.pvpAggression = require('../../Social/PvpAggression').normalize(config.pvpAggression ?? Config.pvpAggression);
    kernel = new ColdSimulationKernel({
        stateSources: LifeStateProjector.passiveWorkerStateSources(workerProjectorRole),
        resolveSolo: (options) => BackgroundResolver.resolveSolo(options),
        resolveParty: (options) => BackgroundPartyResolver.resolve(options),
        partySession: {
            partySessionMaxMs: Config.partySessionMaxMs,
            partyReviewIntervalMs: Config.partyReviewIntervalMs,
            partySessionJitterMs: Config.partySessionJitterMs,
            partyMinSize: Config.partyMinSize
        },
        partyMinSize: Config.partyMinSize,
        equipmentBridgeReason: (state) => GearAcquisitionPlanner.equipmentBridgeReason(state, {
            ...planningNpcCatalog.plannerOptions,
            buyOrderEscrow: kernel.states.get(Number(state.characterId))?.context?.buyOrderEscrow
        }),
        projectResolve: async (state, result, timestamp) => {
            let economy = null, seenKey = null;
            const resolved = await LifeStateProjector.prepareResolve(state, result, {
                persist: false,
                timestamp,
                projectClassProgression: true,
                // Spot crowding, as main gave the same leaf before (L25).
                economyDeps: { occupancy: currentPlanningOccupancy(timestamp) },
                onEconomy: (built, seen) => { economy = built; seenKey = ColdEconomyDecision.stateKey(seen); }
            });
            // Board events submit price observations through market commands.
            const projected = resolved;
            const beforeLevel = Number(state.stats?.classProgressionLevel || 0);
            const beforeClassId = Number(state.stats?.classProgressionClassId ?? state.stats?.classId ?? 0);
            const afterClassId = Number(projected.stats?.classProgressionClassId ?? projected.stats?.classId ?? beforeClassId);
            const progressionChanged = beforeLevel < Number(projected.level || 1) || beforeClassId !== afterClassId;
            // The worker projects the class, but cannot grant tree ranks.
            // Accepted main-owned commits train against actual SP and books.
            const durable = {
                ...(progressionChanged ? { classId: afterClassId } : {}),
                ...(result.soulCrystals?.length ? { soulCrystals: result.soulCrystals } : {})
            };
            return {
                state: projected,
                durable: Object.keys(durable).length ? durable : null,
                buffOffer: require('../Economy/ColdBuffOffer').project(projected,
                    kernel.occupancy.members(projected.spotId, 'physical'), timestamp),
                // Main reads this instead of building the network again.
                ...(economy && projected ? { economyDecision: { ...ColdEconomyDecision.capture(economy, projected), key: seenKey } } : {})
            };
        },
        planPartyRequirement: ({ state, context, timestamp }) => require('./PartyRequirementRefresh').plan(state, {
            spots: planningSpots, occupancy: currentPlanningOccupancy(timestamp), timestamp,
            planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: context?.buyOrderEscrow }
        }),
        planLifecycle: ({ state, context, timestamp }) => {
            const karmaPlan = invoke('GameServer/Bot/Population/ColdKarmaPolicy').plan(state, planningSpots, timestamp);
            if (karmaPlan) return karmaPlan;
            const previousPlan = state.stats?.equipmentPlan || null;
            const spots = planningSpots;
            const occupancy = currentPlanningOccupancy(timestamp);
            const { acquisitionPlan, replanContext, reusablePartyRequest, excludedSpotIds, economy } = GearPlanSelection
                .selectAcquisitionPlan(state, previousPlan, {
                    spots, occupancy, timestamp,
                    planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: context?.buyOrderEscrow }
                });
            const reservedSpot = acquisitionPlan?.next?.spotId
                ? SpotIndex.spotById(spots, acquisitionPlan.next.spotId)
                : null;
            if (reservedSpot) SpotProfiles.reserveCapacity(occupancy, reservedSpot, [state]);
            const partyRequest = PartyRequestPlanner.partyRequestForPlan(state, acquisitionPlan, timestamp);
            const partyRouteWaiting = PartyWaitFallback.waiting(state, acquisitionPlan, partyRequest);
            const partyFallback = partyRouteWaiting
                ? PartyWaitFallback.spotFor(state, acquisitionPlan, spots, { occupancy, excludedSpotIds, timestamp })
                : null;
            const fallbackSpot = partyFallback?.spot || null;
            const plannedStats = { ...(state.stats || {}), equipmentPlan: acquisitionPlan };
            if (partyRequest) plannedStats.partyRequest = partyRequest;
            else delete plannedStats.partyRequest;
            // A waiter that is resting finishes its rest first.
            const plannedState = {
                ...state,
                activity: fallbackSpot
                    && !['traveling', 'shopping', 'merchant', 'crafting', 'dead', 'resting'].includes(state.activity)
                    ? 'hunting'
                    : state.activity,
                spotId: fallbackSpot ? fallbackSpot.id : state.spotId,
                stats: plannedStats
            };
            const routedState = beginHuntingTrip(plannedState, context?.route, timestamp) || plannedState;
            return {
                statsPacket: economy.statsPacket,
                activityPick: economy.network.activity ? { activity: economy.network.activity.activity,
                    spotId: economy.network.activity.spotId, npcId: economy.network.activity.npcId } : null,
                economyDecision: ColdEconomyDecision.capture(economy, routedState),
                previousPlan,
                acquisitionPlan,
                partyRequest,
                targetNpcId: partyRouteWaiting ? Number(partyFallback?.npcId || 0) : Number(acquisitionPlan?.next?.npcId || 0),
                reusablePartyRequest,
                replanFailure: replanContext.failure || null,
                plannedState: routedState
            };
        },
        emit: send,
        maxBatch: config.maxBatch,
        maxInFlight: config.maxInFlight,
        maxAtomicPartySize: config.maxAtomicPartySize,
        flushTargetMs: config.flushTargetMs,
        flushHardMs: config.flushHardMs
    });
    kernel.buyerEvents = buyerWaiters;
    invoke('GameServer/Bot/Economy/EconomyContext').configure({
        board: boardReady,
        buyOrderEscrow: id => kernel.states.get(Number(id))?.context?.buyOrderEscrow || 0,
        spots: () => planningSpots,
        memory: (characterId) => kernel.interactionMemory.snapshot(characterId)
    });
    loopTimer = setInterval(() => {
        if (leaseProbe && (shuttingDown || Date.now() >= leaseProbe.replyBy)) leaseProbe = null;
        drainMarketEvents();
        kernel.tick();
    }, Math.max(5, Number(config.loopIntervalMs) || 20));
    if (Config.coldCompetitionObserveEnabled) {
        const allowed = new Set((DataCache.npcs || []).filter(npc => npc.template?.kind === 'Monster'
            && !invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(npc)).map(npc => Number(npc.selfId)));
        competition = new ColdCompetitionMonitor({
            capacityForSpot: invoke('GameServer/Bot/AI/LevelingRoutes').capacityForSpot,
            personaFor: state => BotPersona.of(state),
            knowledgeFor: (source, persona, key) => persona ? { source, persona, key } : null,
            isTargetAllowed: id => allowed.has(id),
            ownSide: invoke('GameServer/Bot/Population/ColdPvpResolver').ownSide
        });
        competitionCandidates = new ColdCompetitionCandidates({
            records: id => kernel.states.locationIndex.getSource(id, 'state'),
            packets: id => kernel.states.get(id), memory: kernel.interactionMemory,
            monitor: competition, deadlines: kernel, sequence: id => kernel.states.safetyNodes.get(id)?.sequence,
            frameSizing: frame => {
                const report = competition.snapshot();
                const large = Number.MAX_SAFE_INTEGER;
                const outcomes = Object.fromEntries(Object.keys(report.outcomes).map(key => [key, large]));
                const kernelReport = kernel.heartbeatSnapshot();
                const message = Protocol.envelope('heartbeat', epoch, {
                    ...kernelReport, safety: safetyTotals(),
                    // Forecast cooldowns can make a decision alarm the new
                    // head. Include both optional shapes before those effects.
                    queueHead: { ...kernelReport.queueHead, kind: 'normal', alarmKind: 'worker_safety',
                        dueAt: large, overdue: false, current: false },
                    competition: { ...report, events: [],
                        recent: [], frame: { ...frame, events: [] }, at: frame.at, outcomes,
                        scans: large, evaluated: large, pvpIntents: large, activeHunters: large, lastSampleMs: large,
                        deliverySendFailures: large, lastScanEvents: 160, consumedSpotKeys: 32, consumedActorKeys: 128,
                        pendingSpotKeys: large, pendingActorKeys: large, deliveryMode: 'addressed',
                        revenge: { evaluated: large, intents: large, at: frame.at, active: 128, sampledActors: 128, overflow: false } },
                    tables: tables.summary(), heapUsed: large, rss: large,
                    eventLoopUtilization: 1, eventLoopLagP95Ms: large,
                    eventLoopLagMaxMs: large
                }, 'x'.repeat(160));
                return new (require('./ColdCompetitionFrameSizer').ColdCompetitionFrameSizer)(message, report.recent);
            }
        });
        kernel.decisionEvents = competitionCandidates;
    }
    flushTimer = setInterval(() => kernel.flushDue(), Math.max(50, Math.min(250, Number(config.flushTargetMs) || 2000)));
    heartbeatTimer = setInterval(() => {
        if (competitionCandidates && competitionReady && !kernel.paused && !shuttingDown) {
            const started = performance.now();
            competitionCandidates.reviewBatch(Date.now());
            competition.report.lastSampleMs = performance.now() - started;
        }
        const elu = performance.eventLoopUtilization(previousElu);
        previousElu = performance.eventLoopUtilization();
        const heartbeat = {
            ...kernel.heartbeatSnapshot(),
            safety: safetyTotals(),
            competition: competitionCandidates?.snapshot() || null,
            tables: tables.summary(),
            heapUsed: process.memoryUsage().heapUsed,
            rss: process.memoryUsage().rss,
            eventLoopUtilization: elu.utilization,
            eventLoopLagP95Ms: Number(eventLoopDelay.percentile(95) / 1e6) || 0,
            eventLoopLagMaxMs: Number(eventLoopDelay.max / 1e6) || 0
        };
        try {
            if (!send('heartbeat', heartbeat) && competition) {
                competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
            }
        } catch {
            // Main has not admitted this frame. Its exact origin/content stay
            // owned here for the next existing heartbeat, including backpressure.
            if (competition) competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
        }
        eventLoopDelay.reset();
    }, Math.max(250, Number(config.heartbeatMs) || 1000));
    loopTimer.unref?.();
    flushTimer.unref?.();
    heartbeatTimer.unref?.();
}

async function handle(message) {
    const valid = Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch, bytes: message?.bytes });
    if (!valid.ok) {
        send('fault', { reason: valid.reason, msgId: message?.msgId || null });
        return;
    }
    const payload = message.payload || {};
    switch (message.type) {
    case 'catalog_page':
        if (payload.catalog === 'npc_offers') {
            planningNpcOfferRows.push(...(payload.rows || []));
            if (payload.done) {
                BotMarketPricing.useNpcOfferSnapshot(planningNpcOfferRows);
                planningNpcCatalog = ColdNpcPlanningCatalog.createLookup(planningNpcOfferRows, boardReady);
                planningNpcOfferRows = [];
            }
        } else {
            planningSpots.push(...(payload.rows || []));
        }
        break;
    case 'init':
        startKernel(payload.config || {});
        send('ready', {
            phase: 'running',
            pvpAggression: Config.pvpAggression,
            protocolVersion: Protocol.PROTOCOL_VERSION,
            data: {
                items: DataCache.items?.length || 0,
                npcs: DataCache.npcs?.length || 0,
                rewards: DataCache.npcRewards?.length || 0,
                npcEquipmentItems: planningNpcCatalog.itemCount,
                npcEquipmentOffers: planningNpcCatalog.offerCount
            }
        }, message.msgId);
        break;
    case 'table_page': {
        actorTables.apply(payload.tables);
        if (tables.ready('board')) boardReplacing = false;
        break;
    }
    case 'clan_social_page':
        if (!kernel) break;
        for (const snapshot of payload.rows || []) {
            if (kernel.interactionMemory.clanSocial.accept(snapshot)) competitionCandidates?.clanChanged(snapshot.clanId);
        }
        if (payload.memberships) {
            const social = kernel.interactionMemory.clanSocial, previous = social.memberships;
            const active = payload.activeClanIds ? new Set(payload.activeClanIds) : null;
            const removed = active ? [...social.clans.keys()].filter(id => !active.has(id)) : [];
            social.acceptMemberships(payload.memberships, payload.membershipVersion, payload.activeClanIds);
            if (social.memberships !== previous) competitionCandidates?.membershipsChanged(previous, social.memberships, removed);
        }
        break;
    case 'snapshot_page':
        if (!kernel) throw new Error('kernel_not_initialized');
        kernel.upsertMany(payload.rows || []);
        for (const row of payload.rows || []) {
            const id = Number(row.state?.characterId);
            if (marketCommands.has(id) && kernel.commandStartedAt.get(id)?.commandId !== marketCommands.get(id)) {
                marketCommands.delete(id);
            }
            if (!marketCommands.has(id)) marketEvents.rearm(id);
            marketEvents.ownerChanged(id, { current: tables.ready('board') && tables.ready('market') });
        }
        if (payload.initial === true && payload.done === true) safetyStateReady = true;
        if (payload.ack) {
            send('ready', {
                phase: 'state_loaded',
                characterId: Number(payload.rows?.[0]?.state?.characterId || 0),
                ...kernel.heartbeatSnapshot()
            }, message.msgId);
        } else if (payload.done) {
            competitionReady = true;
            send('ready', { phase: 'snapshots_loaded', ...kernel.heartbeatSnapshot() }, message.msgId);
        }
        break;
    case 'worker_presence_request':
        send('worker_presence_ack', { results: payload.rows.map(row => safetyPresence(Protocol.safetyCheckpoint(row))),
            safety: safetyTotals() }, message.msgId);
        break;
    case 'worker_repair_request':
        send('worker_repair_ack', { results: payload.rows.map(safetyRepair), safety: safetyTotals() }, message.msgId);
        break;
    case 'claim_ack':
        kernel?.onClaimAck(payload, message.msgId);
        break;
    case 'lease_renewal_probe':
        if (!kernel || shuttingDown || kernel.stopping || !safetyStateReady || Date.now() >= payload.replyBy) break;
        if (leaseProbe && Date.now() < leaseProbe.replyBy) break;
        leaseProbe = { requestId: message.msgId, replyBy: payload.replyBy, pageIndex: 0,
            pages: kernel.leaseRenewalPages({ replyBy: payload.replyBy }) };
        sendLeasePage();
        break;
    case 'lease_renewal':
        if (leaseProbe?.waiting !== message.msgId || Date.now() >= leaseProbe.replyBy || shuttingDown) break;
        if (payload.renewals.some(result => {
            const token = leaseProbe.tokens.get(result.characterId);
            return !token || token.ownerId !== result.ownerId || token.revision !== result.revision || token.leaseId !== result.leaseId;
        })) break;
        kernel?.onLeaseRenewal(payload);
        if (leaseProbe.done) leaseProbe = null;
        else sendLeasePage();
        break;
    case 'commit_ack':
        for (const result of kernel?.onCommitAck(payload) || []) {
            const id = Number(result.characterId);
            if (marketCommands.has(id)) marketEvents.ownerChanged(id);
            else marketEvents.rearm(id);
        }
        break;
    case 'release_ack':
        for (const result of kernel?.onReleaseAck(payload) || []) {
            const id = Number(result.characterId);
            if (marketCommands.has(id)) marketEvents.ownerChanged(id);
            else marketEvents.rearm(id);
        }
        break;
    case 'command_ack':
        (payload.results || []).forEach((result) => {
            const identity = Protocol.commandIdentity(result);
            if (!identity || typeof result.ok !== 'boolean') return;
            const id = identity.characterId;
            const market = kernel?.commandStartedAt.get(id)?.kind === 'market_review';
            if (market ? marketCommands.get(id) !== result.commandId || result.marketCommandId !== result.commandId
                : result.marketCommandId !== undefined || marketCommands.has(id)) return;
            if (!kernel?.completeCommand(result)) return;
            if (market) marketCommands.delete(id);
            if (result.marketDeferred && result.reason !== 'stale_market_review') marketEvents.deferAfterCommand(id);
            else marketEvents.rearm(id);
        });
        break;
    case 'party_formation_request': {
        const states = kernel
            ? [...kernel.states.values()].map((entry) => entry?.state).filter(Boolean)
            : [];
        send('party_formation_proposal', RequiredPartyFormation.proposalFromStates(states, payload), message.msgId);
        break;
    }
    case 'fence': {
        marketCommands.delete(Number(payload.characterId));
        marketEvents.defer(Number(payload.characterId));
        const result = kernel?.fence(payload.characterId) || { characterId: Number(payload.characterId), proposal: null, token: null };
        send('fence_ack', result, message.msgId);
        break;
    }
    case 'pause':
        kernel?.pause();
        break;
    case 'resume':
        kernel?.resume();
        break;
    case 'throttle':
        kernel?.setMaxInFlight(payload.maxInFlight);
        break;
    case 'competition_release':
        if (Object.hasOwn(payload, 'receipt') && !competitionCandidates?.receipt(payload.receipt)) break;
        competitionCandidates?.releaseForecasts(payload.events || []);
        break;
    case 'shutdown':
        leaseProbe = null;
        marketCommands.clear();
        marketEvents.clear();
        buyerWaiters.clear();
        if (shuttingDown) break;
        shuttingDown = true;
        actorTables.stop();
        competitionCandidates?.stop();
        stopTimers();
        eventLoopDelay.disable();
        send('drained', await kernel?.shutdown() || {}, message.msgId);
        parentPort.close();
        break;
    default:
        send('fault', { reason: 'unhandled_message', type: message.type }, message.msgId);
        break;
    }
}

parentPort.on('message', (message) => {
    Promise.resolve(handle(message)).catch((error) => {
        send('fault', { reason: error?.message || 'worker_message_error', stack: error?.stack || null, msgId: message?.msgId || null });
    });
});

send('ready', {
    phase: 'loaded',
    protocolVersion: Protocol.PROTOCOL_VERSION,
    forbiddenDependencies: forbiddenLoaded.length
});
