'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const spots = require('./helpers/wishSectionSpots')();
const timestamp = 1800000000000;
const state = { characterId: 92089, level: 30, inventory: {}, stats: { classId: 0, role: 'dps' } };
let target, source;
for (const item of Data.items) {
    if (!Planner.considerable(item, state) || !Planner.isSlotUpgrade(item, [], Planner.roleFor(state), state.stats.classId)) continue;
    const route = Planner.sourceForItem(item.selfId, spots, state)
        .find(row => Planner.isPlanSourceViableForState(state, { next: row }));
    if (route) { target = item; source = route; break; }
}
assert(source, 'the catalogue supplies a real upgrade and eligible route');
const plan = { status: 'active', strategy: 'direct_drop',
    grade: invoke('GameServer/Bot/AI/PersonalGearProgression').acquisitionRankFor(state),
    plannedForLevel: state.level, startedAt: timestamp, expectedKills: 100,
    rateModelVersion: Planner.RATE_MODEL_VERSION, rateProfileSignature: Planner.rateProfileSignature(),
    target: { selfId: target.selfId, slot: target.etc.slot }, next: { ...source, itemId: target.selfId },
    targetProgress: { npcId: source.npcId, resolves: 0, targetKills: 0 } };
// This unit starts after the wish engine selected an item/drop route. It
// controls that input and the expensive choice, not resource authority,
// source admission, native failure counters or plan finalization. The actual
// worker integration is covered separately by test_wish_sections_worker.
const economy = { statsPacket: {}, network: {
    queue: [{ key: 'gear', object: { itemId: target.selfId, slot: target.etc.slot } }],
    activity: { key: 'drop', activity: 'hunting', kind: 'item', rootKey: 'gear' } } };
const original = { ...Planner }; let choices = 0;
try {
    Planner.npcEquipmentBridgePlan = () => null;
    Planner.bestSourceForPlan = () => null;
    Planner.replacementPlanFor = () => null;
    Planner.planFor = (_state, options) => {
        choices++;
        if (options.failure) {
            assert(options.excludedTargetIds.includes(target.selfId));
            return { status: 'blocked', strategy: 'none', target: null, next: null };
        }
        return plan;
    };
    const withCounter = resolves => ({ ...state, stats: { ...state.stats,
        targetCombat: { populationTargets: { [source.npcId]: { resolves, targetKills: 0 } } } } });
    const opts = { spots, timestamp, preparedEconomy: economy };
    const accepted = Selection.selectAcquisitionPlan(withCounter(0), plan, opts).acquisitionPlan;
    assert(economy.gearPlanMemo);
    const before = choices;
    const held = Selection.selectAcquisitionPlan(withCounter(1), accepted, opts);
    assert.equal(choices, before, 'one ordinary attempt retains the expensive choice');
    assert.deepEqual(held.acquisitionPlan, accepted, 'the selected valid target remains unchanged');
    const failed = Selection.selectAcquisitionPlan(withCounter(Planner.DIRECT_FAILURE_RESOLVE_LIMIT), accepted, opts);
    assert.equal(failed.replanContext.failure.reason, 'combat_unviable');
    assert.equal(choices, before + 1, 'native failure bypasses a warm choice memo');
    assert.equal(failed.acquisitionPlan.target, null);
    const deadline = { ...accepted, recoveryTargets: [{ targetId: target.selfId + 1,
        reason: 'drop_exhausted', until: timestamp + 10 }] };
    const timed = Selection.selectAcquisitionPlan(withCounter(0), deadline, opts).acquisitionPlan;
    const beforeWake = choices;
    Selection.selectAcquisitionPlan(withCounter(0), timed, { ...opts, timestamp: timestamp + 5 });
    assert.equal(choices, beforeWake, 'an unchanged live recovery boundary retains its choice');
    const woke = Selection.selectAcquisitionPlan(withCounter(0), timed, { ...opts, timestamp: timestamp + 11 });
    assert.equal(choices, beforeWake + 1, 'native recovery expiry invalidates the warm choice memo');
    assert.deepEqual(woke.acquisitionPlan.recoveryTargets, []);
    console.log('PASS native acquisition failure overrides warm reuse; ordinary progress retains the goal');
} finally { Object.assign(Planner, original); }

const deferred = { ...plan, status: 'deferred', strategy: 'none', next: null, reason: 'wish_focus',
    plannedForLevel: 20, rateProfileSignature: 'x10:10:10:10',
    recoveryTargets: [{ targetId: target.selfId, reason: 'drop_exhausted', until: timestamp - 1 }],
    levelingRecovery: { until: timestamp - 1, resumeLevel: state.level, resumeExp: 0 } };
const nativeContext = Planner.replanContextFor(state, deferred, timestamp);
const result = Selection.selectAcquisitionPlan(state, deferred, { spots, timestamp,
    preparedEconomy: { statsPacket: {}, network: { queue: [], activity: { activity: 'hunting' } } },
    preparedReplanContext: nativeContext });
assert.deepEqual(result.acquisitionPlan.recoveryTargets, [], 'wish deferral consumes the native expired recovery list');
assert.equal(result.acquisitionPlan.levelingRecovery, undefined);
assert.deepEqual(result.acquisitionPlan.target, deferred.target);
assert.equal(result.acquisitionPlan.startedAt, deferred.startedAt);
assert.equal(result.acquisitionPlan.plannedForLevel, 20);
assert.equal(result.acquisitionPlan.rateProfileSignature, 'x10:10:10:10');
assert.equal(invoke('GameServer/Bot/Economy/DecisionSections').isEmptyWishPlan(result.acquisitionPlan), false,
    'deferred target/history remain structural dependencies');
assert.deepEqual(Selection.deferredWishPlan(result.acquisitionPlan,
    Planner.replanContextFor(state, result.acquisitionPlan, timestamp)), result.acquisitionPlan,
    'native cleanup stabilizes after the one meaningful expiry');
console.log('PASS native deferred wish history cleanup preserves resumable target and historical stamps');
