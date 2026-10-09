'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('wish-source-assessment-scope');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const World = invoke('GameServer/World/World');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const filename = require.resolve('../src/GameServer/Bot/AI/GearAcquisitionPlanner');
const originalModule = require.cache[filename];
const text = fs.readFileSync(filename, 'utf8');
function plannerModule(old) {
    let source = text;
    if (old) {
        const begin = source.indexOf('function partyNeedAssessmentForSource(');
        const end = source.indexOf('\nfunction sourceTargetLevel(', begin);
        source = source.slice(0, begin) + require('./helpers/sourceAssessmentReference') + source.slice(end);
    } else {
        source = source.replace('function sourceAssessmentReason(readiness, targetLevel) {',
            'function sourceAssessmentReason(readiness, targetLevel) { assessmentComputations++;');
    }
    const result = new Module(filename, module);
    result.filename = filename; result.paths = Module._nodeModulePaths(path.dirname(filename));
    result._compile(source + '\nlet assessmentComputations = 0; module.exports._count = () => assessmentComputations;', filename);
    result.loaded = true;
    return result;
}
const reference = plannerModule(true), current = plannerModule(false);
const originalRandom = Math.random;
let seed = 20261005;
Math.random = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = (value + Math.imul(value ^ value >>> 7, 61 | value)) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
};
const world = { user: { sessions: [] }, npc: { spawns: [], grid: {}, nextId: 1000000,
    periodMode: 'day', periodRevision: 0, periodDefinitions: [], raidBossRespawnTimers: new Map(),
    raidBossState: new Map(), gridKeys: new WeakMap() }, items: { spawns: [], nextId: 5000000 },
    addNpcToGrid() {}, indexSpawnsInGrid() {} };
const timestamp = 1791335800000;
const board = new BoardIndex();
const saved = require('./fixtures/wish_spot_native_state.json');
function review(planner, original, deps) {
    const state = structuredClone(original), before = structuredClone(state);
    require.cache[filename] = planner;
    Economy.reset(); Profile.forgetBuild(state.characterId);
    const started = planner.exports._count();
    const random = Math.random;
    let randomReads = 0, ctx;
    Math.random = () => { randomReads++; return 0.5; };
    try { ctx = Economy.forState(state, { ...deps, npcOffersFor: () => [] }); }
    finally { Math.random = random; }
    assert.deepEqual(state, before, 'source assessment does not change authoritative facts');
    return { randomReads, computations: planner.exports._count() - started, output: { projection: ctx.projection,
        network: ctx.network, packet: ctx.statsPacket, watch: ctx.watchList, inputKey: ctx.inputKey } };
}
try {
    invoke('GameServer/World/Generics/SpawnNpcs').call(world);
    World.npc = world.npc; World.user = world.user;
    Spots.reset(); Profiles.reset();
    const spots = Profiles.ensure();
    assert(spots.length > 1800, 'full native source catalogue');
    Math.random = originalRandom;
    const occupied = new Map(spots.map(spot => [spot.id, { reservedCount: Math.max(1, Number(spot.density)) * 4 }]));
    const deps = { spots, board, timestamp, occupancy: new Map() };
    const cases = [{ state: saved, deps },
        { state: saved, deps: { ...deps, timestamp: timestamp + 60000, occupancy: occupied } },
        { state: { ...saved, adena: 250, inventory: { ...saved.inventory,
            57: { ...saved.inventory[57], amount: 250 },
            1869: { ...saved.inventory[1869], selfId: 1869, amount: 40 } },
            stats: { ...saved.stats, money: [12000, .0002, 500, 30000, .4, 0, 0] } },
            deps: { ...deps, timestamp: timestamp + 120000 } },
        ...[2, 12, 16].map(classId => ({ state: { ...saved, stats: { ...saved.stats, classId } }, deps })),
        { state: { ...saved, inventory: {} }, deps }, { state: { ...saved, level: 39 }, deps }];
    for (const fixture of cases) {
        const old = review(reference, fixture.state, fixture.deps), fresh = review(current, fixture.state, fixture.deps);
        assert.deepEqual(fresh.output, old.output, 'whole native projection/network/packet/watch/order matches 9318ccab');
        assert.equal(fresh.randomReads, old.randomReads, 'reuse does not add or remove a decision roll');
        assert(fresh.computations < old.computations, 'same classification is reused in real sources');
        assert(fresh.computations <= 87, 'one result for each actually read target level');
        console.log(JSON.stringify({ classId: fixture.state.stats.classId, level: fixture.state.level,
            baseline: old.computations, scoped: fresh.computations, randomReads: fresh.randomReads }));
    }
    assert.equal(invoke('Database').isReady(), false);
    console.log('test_wish_source_assessment_scope: eight exact complete native outcomes PASS');
} finally {
    require.cache[filename] = originalModule;
    Math.random = originalRandom; Economy.reset(); Profile.forgetBuild(saved.characterId);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
process.exit(0);
