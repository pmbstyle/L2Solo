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
const board = new BoardIndex(), spots = [];
const deps = { spots, timestamp: 1e12, board };
const fresh = { status: 'active', strategy: 'market', target: { selfId: 2, slot: 7 }, market: { price: 1 } };
const original = { ...Planner };
let calls = 0;
try {
    Object.assign(Planner, { combatReadiness: () => ({ hasWeapon: true }), replanContextFor: () => ({}),
        clanGoalPlanLocked: () => false, planFor: () => { calls++; return fresh; },
        shouldFinishPreviousPlan: () => false, finalizePlan: (_state, _previous, raw) => raw,
        withMaterialFarmEffort: plan => plan });
    for (let id = 1; id <= 50; id++) {
        const state = { characterId: id, level: 30, adena: 1000, phase: 'cold', activity: 'hunting',
            stats: { classId: 0 }, inventory: {}, loc: { locX: 0, locY: 0 }, timing: {} };
        const context = Economy.forState(state, deps);
        context.plan.network = { focus: ['probe'], queue: [{ key: 'probe', funded: true, object: { itemId: 2, slot: 7 } }],
            activity: { rootKey: 'probe', key: 'probe-market', activity: 'shopping' } };
        const options = { spots, timestamp: deps.timestamp, planningOptions: { board } };
        const first = Selection.selectAcquisitionPlan(state, null, options);
        const memo = context.gearPlanMemo;
        assert.ok(memo, 'the context owns its gear memo');
        assert.equal(first.economy.plan, context.plan);
        assert.deepEqual(Selection.selectAcquisitionPlan(state, null, options).acquisitionPlan, first.acquisitionPlan);
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
    context.plan.network = { focus: ['probe'], queue: [{ key: 'probe', funded: true, object: { itemId: 2, slot: 7 } }],
        activity: { rootKey: 'probe', key: 'probe-market', activity: 'shopping' } };
    Selection.selectAcquisitionPlan(state, null, { spots, timestamp: deps.timestamp, planningOptions: { board } });
    assert.equal(calls, 51, 'reset releases the memo along with its context');
    Economy.forget(1);
    assert.equal(Economy.size().context, 0);
    console.log('test_gear_plan_memo: ok');
} finally { Object.assign(Planner, original); fs.rmSync(directory, { recursive: true, force: true }); }
process.exit(0);
