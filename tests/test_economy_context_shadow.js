'use strict';
// Shadow counters of context rebuilds (diagnostics only): same/new key, gap since
// the actor's previous build and what released its context. Never a decision input.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-context-shadow-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const deps = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), timestamp: 1e12 };
const state = () => ({ characterId: 901, updatedAt: 1, level: 20, phase: 'cold', activity: 'resting', adena: 100,
    stats: { classId: 1 }, inventory: { 1: { selfId: 1, amount: 1, equipped: true, slot: 7 } }, currentRegion: 'Giran',
    simulation: { revision: 2 }, loc: { locX: 80000, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } });
const shadow = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {}).filter(([key]) => key.startsWith('context:shadow')));
function delta(before, after) {
    const out = {};
    for (const [key, value] of Object.entries(after)) if (value !== (before[key] || 0)) out[key] = value - (before[key] || 0);
    return out;
}

// Off: no diagnostic call is reached, the decision path is unchanged.
const original = { count: Diagnostics.count, duration: Diagnostics.duration, enabled: Diagnostics.enabled, push: Diagnostics.push };
Config.developerDiagnostics = false; Economy.reset();
for (const key of Object.keys(original)) Diagnostics[key] = () => { throw Error(`off reached ${key}`); };
const offFirst = Economy.forState(state(), deps);
assert.strictEqual(Economy.forState(state(), deps).plan, offFirst.plan);
Economy.setPlanningContexts(64); Economy.setPlanningContexts(0);
Economy.forState(state(), deps); Economy.forgetContext(901, 'state_publication');
Economy.forState(state(), { ...deps, rememberContext: false });
Object.assign(Diagnostics, original);

// On, with a fake clock so the gap buckets are exact.
const realNow = Date.now; let clock = 1e12; Date.now = () => clock;
Config.developerDiagnostics = true; Economy.reset();
let before = shadow();
const first = Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:not_retained:new_key': 1 }, 'first build has no previous key');

before = shadow(); clock += 7000;
Economy.forgetContext(901, 'state_publication');
const republished = state();
const second = Economy.forState(republished, deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:not_retained:same_key': 1, 'context:shadow_gap:5_15s': 1,
    'context:shadow_released:state_publication': 1, 'context:shadow_plan:same_key:same_plan': 1 },
'a released context with an equal key is counted with its gap, release reason and the repeated plan');
assert.deepEqual(second.statsPacket, first.statsPacket, 'counting never changes the decision');

before = shadow(); clock += 40000;
assert.strictEqual(Economy.forState(republished, deps).plan, second.plan, 'a hit is not a rebuild');
assert.deepEqual(delta(before, shadow()), {});
before = shadow(); clock += 2000;
Economy.forgetContext(901, 'owner_release');
Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:not_retained:same_key': 1, 'context:shadow_gap:1_5s': 1,
    'context:shadow_released:owner_release': 1, 'context:shadow_plan:same_key:same_plan': 1 }, 'the gap runs from the last use, a hit included');

before = shadow();
Economy.forState({ ...republished, adena: 5000 }, deps);
let changed = delta(before, shadow());
assert.deepEqual(changed, { 'context:shadow:input_dependency_changed:new_key': 1, 'context:shadow_plan:new_key:same_plan': 1 },
    'a richer wallet invalidates inputs while the mandatory kit remains the focus');

// A build that waits on incoming stock (early return) still classifies its plan.
before = shadow();
Economy.forState({ ...republished, adena: 5000, incomingPending: true }, deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:input_dependency_changed:new_key': 1, 'context:shadow_plan:new_key:new_plan': 1 });
Economy.forState({ ...republished, adena: 5000 }, deps);

// An unkept build stays unkept even when an older kept context of the actor is released later.
Economy.forState(state(), { ...deps, rememberContext: false });
Economy.forgetContext(901, 'state_publication');
before = shadow(); clock += 200000;
Economy.forState(state(), deps);
changed = delta(before, shadow());
assert.deepEqual(changed, { 'context:shadow:not_retained:same_key': 1, 'context:shadow_gap:ge120s': 1,
    'context:shadow_released:unkept': 1, ...Object.fromEntries(Object.entries(changed).filter(([key]) => key.startsWith('context:shadow_plan:same_key:'))) });
assert.strictEqual(Object.keys(changed).filter(key => key.startsWith('context:shadow_plan:same_key:')).length, 1, 'a same key compares its plan with the previous build');

// Planner slots and the LRU capacity name their own release.
Economy.setPlanningContexts(64); Economy.setPlanningContexts(0);
before = shadow();
Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:not_retained:same_key': 1, 'context:shadow_gap:lt1s': 1,
    'context:shadow_released:planning_capacity': 1, 'context:shadow_plan:same_key:same_plan': 1 });
for (let id = 1000; id < 1064; id++) Economy.forState({ ...state(), characterId: id }, deps);
before = shadow();
Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:not_retained:same_key': 1, 'context:shadow_gap:lt1s': 1,
    'context:shadow_released:capacity': 1, 'context:shadow_plan:same_key:same_plan': 1 });

Date.now = realNow; Config.developerDiagnostics = false; Economy.reset();
console.log('test_economy_context_shadow: ok');
