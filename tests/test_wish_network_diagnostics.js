'use strict';
const assert = require('node:assert/strict');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Diagnostics = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
const Tendency = require('../src/GameServer/Bot/AI/TendencyRoll');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');
const { fnv1a32 } = require('../src/GameServer/Bot/Fnv1a');
const input = { actorKey: 'character:17', characterId: 17, decisionSeq: 7, activityLeaf: 0,
    inputKey: 'native-bag:3', wallet: 150, survivalReserve: 25, hourAdena: 100,
    caller: 'native_fixture', trigger: 'bag_change', roots: ['gear', 'care'], previous: {},
    nodes: [{ key: 'gear', need: 'power', object: { itemId: 391, amount: 1 }, valueHours: 20,
        paths: [{ kind: 'npc', sourceType: 'npc', activity: 'shopping', itemId: 391,
            amount: 1, price: 100, unitPrice: 100, npcId: 301, town: 'Giran' },
        { kind: 'craft', activity: 'crafting', recipeId: 12, costHours: 5 }] },
    { key: 'care', need: 'care', object: { itemId: 392, amount: 1 }, valueHours: 10,
        paths: [{ kind: 'board', activity: 'shopping', itemId: 392, price: 200 }] }] };
const original = { performance: global.performance, count: Diagnostics.count, duration: Diagnostics.duration,
    enabled: Diagnostics.enabled, push: Diagnostics.push, roll: Tendency.roll };
let rolls = 0;
Tendency.roll = (...args) => { rolls++; return original.roll(...args); };
Config.developerDiagnostics = false;
Config.economyDiagnostics = true;
for (const key of ['count', 'duration', 'enabled', 'push']) Diagnostics[key] = () => { throw Error(`off reached ${key}`); };
global.performance = { now: () => { throw Error('off reached diagnostic clock'); } };
const silent = new WishNetwork();
const off = silent.build(input);
assert.strictEqual(silent.build(input), off);
silent.forget(input.actorKey); silent.clear();
const offRolls = rolls;
Object.assign(Diagnostics, { count: original.count, duration: original.duration, enabled: original.enabled, push: original.push });
global.performance = original.performance;
Config.developerDiagnostics = true; Config.economyDiagnosticsBotIds = '17'; Diagnostics.stop();
const records = [];
Diagnostics.push = row => { records.push(row); return original.push(row); };
rolls = 0;
const active = new WishNetwork();
const on = active.build(input);
assert.deepEqual(on, off, 'diagnostics preserve full result including held focus, queue and RNG output');
assert.equal(rolls, offRolls, 'no diagnostic rolls');
assert.strictEqual(active.build(input), on);
const publication = active.build({ ...input, inputKey: 'native-bag:3:publication' });
assert.deepEqual({ ...publication, inputKey: on.inputKey }, on, 'a changed key alone does not change the result');
let metrics = Diagnostics.metrics();
assert.equal(metrics.counts['network:request:unknown'], 3);
assert.equal(metrics.counts['network:hit:same_inputs'], 1);
assert.equal(metrics.counts['network:miss:not_retained'], 1);
assert.equal(metrics.counts['network:miss:input_dependency_changed'], 1);
assert.equal(metrics.counts['network:build:unknown'], 2);
assert.equal(metrics.counts['network:unchanged:unknown'], 1);
assert.equal(metrics.counts['network:comparison_unavailable:unknown'], 1);
assert.equal(metrics.durations.network.count, 2, 'cache reads are not network builds');
assert(records.some(row => row.phase === 'wish_alternative' && row.reason === 'selected_path' && row.npcId === 301));
assert(records.some(row => row.phase === 'wish_alternative' && row.reason === 'evaluated_path' && row.recipeId === 12));
assert(records.some(row => row.phase === 'wish_funding' && row.reason === 'funded' && row.budget === 100 && row.reserve === 25 && row.planned === 1));
assert(records.some(row => row.phase === 'wish_funding' && row.reason === 'first_funding_gap' && row.available === 25));
assert(records.some(row => row.phase === 'wish_activity' && row.activityLeaf === on.activityLeaf && row.decisionSeq === on.decisionSeq));
assert(records.every(row => row.owner === 17 && row.caller === 'native_fixture' && row.trigger === 'bag_change'));
assert(records.some(row => row.inputHash === fnv1a32(input.inputKey)), 'existing decision input correlates observations');
assert(records.every(row => row.wallet === undefined && row.owned === undefined), 'network funding budget is not mislabelled physical wallet or historical stock');
assert(records.filter(row => row.phase === 'wish_funding' && row.reason !== 'funded')
    .every(row => row.budget === undefined && row.planned === undefined), 'unfunded wish has no authorised purchase budget');
active.build({ ...input, wallet: 50, inputKey: 'wallet:50' });
metrics = Diagnostics.metrics(); assert.equal(metrics.counts['network:changed:unknown'], 1);
for (let i = 0; i < 70; i++) active.build({ ...input, actorKey: `other:${i}`, characterId: i + 100, inputKey: String(i) });
metrics = Diagnostics.metrics();
assert.equal(active.cache.size, 64);
assert.equal(metrics.counts['network:eviction:capacity'], 7);
assert.equal(metrics.durations.network.count, 73);
assert.equal(metrics.durations.network.samples.length, 32, 'duration history stays bounded');
active.forget('other:69'); assert.equal(Diagnostics.metrics().counts['network:eviction:owner_release'], 1);
active.clear(); assert.equal(Diagnostics.metrics().counts['network:eviction:reset'], 63);
Object.assign(Diagnostics, { push: original.push }); Tendency.roll = original.roll;
Config.developerDiagnostics = false; Diagnostics.stop();
console.log('test_wish_network_diagnostics: ok');
