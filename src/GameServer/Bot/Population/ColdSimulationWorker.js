const { parentPort, workerData } = require('worker_threads');
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
    ['GameServer/Effects/EffectStore', { list: () => [] }],
    ['GameServer/Skills/ChargeLifecycle', { EXPIRY_MS: 600000 }],
    ['GameServer/Bot/AI/BotRaidSafety', {
        isProtectedRaidEntity: (target) => target?.raidBoss === true
            || target?.template?.raidBoss === true
            || String(target?.kind || '').toLowerCase() === 'boss'
            || String(target?.template?.kind || '').toLowerCase() === 'boss'
            || Number(target?.minionBossObjectId || target?.minionBossTemplateId || 0) > 0
    }],
    ['GameServer/Bot/Economy/CraftShopService', {
        CraftStations: [], availableRecipes: () => [], stationRecipes: () => []
    }],
    ['GameServer/Bot/Economy/MarketOpportunity', {
        TOWN_NPC_SELLERS: {}, bestOffer: () => null, npcOffersAll: () => []
    }],
    ['GameServer/World/WorldAreaCatalog', {}],
    ['GameServer/World/Generics/NpcShopBuyLists', { allEntries: () => [] }]
]);

global.invoke = (module) => {
    if (stubs.has(module)) return stubs.get(module);
    if (forbidden.test(String(module || ''))) {
        throw new Error(`cold worker forbidden dependency: ${module}`);
    }
    return originalInvoke(module);
};

const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const LifeStateProjector = invoke('GameServer/Bot/Population/BotLifeState');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Protocol = require('./ColdSimulationProtocol');
const { ColdSimulationKernel, beginRouteTravelState } = require('./ColdSimulationKernel');
const ColdNpcPlanningCatalog = require('./ColdNpcPlanningCatalog');
const forbiddenLoaded = Object.keys(require.cache).filter((filename) => (
    /[\\/]src[\\/]Database\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]World[\\/]World\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Bot[\\/]BotManager\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Network[\\/]/i.test(filename)
));
if (forbiddenLoaded.length) throw new Error(`cold worker loaded forbidden modules: ${forbiddenLoaded.join(', ')}`);

let kernel = null;
let epoch = String(workerData?.workerEpoch || 'cold-worker');
let loopTimer = null;
let flushTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;
let previousElu = performance.eventLoopUtilization();
let planningSpots = [];
let planningNpcOfferRows = [];
let planningNpcCatalog = ColdNpcPlanningCatalog.createLookup();
let planningOccupancyCache = null;
let planningOccupancyCachedAt = 0;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

function currentPlanningOccupancy(timestamp = Date.now()) {
    if (planningOccupancyCache && timestamp - planningOccupancyCachedAt < 1000) {
        return planningOccupancyCache;
    }
    const states = kernel
        ? [...kernel.states.values()].map((entry) => entry?.state).filter(Boolean)
        : [];
    planningOccupancyCache = SpotProfiles.occupancySnapshot(planningSpots, states);
    planningOccupancyCachedAt = timestamp;
    return planningOccupancyCache;
}

