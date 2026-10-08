'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { Worker } = require('node:worker_threads');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Diagnostics = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
const { capture, ColdEconomyDecisions } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const state = { characterId: 17, updatedAt: 100, level: 30, activity: 'hunting', adena: 100,
    stats: { classId: 1, decisionSeq: 2, money: [100, .1, 20, 0] }, inventory: {} };
const economy = { inputKey: 'native:17', network: { demands: new Map(), queue: [], activity: null,
    decisionSeq: 2, activityLeaf: 0 }, projection: { values: new Map() }, watchList: [] };
const native = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const { fnv1a32 } = require('../src/GameServer/Bot/Fnv1a');
const calls = [];
const loaded = { exports: {} };
new Function('require', 'invoke', 'module', fs.readFileSync(path.resolve(__dirname,
    '../src/GameServer/Bot/Population/ColdEconomyPlan.js'), 'utf8'))(name => {
    if (name.endsWith('BoardIndex')) return { SELL: 1 };
    if (name.endsWith('PurchaseFunding')) return native;
    if (name.endsWith('EconomyDiagnostics')) return Diagnostics;
    if (name.endsWith('Fnv1a')) return { fnv1a32 };
    if (name.endsWith('ColdEconomyDecision')) return require('../src/GameServer/Bot/Population/ColdEconomyDecision');
    if (name.endsWith('MarketListingPolicy')) return {
        BOARD_SLOTS: 3, evaluate: () => { calls.push('sale'); return { listings: [{ selfId: 1867, count: 3, price: 4 }] }; },
        traderContext: () => ({}) };
    if (name.endsWith('NeedsEvaluator')) return { evaluate: () => { calls.push('needs');
        return [{ revision: 5, target: { itemId: 391 }, plan: { valueRate: .1, wishKey: 'gear:391', marketTown: 'Giran' } }]; } };
    if (name.endsWith('BuyAdPolicy')) return { linesFor: (state, goal, deps) => {
        calls.push(['bid', deps.money]); return [{ selfId: 391, count: 6, price: 10 }]; } };
    if (name.endsWith('ShotCraftPolicy')) return {};
    throw Error(name);
}, name => {
    if (name.endsWith('MarketTownPolicy')) return { chooseTown: function* () { calls.push('town'); yield 'town'; return { town: 'Giran' }; } };
    if (name.endsWith('CraftShopService')) return { isServiceCrafter: () => false };
    throw Error(name);
}, loaded);
const Plan = loaded.exports;
const original = { performance: global.performance, count: Diagnostics.count, duration: Diagnostics.duration,
    enabled: Diagnostics.enabled, push: Diagnostics.push };
Config.developerDiagnostics = false;
for (const key of ['count', 'duration', 'enabled', 'push']) Diagnostics[key] = () => { throw Error(`off reached ${key}`); };
global.performance = { now: () => { throw Error('off reached diagnostic clock'); } };
const silent = new ColdEconomyDecisions(), offDecision = capture(economy, state);
silent.accept(17, offDecision); assert.strictEqual(silent.decided(state).inputHash, fnv1a32(economy.inputKey));
assert.equal(silent.decided({ ...state, updatedAt: 101 }), null);
assert.equal(silent.hits, null); assert.equal(silent.misses, null); silent.forget(17); silent.clear();
const offPlan = Plan.decide(state, economy, { board: { ownerLines: () => [] } }), offCalls = structuredClone(calls);
Object.assign(Diagnostics, { count: original.count, duration: original.duration, enabled: original.enabled, push: original.push });
Config.developerDiagnostics = true; Config.economyDiagnostics = true; Config.economyDiagnosticsBotIds = '17'; Diagnostics.stop();
let clock = 0; global.performance = { now: () => ++clock };
const rows = []; Diagnostics.push = row => { rows.push(row); return true; };
calls.length = 0;
const iterator = Plan.prepare(state, economy, { board: { ownerLines: () => [] } });
let next; do { next = iterator.next(); clock += 10000; } while (!next.done);
assert.deepEqual(next.value, offPlan); assert.deepEqual(calls, offCalls, 'native evaluations occur once in the same order');
let metrics = Diagnostics.metrics();
assert.equal(metrics.counts['plan_compute:request:unknown'], 1);
assert.equal(metrics.counts['plan_compute:build:unknown'], 1);
assert.equal(metrics.durations.plan_compute.count, 1);
assert.equal(metrics.durations.plan_compute.totalMs, 3, 'three compute slices exclude suspension/wait time');
assert(rows.some(row => row.phase === 'buy_request' && row.planned === 6 && row.unitPrice === 10 && row.budget === 80));
assert(rows.some(row => row.phase === 'plan_compute' && row.reason === 'travel_planned' && row.goalRevision === 5));
const enabled = new ColdEconomyDecisions(), onDecision = capture(economy, state);
assert.deepEqual(onDecision, offDecision, 'diagnostic publication does not alter wire packet');
enabled.accept(17, onDecision); enabled.decided(state); enabled.decided({ ...state, updatedAt: 101 });
enabled.accept(17, onDecision, { settled: [1] }); enabled.decided(state);
enabled.hold(17, onDecision); assert(enabled.decided({ ...state, adena: 0 }));
enabled.forget(17); enabled.decided(state);
metrics = Diagnostics.metrics();
assert.equal(metrics.counts['ready_card:request:unknown'], 5);
assert.equal(metrics.counts['ready_card:hit:same_inputs'], 1);
assert.equal(metrics.counts['ready_card:hit:held_command'], 1);
assert.equal(metrics.counts['ready_card:miss:state_publication'], 1);
assert.equal(metrics.counts['ready_card:miss:stale_card'], 1);
assert.equal(metrics.counts['ready_card:miss:not_published'], 1);
assert.equal(metrics.counts['ready_card:build:decision_pack'], 1);
global.performance = original.performance; Diagnostics.push = original.push;

// The real worker has its own cumulative counts and bounded rings. Publishing
// its metrics never merges them into main or labels card reads wish builds.
(async () => {
    const worker = new Worker(`
        const {parentPort,workerData}=require('node:worker_threads');
        const Config=require(workerData.root+'/src/GameServer/Bot/Population/PopulationConfig');
        Config.developerDiagnostics=true;
        const Diagnostics=require(workerData.root+'/src/GameServer/Bot/Economy/EconomyDiagnostics');
        const {WishNetwork}=require(workerData.root+'/src/GameServer/Bot/Economy/WishNetwork');
        const engine=new WishNetwork();
        const input={actorKey:'character:17',characterId:17,inputKey:'bag:1',roots:[],nodes:[]};
        engine.build(input);engine.build(input);
        parentPort.postMessage(Diagnostics.metrics());
    `, { eval: true, workerData: { root: path.resolve(__dirname, '..') } });
    try {
        const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
        assert.equal(result.thread, 'worker');
        assert.equal(result.counts['network:request:unknown'], 2);
        assert.equal(result.counts['network:build:unknown'], 1);
        assert.equal(result.counts['network:hit:same_inputs'], 1);
        assert.equal(result.durations.network.count, 1);
        assert.equal(Diagnostics.metrics().counts['network:request:unknown'], undefined, 'thread counters remain separate');
    } finally { await worker.terminate(); }
    Config.developerDiagnostics = false; Diagnostics.stop();
    console.log('test_cold_wish_diagnostics: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
