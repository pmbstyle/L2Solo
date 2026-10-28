'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gear-plan-memo-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
// A context holds only by its event proof, which needs the warehouse rows
// and a recompute generation; without them every request builds anew.
const generation = Generation.metadata();
Warehouse.useRowSource(() => null, () => true);
Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
const board = new BoardIndex(), spots = [];
const deps = { spots, timestamp: 1e12, board };
const fresh = { status: 'active', strategy: 'market', target: { selfId: 2, slot: 7 }, market: { price: 1 } };
function preparedEconomyFor(state) {
    const economy = Economy.forState(state, deps);
    economy.network = { ...economy.network, focus: ['probe'],
        queue: [{ key: 'probe', funded: true, object: { itemId: 2, slot: 7 } }],
        activity: { rootKey: 'probe', key: 'probe-market', activity: 'shopping' } };
    return economy;
}
const original = { ...Planner };
let calls = 0;
try {
    Object.assign(Planner, { combatReadiness: () => ({ hasWeapon: true }), replanContextFor: () => ({ routeCurrent: true }),
        clanGoalPlanLocked: () => false, planFor: () => { calls++; return fresh; },
        shouldFinishPreviousPlan: () => false, finalizePlan: (_state, _previous, raw) => raw });
    for (let id = 1; id <= 50; id++) {
        const base = { characterId: id, level: 30, adena: 1000, phase: 'cold', activity: 'hunting',
            stats: { classId: 0 }, inventory: {}, loc: { locX: 0, locY: 0 }, timing: {} };
        const context = Economy.forState(base, deps);
        // The bot publishes the build's decision; a later review of that state holds it.
        const state = { ...base, stats: { ...base.stats, ...context.statsPacket } };
        const options = { spots, timestamp: deps.timestamp, planningOptions: { board } };
        const first = Selection.selectAcquisitionPlan(state, null, { ...options, preparedEconomy: preparedEconomyFor(state) });
        const memo = context.gearPlanMemo;
        assert.ok(memo, 'the context owns its gear memo');
        assert.equal(first.economy.plan, context.plan);
        assert.deepEqual(Selection.selectAcquisitionPlan(state, null,
            { ...options, preparedEconomy: preparedEconomyFor(state) }).acquisitionPlan, first.acquisitionPlan);
        assert.equal(calls, id, 'one planner call per unchanged context/key');
        assert.equal(context.gearPlanMemo, memo);
    }
    assert.equal(Economy.size().context, 50);
    Economy.reset();
    assert.equal(Economy.size().context, 0);
    // A fresh review cannot recover a previous module-level per-bot result.
    const state = { characterId: 1, level: 30, adena: 1000, phase: 'cold', activity: 'hunting',
        stats: { classId: 0 }, inventory: {}, loc: { locX: 0, locY: 0 }, timing: {} };
    const context = Economy.forState(state, deps);
    assert.equal(context.gearPlanMemo, undefined);
    Selection.selectAcquisitionPlan(state, null, { spots, timestamp: deps.timestamp,
        planningOptions: { board }, preparedEconomy: preparedEconomyFor(state) });
    assert.equal(calls, 51, 'reset releases the memo along with its context');
    Economy.forget(1);
    assert.equal(Economy.size().context, 0);
    const previous = { status: 'active', strategy: 'luxury_exchange', target: { selfId: 76, slot: 7 },
        exchange: { kind: 'luxury_exchange' }, materials: [{ selfId: 1458, amount: 12 }] };
    const bridgeState = { ...state, characterId: 2, level: 40, stats: { classId: 0, equipmentPlan: previous },
        inventory: { 1458: { selfId: 1458, amount: 20, stackable: true } } };
    Planner.combatReadiness = () => ({ hasWeapon: false });
    Planner.npcEquipmentBridgePlan = () => ({ status: 'active', strategy: 'npc', weaponBridge: true,
        target: { selfId: 129, slot: 7 } });
    const contextBridge = Economy.forState(bridgeState, deps);
    contextBridge.network = { ...contextBridge.network, focus: ['C-weapon'],
        queue: [{ key: 'C-weapon', funded: true, object: { itemId: 76, slot: 7 } }],
        activity: { rootKey: 'C-weapon', key: 'C-market', activity: 'shopping' } };
    const selected = Selection.selectAcquisitionPlan(bridgeState, previous, {
        spots, timestamp: deps.timestamp, planningOptions: { board }, preparedEconomy: contextBridge }).acquisitionPlan;
    assert.equal(selected.target.selfId, 129, 'the executable goal buys the D bridge');
    assert.equal(selected.inputPreparation?.target.selfId, 76, 'normal selection retains the later C goal');
    const transported = JSON.parse(JSON.stringify({ ...bridgeState,
        stats: { ...bridgeState.stats, equipmentPlan: selected } }));
    assert.equal(invoke('GameServer/Bot/Economy/ItemDisposition').retainedEquipmentAmounts(transported)[1458], 12,
        'the C input ownership survives saved state serialization');
    console.log('test_gear_plan_memo: ok');
} finally {
    Object.assign(Planner, original); Warehouse.useRowSource(null);
    if (generation) Generation.configure(generation);
    fs.rmSync(directory, { recursive: true, force: true }); }
process.exit(0);