function send(type, payload = {}, msgId = null) {
    const message = Protocol.envelope(type, epoch, payload, msgId);
    const valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch });
    if (!valid.ok) {
        if (type !== 'fault') {
            parentPort.postMessage(Protocol.envelope('fault', epoch, {
                reason: `out_${type}_${valid.reason}`,
                bytes: Number(valid.bytes || 0)
            }));
        }
        return false;
    }
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
    kernel = new ColdSimulationKernel({
        resolveSolo: (options) => BackgroundResolver.resolveSolo(options),
        resolveParty: (options) => BackgroundPartyResolver.resolve(options),
        partySession: {
            partySessionMaxMs: Config.partySessionMaxMs,
            partySessionJitterMs: Config.partySessionJitterMs,
            partyMinSize: Config.partyMinSize
        },
        partyMinSize: Config.partyMinSize,
        projectResolve: async (state, result, timestamp) => {
            const projected = await LifeStateProjector.prepareResolve(state, result, {
                persist: false,
                timestamp,
                projectClassProgression: true
            });
            const beforeLevel = Number(state.stats?.classProgressionLevel || 0);
            const beforeClassId = Number(state.stats?.classProgressionClassId ?? state.stats?.classId ?? 0);
            const afterClassId = Number(projected.stats?.classProgressionClassId ?? projected.stats?.classId ?? beforeClassId);
            const progressionChanged = beforeLevel < Number(projected.level || 1) || beforeClassId !== afterClassId;
            const previousTransitions = state.stats?.classTransitions || [];
            const transitions = (projected.stats?.classTransitions || []).slice(previousTransitions.length);
            const skillClasses = [...new Set([beforeClassId, ...transitions, afterClassId].filter(Number.isFinite))];
            const skills = progressionChanged
                ? [...skillClasses.flatMap((classId) => ColdCombatProfile.skillRecordsFromTree(classId, projected.level))
                    .reduce((byId, skill) => byId.set(Number(skill.selfId), skill), new Map()).values()]
                : [];
            return {
                state: projected,
                durable: progressionChanged ? { classId: afterClassId, skills } : null
            };
        },
        planLifecycle: ({ state, context, timestamp }) => {
            const previousPlan = state.stats?.equipmentPlan || null;
            const spots = planningSpots;
            const occupancy = currentPlanningOccupancy(timestamp);
            const npcPlanningOptions = planningNpcCatalog.plannerOptions;
            const replanContext = GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
            const clanGoalLocked = GearAcquisitionPlanner.clanGoalPlanLocked(state, previousPlan);
            const availabilitySource = previousPlan?.status === 'active'
                && ['direct_drop', 'craft'].includes(previousPlan.strategy)
                ? GearAcquisitionPlanner.bestSourceForPlan(state, previousPlan, spots, { occupancy })
                : null;
            const availabilityRouteChanged = availabilitySource && (
                String(availabilitySource.spotId || '') !== String(previousPlan?.next?.spotId || '')
                || Number(availabilitySource.npcId || 0) !== Number(previousPlan?.next?.npcId || 0)
            );
            const availabilityPlan = previousPlan?.status === 'blocked' && !clanGoalLocked
                ? GearAcquisitionPlanner.replacementPlanFor(state, previousPlan, spots, {
                    occupancy,
                    ...replanContext,
                    ...npcPlanningOptions
                })
                : availabilityRouteChanged
                    ? GearAcquisitionPlanner.retargetPlanSource(state, previousPlan, availabilitySource)
                    : previousPlan?.status === 'active'
                    && ['direct_drop', 'craft'].includes(previousPlan.strategy)
                    && !clanGoalLocked
                        ? GearAcquisitionPlanner.replacementPlanFor(state, previousPlan, spots, {
                            occupancy,
                            ...replanContext,
                            ...npcPlanningOptions
                        })
                        : null;
            const reusablePartyRequest = !state.party?.partyId
                && previousPlan?.next
                && !!availabilitySource
                && replanContext.routeCurrent
                && !replanContext.failure
                && state.stats?.partyRequest?.status === 'open'
                && Number(state.stats.partyRequest.reviewAt || 0) > timestamp;
            const upgradedPlan = availabilityPlan || (
                reusablePartyRequest || clanGoalLocked
                    ? previousPlan
                    : GearAcquisitionPlanner.planFor(state, { spots, occupancy, ...replanContext, ...npcPlanningOptions })
            );
            const previousRefresh = previousPlan?.recipeId && !reusablePartyRequest && !clanGoalLocked
                ? GearAcquisitionPlanner.planFor(state, {
                    spots,
                    occupancy,
                    recipeId: previousPlan.recipeId,
                    ...replanContext,
                    ...npcPlanningOptions
                })
                : null;
            const rawPlan = GearAcquisitionPlanner.shouldFinishPreviousPlan(previousPlan, previousRefresh)
                ? { ...previousRefresh, finishBeforeUpgrade: true }
                : upgradedPlan;
            const canFinalizeLockedRoute = clanGoalLocked && availabilityRouteChanged;
            const finalizationContext = canFinalizeLockedRoute
                ? { ...replanContext, allowClanGoalReplan: true }
                : replanContext;
            const preservePreviousPlan = reusablePartyRequest || (clanGoalLocked && !canFinalizeLockedRoute);
            const finalizedPlan = preservePreviousPlan
                ? previousPlan
                : GearAcquisitionPlanner.finalizePlan(state, previousPlan, rawPlan, finalizationContext, timestamp);
            const acquisitionPlan = {
                ...finalizedPlan,
                marketFallback: finalizedPlan.status === 'active' && finalizedPlan.strategy === 'craft'
                    && Number(finalizedPlan.startedAt || timestamp) + 20 * 60 * 1000 <= timestamp
            };
            const reservedSpot = acquisitionPlan?.next?.spotId
                ? spots.find((spot) => String(spot.id) === String(acquisitionPlan.next.spotId))
                : null;
            if (reservedSpot) SpotProfiles.reserveCapacity(occupancy, reservedSpot, [state]);
            const partyRequest = PartyRequestPlanner.partyRequestForPlan(state, acquisitionPlan, timestamp);
            const partyRouteWaiting = !state.party?.partyId
                && (partyRequest?.priority === 'required'
                    || (partyRequest?.status === 'deferred'
                        && (acquisitionPlan.partyNeed === 'required' || acquisitionPlan.requiresParty === true)));
            const plannedPartyFallback = partyRouteWaiting
                ? GearAcquisitionPlanner.safeFallbackForPlan(state, acquisitionPlan, spots, { occupancy })
                : null;
            const plannedFallbackSpot = plannedPartyFallback
                ? spots.find((spot) => String(spot.id) === String(plannedPartyFallback.spotId)) || null
                : null;
            const safePlannedFallback = plannedFallbackSpot
                && LevelingRoutes.isSpotAllowedForState(plannedFallbackSpot, state)
                ? plannedFallbackSpot
                : null;
            const fallbackState = {
                ...state,
                spotId: null,
                stats: Object.fromEntries(Object.entries(state.stats || {})
                    .filter(([key]) => key !== 'equipmentPlan'))
            };
            const fallbackLevel = LevelingRoutes.targetLevelForState(fallbackState);
            const genericFallback = partyRouteWaiting && !safePlannedFallback
                ? LevelingRoutes.bestSpot(spots.filter((spot) => (
                    Number(spot.minLevel || 1) <= fallbackLevel + 4
                    && Number(spot.maxLevel || spot.minLevel || 1) >= fallbackLevel - 4
                )), fallbackState, { occupancy })?.spot || null
                : null;
            const fallbackSpot = safePlannedFallback || genericFallback;
            const partyFallback = safePlannedFallback ? plannedPartyFallback : null;
            const plannedStats = { ...(state.stats || {}), equipmentPlan: acquisitionPlan };
            if (partyRequest) plannedStats.partyRequest = partyRequest;
            else delete plannedStats.partyRequest;
            const plannedState = {
                ...state,
                activity: fallbackSpot && !['traveling', 'shopping', 'merchant', 'crafting', 'dead'].includes(state.activity)
                    ? 'hunting'
                    : state.activity,
                spotId: fallbackSpot ? fallbackSpot.id : state.spotId,
                stats: plannedStats
            };
            const routedState = beginRouteTravelState(plannedState, context?.route, timestamp) || plannedState;
            return {
                previousPlan,
                acquisitionPlan,
                partyRequest,
                partyFallback,
                targetNpcId: partyRouteWaiting ? Number(partyFallback?.npcId || 0) : Number(acquisitionPlan.next?.npcId || 0),
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
    loopTimer = setInterval(() => kernel.tick(), Math.max(5, Number(config.loopIntervalMs) || 20));
    flushTimer = setInterval(() => kernel.flushDue(), Math.max(50, Math.min(250, Number(config.flushTargetMs) || 2000)));
    heartbeatTimer = setInterval(() => {
        const elu = performance.eventLoopUtilization(previousElu);
        previousElu = performance.eventLoopUtilization();
        send('heartbeat', {
            ...kernel.snapshot(),
            heapUsed: process.memoryUsage().heapUsed,
            rss: process.memoryUsage().rss,
            eventLoopUtilization: elu.utilization,
            eventLoopLagP95Ms: Number(eventLoopDelay.percentile(95) / 1e6) || 0,
            eventLoopLagMaxMs: Number(eventLoopDelay.max / 1e6) || 0
        });
        eventLoopDelay.reset();
    }, Math.max(250, Number(config.heartbeatMs) || 1000));
    loopTimer.unref?.();
    flushTimer.unref?.();
    heartbeatTimer.unref?.();
}

async function handle(message) {
    const valid = Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch });
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
                planningNpcCatalog = ColdNpcPlanningCatalog.createLookup(planningNpcOfferRows);
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
    case 'snapshot_page':
        if (!kernel) throw new Error('kernel_not_initialized');
        kernel.upsertMany(payload.rows || []);
        if (payload.ack) {
            send('ready', {
                phase: 'state_loaded',
                characterId: Number(payload.rows?.[0]?.state?.characterId || 0),
                ...kernel.snapshot()
            }, message.msgId);
        } else if (payload.done) send('ready', { phase: 'snapshots_loaded', ...kernel.snapshot() }, message.msgId);
        break;
    case 'claim_ack':
        kernel?.onClaimAck(payload);
        break;
    case 'lease_renewal':
        kernel?.onLeaseRenewal(payload);
        break;
    case 'commit_ack':
        kernel?.onCommitAck(payload);
        break;
    case 'release_ack':
        kernel?.onReleaseAck(payload);
        break;
    case 'command_ack':
        (payload.results || []).forEach((result) => kernel?.completeCommand(result));
        break;
    case 'fence': {
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
    case 'shutdown':
        if (shuttingDown) break;
        shuttingDown = true;
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
