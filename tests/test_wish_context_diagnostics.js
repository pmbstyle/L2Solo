'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-context-diagnostics-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const state = { characterId: 901, updatedAt: 10, level: 20, phase: 'cold', activity: 'hunting', adena: 1000,
    stats: { classId: 1, decisionSeq: 2, activityLeaf: 0 }, inventory: { 1: { selfId: 1, amount: 1, equipped: true, slot: 7 } },
    currentRegion: 'Giran', timing: {}, simulation: { revision: 3 },
    loc: { locX: 80000, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
const deps = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(),
    timestamp: 1e12, caller: 'native_context_fixture', buyOrderEscrow: 50 };
const original = { performance: global.performance, count: Diagnostics.count, duration: Diagnostics.duration,
    enabled: Diagnostics.enabled, push: Diagnostics.push };
Config.developerDiagnostics = false; Config.economyDiagnostics = true; Economy.reset(); Economy.resetCounters();
for (const key of ['count', 'duration', 'enabled', 'push']) Diagnostics[key] = () => { throw Error(`off reached ${key}`); };
global.performance = { now: () => { throw Error('off reached diagnostic clock'); } };
const off = Economy.forState(state, deps);
assert.strictEqual(Economy.forState(state, deps), off);
assert.equal(Economy.summary().mainColdForState, null, 'disabled readers expose unknown rather than zero');
Economy.forgetContext(901); Economy.reset();
Object.assign(Diagnostics, { count: original.count, duration: original.duration, enabled: original.enabled, push: original.push });
global.performance = original.performance;
Config.developerDiagnostics = true; Config.economyDiagnosticsBotIds = '901'; Diagnostics.stop();
const records = []; Diagnostics.push = row => { records.push(row); return true; };
const on = Economy.forState(state, deps);
assert.deepEqual(on.network, off.network, 'full wishes, options, funding, selected activity and rolls stay identical');
assert.deepEqual(on.statsPacket, off.statsPacket);
assert.strictEqual(Economy.forState(state, deps), on);
const clone = structuredClone(state); clone.updatedAt++;
assert.strictEqual(Economy.forState(clone, deps), on, 'main technical publication still reuses the same economic card');
let metrics = Diagnostics.metrics();
assert.equal(metrics.counts['context:request:unknown'], 3);
assert.equal(metrics.counts['context:hit:same_inputs'], 2);
assert.equal(metrics.counts['context:build:not_retained'], 1);
assert.equal(metrics.counts['provider:request:unknown'], 1);
assert.equal(metrics.counts['provider:build:context_miss'], 1);
assert.equal(metrics.durations.context.count, 1); assert.equal(metrics.durations.provider.count, 1);
const needs = records.filter(row => row.phase === 'wish_need'); assert.equal(needs.length, 2);
for (const row of needs) {
    const kind = row.wishKey.slice('stock:'.length), stock = on.stock(kind);
    assert.equal(row.target, stock.target); assert.equal(row.owned, stock.current);
    assert.equal(row.missing, stock.missing); assert.equal(row.requested, stock.missing);
    assert.equal(row.unitPrice, stock.unitPrice); assert.equal(row.wallet, 1000);
}
const context = records.find(row => row.phase === 'wish_context');
assert.equal(context.wallet, 1000); assert.equal(context.escrow, 50);
assert.equal(context.revision, 3);
Economy.forState({ ...state, adena: 1100 }, deps);
assert.equal(Diagnostics.metrics().counts['context:miss:input_dependency_changed'], 1);
Economy.setPlanningContexts(64);
assert.equal(Economy.size().context, 0);
assert.equal(Diagnostics.metrics().counts['context:eviction:planning_capacity'], 1);
Economy.setPlanningContexts(0);

// Run the same native context module with its worker identity safety branch.
// No copied evaluator, worker runtime, SQL or alternate economy policy.
const filename = require.resolve('../src/GameServer/Bot/Economy/EconomyContext');
const workerContext = new Module(filename, module); workerContext.filename = filename;
workerContext.paths = Module._nodeModulePaths(path.dirname(filename));
const nativeRequire = workerContext.require.bind(workerContext);
workerContext.require = name => name === 'node:worker_threads' ? { isMainThread: false } : nativeRequire(name);
workerContext._compile(fs.readFileSync(filename, 'utf8'), filename);
Diagnostics.stop();
const first = workerContext.exports.forState(state, deps);
const published = workerContext.exports.forState(clone, deps);
assert.notStrictEqual(first, published); assert.deepEqual(first.network, published.network);
metrics = Diagnostics.metrics();
assert.equal(metrics.counts['context:miss:state_publication'], 1, 'technical identity replacement is named separately');
assert.equal(metrics.counts['network:hit:same_inputs'], 1, 'worker publication can rebuild context while reusing network');
assert.equal(metrics.counts['provider:build:context_miss'], 2, 'provider builds count separately from network hits');
assert.equal(metrics.durations.network.count, 1);
assert.equal(metrics.durations.provider.count, 2);
workerContext.exports.forgetContext(901, 'state_publication');
assert.equal(Diagnostics.metrics().counts['context:eviction:state_publication'], 1);
Config.developerDiagnostics = false; Diagnostics.push = original.push; Diagnostics.stop(); Economy.reset();
assert.equal(invoke('Database').isReady(), false);
fs.rmSync(directory, { recursive: true, force: true });
console.log('test_wish_context_diagnostics: ok');
