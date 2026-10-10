'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Module = require('node:module');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('wish-native-spot-memo');
require('../src/Global');
isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const World = invoke('GameServer/World/World');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const subject = Providers.build;
const filename = require.resolve('../src/GameServer/Bot/Economy/WishProviders');
// Compile the native provider with its spot-value memo bypassed. All actual
// gains, safety gates, yields, recipe expansion and ranking remain native.
// This is an uncached replay oracle, rather than a copied wish algorithm.
const reference = new Module(filename, module);
reference.filename = filename; reference.paths = Module._nodeModulePaths(path.dirname(filename));
const memoized = `    const spotValue = spot => {
        if (!sourceValues.has(spot)) sourceValues.set(spot, ctx.spotValue(spot));
        return sourceValues.get(spot);
    };
`;
const providerSource = fs.readFileSync(filename, 'utf8');
assert(providerSource.includes(memoized), 'the oracle bypasses the actual spot-value memo');
reference._compile(providerSource.replace(memoized, '    const spotValue = spot => ctx.spotValue(spot);\n'), filename);

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
const reviewed = [];
const preparedTrip = () => 0;
preparedTrip.details = () => ({ known: true, hours: .25, fees: 0 });
function review(build, state, deps) {
    // This fixture compares native farm source ranking, without static shop
    // quotes masking changes in occupied hunting grounds.
    // Farm facts need a known route to the spot's town (Task 2, D6): a
    // prepared table, as the worker passes, every town a quarter hour away.
    deps = { ...deps, npcOffersFor: () => [], tripCost: preparedTrip };
    const input = structuredClone(state), calls = new Map(), values = new Map();
    Economy.reset(); Profile.forgetBuild(state.characterId);
    Providers.build = (nativeState, ctx, nativeDeps) => {
        const reader = ctx.spotValue;
        ctx.spotValue = spot => {
            const value = reader(spot);
            calls.set(spot, (calls.get(spot) || 0) + 1);
            if (values.has(spot)) assert.deepEqual(value, values.get(spot), 'native evaluation is pure inside one review');
            else values.set(spot, value);
            return value;
        };
        try { return build(nativeState, ctx, nativeDeps); }
        finally { ctx.spotValue = reader; }
    };
    try {
        const ctx = Economy.forState(state, deps);
        assert.deepEqual(state, input, 'a source review does not mutate authoritative bot facts');
        return { calls, values, output: { projection: ctx.projection, network: ctx.network,
            packet: ctx.statsPacket, watch: ctx.watchList, inputKey: ctx.inputKey } };
    } finally { Providers.build = subject; }
}

try {
    // Authored spawns and native NPC rewards supply the full source catalogue.
    invoke('GameServer/World/Generics/SpawnNpcs').call(world);
    World.npc = world.npc; World.user = world.user;
    Spots.reset(); Profiles.reset();
    const spots = Profiles.ensure();
    assert(spots.length > 1800, 'use the actual native source catalogue');
    Math.random = originalRandom;
    // Crowded but not full: a full ground is refused as occupied (Task 2,
    // D5) before its value is read, so each keeps room for one more hunter.
    const occupied = new Map(spots.map(spot => {
        const reservedCount = Math.max(1, Number(spot.density)) * 4;
        return [spot.id, { reservedCount, capacity: reservedCount + 1 }];
    }));
    // The complete saved native crafter from the measured corpus, including
    // physical equipment, learned skills and remembered hunt/stock facts.
    const crafter = require('./fixtures/wish_spot_native_state.json');
    const cases = [
        { state: crafter, deps: { spots, board, timestamp, occupancy: new Map() } },
        { state: crafter, deps: { spots, board, timestamp: timestamp + 60000, occupancy: occupied } },
        { state: { ...crafter, adena: 250, inventory: { ...crafter.inventory,
            57: { ...crafter.inventory[57], amount: 250 },
            1869: { ...crafter.inventory[1869], selfId: 1869, amount: 40 } },
            stats: { ...crafter.stats, money: [12000, .0002, 500, 30000, .4, 0, 0] } },
            deps: { spots, board, timestamp: timestamp + 120000, occupancy: new Map() } },
    ];
    let duplicatedNativeCalls = 0;
    for (const fixture of cases) {
        const replay = review(reference.exports.build, structuredClone(fixture.state), fixture.deps);
        const memo = review(subject, structuredClone(fixture.state), fixture.deps);
        assert.deepEqual(memo.output, replay.output, 'complete native projection, queue, plan, values, packet and order match uncached replay');
        assert.deepEqual(memo.values, replay.values, 'all native spot values, including absent table rows, remain exact');
        assert(memo.calls.size > 20, 'native sources actually participate in the review');
        assert([...memo.calls.values()].every(count => count === 1), 'each native spot is evaluated once per build');
        const uncachedCalls = [...replay.calls.values()].reduce((sum, count) => sum + count, 0);
        duplicatedNativeCalls += uncachedCalls - memo.calls.size;
        reviewed.push({ replay, memo });
        console.log(JSON.stringify({ classId: fixture.state.stats.classId, uncachedCalls,
            memoCalls: memo.calls.size, nativeSpots: spots.length }));
    }
    assert(duplicatedNativeCalls > 100, 'real sources recur across native wishes and materials');
    const first = reviewed[0].memo, next = reviewed[1].memo;
    let changedRates = 0;
    for (const [spot, rate] of first.values) {
        const changed = next.values.get(spot);
        if (rate?.kills > 0 && changed?.kills > 0) {
            assert.equal(changed.kills, rate.kills / 4, 'the next build evaluates changed native occupancy freshly');
            changedRates++;
        }
    }
    assert(changedRates > 20, 'a new review cannot reuse rates from the previous native facts');
    assert.notDeepEqual(next.values, first.values, 'changed native occupancy reaches freshly evaluated source rates');
    // An unavailable gear path may leave the final choice unchanged. Fresh
    // source facts are still checked exactly against the uncached native oracle.
    assert.notDeepEqual(reviewed[2].memo.output, first.output, 'changed native inventory and money produce a fresh decision');
    assert.equal(invoke('Database').isReady(), false, 'no database was initialized');
    console.log('test_wish_spot_value_memo: native uncached parity, duplicate reads and fresh-build facts PASS');
} finally {
    Providers.build = subject; Math.random = originalRandom;
    Economy.reset();
    Profile.forgetBuild(2002634);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
process.exit(0);
