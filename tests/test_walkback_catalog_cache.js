'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('walkback-native-cache');
require('../src/Global');
isolated.assertConfigured(options.default);
invoke('GameServer/DataCache').init();
const World = invoke('GameServer/World/World');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Walk = invoke('GameServer/Bot/Economy/WalkBack');
const Trip = invoke('GameServer/Bot/Population/ColdTrip');
const Routes = invoke('GameServer/Bot/Travel/TravelRoutes');
const Karma = invoke('GameServer/Karma');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const original = { random: Math.random, honest: Config.coldHonestTravel, plan: Trip.spotPlan };
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

try {
    // The authored spawn builder supplies the actual native sectors and raid
    // profiles; no synthetic centers or shortened route table.
    invoke('GameServer/World/Generics/SpawnNpcs').call(world);
    World.npc = world.npc; World.user = world.user;
    Spots.reset(); Profiles.reset(); Walk.reset();
    const profiles = Profiles.ensure(), raw = Spots.spots, catalogs = [profiles, raw];
    assert(raw.length > 1800 && profiles.length > raw.length);
    Math.random = original.random;
    let compared = 0;
    for (const honest of [false, true]) for (const karma of [0, 3000]) {
        Config.coldHonestTravel = honest;
        for (const catalog of catalogs) for (const spot of catalog) {
            const from = Routes.landingTown(spot.center), state = { stats: { karma } };
            const expectedMs = Karma.closesTowns(karma) ? Trip.runMs(from, spot.center)
                : honest ? original.plan({ loc: from, stats: {} }, spot.center).durationMs : Trip.AUTHOR_TRIP_MS;
            assert.equal(Walk.hours(spot.id, state, catalog), expectedMs / 3600000);
            compared++;
        }
    }
    assert.equal(compared, (raw.length + profiles.length) * 4);
    Config.coldHonestTravel = true;
    Walk.reset();
    let calls = 0;
    Trip.spotPlan = (...args) => { calls++; return original.plan(...args); };
    for (let i = 0; i < 8; i++) {
        const catalog = catalogs[i % 2]; Walk.hours(catalog[0].id, {}, catalog);
    }
    assert.equal(Walk.summary().builds, 2, 'alternating native catalogs keep both cached route tables');
    assert.equal(calls, raw.length + profiles.length, 'each native route is planned once');
    const warmedCalls = calls;
    for (const catalog of catalogs) for (const spot of catalog) Walk.hours(spot.id, {}, catalog);
    assert.equal(calls, warmedCalls, 'warm readers never replan native routes');
    assert.equal(Walk.summary().size, raw.length, 'summary describes the last-read native table');
    assert.equal(Walk.hours('missing-native-id', {}, raw), 0);
    assert.equal(Walk.summary().missing, 1);
    const replacement = raw.map(spot => ({ ...spot, center: { ...spot.center } }));
    Walk.hours(replacement[0].id, {}, replacement);
    assert.equal(Walk.summary().builds, 3, 'a replacement catalog gets a new table');
    Walk.hours(profiles[0].id, {}, profiles);
    assert.equal(Walk.summary().builds, 3, 'a different live catalog never evicts the first table');
    Walk.reset();
    assert.deepEqual(Walk.summary(), { size: 0, builds: 0, missing: 0, buildMs: 0 });
    Walk.hours(profiles[0].id, {}, profiles);
    assert.equal(Walk.summary().builds, 1, 'reset discards all catalog tables');
    console.log(JSON.stringify({ profiles: profiles.length, raw: raw.length, exactNativeComparisons: compared,
        alternatingBuilds: 2, nativePlanCalls: warmedCalls, reset: true }));
} finally {
    Math.random = original.random; Config.coldHonestTravel = original.honest; Trip.spotPlan = original.plan;
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
process.exit(0);
