const assert = require('assert');

require('../src/Global');

// U1 (decided 2026-10-02 with G2): the cold worker, the main-thread resolve
// and the party requirement refresh choose a gear plan through one function,
// GearPlanSelection.selectAcquisitionPlan. Three behaviours the main thread
// gained by it are pinned here: spots under backoff are excluded from the
// source search, a blocked plan is replaced (its failed target excluded), and
// a clan raid plan keeps its raid sources.
const DataCache = invoke('GameServer/DataCache');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const GearPlanSelection = invoke('GameServer/Bot/AI/GearPlanSelection');

DataCache.init();

const at = 1800000000000;
const state = { characterId: 9400001, level: 30, inventory: {}, stats: { classId: 0, role: 'dps' } };
const calls = [];
const record = (name, result) => (...args) => { calls.push({ name, args }); return result; };
const fresh = { status: 'active', strategy: 'market', target: { selfId: 2, slot: 7 }, market: { price: 1, sourceType: 'npc' } };

function stubPlanner() {
    calls.length = 0;
    Object.assign(Planner, {
        replanContextFor: (s, plan) => ({ failure: plan?.status === 'blocked' ? { targetId: 69 } : null,
            excludedTargetIds: plan?.status === 'blocked' ? [69] : [], recoveryTargets: [], routeCurrent: true }),
        npcEquipmentBridgePlan: () => null,
        clanGoalPlanLocked: () => false,
        bestSourceForPlan: record('bestSourceForPlan', null),
        replacementPlanFor: record('replacementPlanFor', fresh),
        retargetPlanSource: record('retargetPlanSource', fresh),
        planFor: record('planFor', fresh),
        fundedMarketPlanForTarget: () => null,
        shouldFinishPreviousPlan: () => false,
        finalizePlan: (s, previous, raw) => raw,
        withMaterialFarmEffort: (plan) => plan
    });
}

// MVP-1: a gear wish without a prepared route is never the activity; these
// checks pin the selection once the economy has chosen gear.
function gearEconomy() {
    const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(state, { spots: [], timestamp: at });
    const gear = economy.network.queue.find(wish => wish.object?.slot);
    assert(gear, 'fixture: the economy has a gear wish');
    return { ...economy, network: { ...economy.network,
        activity: { ...economy.network.activity, activity: 'hunting', kind: 'money', rootKey: gear.key } } };
}

function run() {
    const original = { ...Planner };
    const excluded = SpotRiskPolicy.excludedSpotIdsForStates;
    try {
        // Backoff spots are excluded from the plan's source search.
        stubPlanner();
        SpotRiskPolicy.excludedSpotIdsForStates = () => new Set(['backoff-spot']);
        GearPlanSelection.selectAcquisitionPlan(state, null, { spots: [], timestamp: at, preparedEconomy: gearEconomy() });
        const planned = calls.find((call) => call.name === 'planFor');
        assert(planned?.args[1].excludedSpotIds.has('backoff-spot'), 'a spot under backoff is excluded from the source search');
        SpotRiskPolicy.excludedSpotIdsForStates = excluded;

        // A blocked plan is replaced, its failed target excluded.
        stubPlanner();
        const blocked = { status: 'blocked', strategy: 'direct_drop', target: { selfId: 69, slot: 7 }, next: { npcId: 20001 } };
        const replaced = GearPlanSelection.selectAcquisitionPlan(state, blocked, { spots: [], timestamp: at, preparedEconomy: gearEconomy() });
        const replacement = calls.find((call) => call.name === 'replacementPlanFor');
        assert(replacement, 'a blocked plan is replaced');
        assert.deepStrictEqual(replacement.args[3].excludedTargetIds, [69], 'the replacement excludes the failed target');
        assert.strictEqual(replaced.acquisitionPlan.target.selfId, 2);

        // A clan raid plan keeps its raid sources.
        stubPlanner();
        const raid = { status: 'active', strategy: 'direct_drop', target: { selfId: 70, slot: 7 },
            next: { npcId: 25001, sourceKind: 'raid' }, clanGoal: { clanId: 6000001, goalKey: 'clan-equipment:6000001:1:70:7' } };
        GearPlanSelection.selectAcquisitionPlan(state, raid, { spots: [], timestamp: at });
        const source = calls.find((call) => call.name === 'bestSourceForPlan');
        assert.strictEqual(source?.args[3].allowRaidSources, true, 'a clan raid plan searches raid sources');
        const raidPlan = calls.find((call) => ['replacementPlanFor', 'planFor'].includes(call.name));
        assert.strictEqual(raidPlan?.args.at(-1).allowRaidSources, true, 'its replacement keeps raid sources');
    } finally {
        Object.assign(Planner, original);
        SpotRiskPolicy.excludedSpotIdsForStates = excluded;
    }
    console.log('Gear plan selection decided behaviour checks passed');
}

run();
