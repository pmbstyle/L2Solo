const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const DayNightSpawnManager = invoke('GameServer/World/DayNightSpawnManager');
const GameTime = invoke('GameServer/World/GameTime');
const RemoveNpc = invoke('GameServer/World/Generics/RemoveNpc');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');

const midnight = new Date(2026, 0, 15, 0, 0, 0, 0).getTime();
assert.strictEqual(GameTime.gameHour(midnight), 0);
assert.strictEqual(GameTime.isNight(midnight), true, 'Lisvus game time starts at night');
assert.strictEqual(GameTime.isNight(midnight + 60 * 60 * 1000 - 1), true);
assert.strictEqual(GameTime.gameHour(midnight + 60 * 60 * 1000), 6);
assert.strictEqual(GameTime.isNight(midnight + 60 * 60 * 1000), false, 'sunrise must occur at game hour six');
assert.strictEqual(GameTime.isNight(midnight + GameTime.REAL_DAY_MS), true, 'a C4 game day must last four real hours');
assert.strictEqual(GameTime.msUntilTransition(midnight), 60 * 60 * 1000);
assert.strictEqual(GameTime.msUntilTransition(midnight + 60 * 60 * 1000), 3 * 60 * 60 * 1000);

const originalTimezone = process.env.TZ;
try {
    process.env.TZ = 'America/New_York';
    const dstForwardEvening = new Date(2026, 2, 8, 22, 30, 0, 0).getTime();
    assert.strictEqual(
        GameTime.msUntilTransition(dstForwardEvening),
        90 * 60 * 1000,
        'a DST-forward day must reschedule at local midnight before the later four-hour cycle boundary'
    );
} finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
}

DataCache.init();
const template = DataCache.npcs.find((npc) => npc.template.kind === 'Monster');
assert.ok(template, 'fixture requires one loaded monster template');

function definition(period, locX) {
    return {
        npc: structuredClone(template),
        bounds: [],
        spawn: {
            selfId: template.selfId,
            name: template.template.name,
            coords: [{ locX, locY: 1000, locZ: -100, head: 0 }],
            total: 1,
            respawn: 60,
            bias: 0,
            period
        }
    };
}

const always = definition('always', 1000);
const day = definition('day', 1100);
const night = definition('night', 1200);
const dayTwo = definition('day', 1300);
const nightTwo = definition('night', 1400);
const packets = [];
const world = {
    user: {
        sessions: [{
            actor: {
                fetchIsOnline: () => true,
                fetchLocX: () => 0,
                fetchLocY: () => 0
            },
            dataSendToMe: (packet) => packets.push(packet)
        }]
    },
    npc: {
        spawns: [], nextId: 1000000, grid: {},
        periodMode: 'day', periodRevision: 0,
        periodDefinitions: [day, night, dayTwo, nightTwo]
    },
    indexSpawnsInGrid() {
        this.npc.gridRevisions = Number(this.npc.gridRevisions || 0) + 1;
    }
};

SpawnNpcs.spawnNpc(world, always);
SpawnNpcs.spawnNpc(world, day);
SpawnNpcs.spawnNpc(world, dayTwo);
assert.strictEqual(SpawnNpcs.spawnNpc(world, night), null, 'night definitions must not spawn during the day');
assert.deepStrictEqual(world.npc.spawns.map((npc) => npc.spawnDefinition.spawn.period), ['always', 'day', 'day']);

const firstChange = DayNightSpawnManager.changeMode(world, 'night');
assert.deepStrictEqual(firstChange, { changed: true, removed: 2, spawned: 2 });
assert.strictEqual(world.npc.gridRevisions, 2,
    'a bulk period transition must rebuild the spawn grid once for removal and once for insertion');
assert.deepStrictEqual(world.npc.spawns.map((npc) => npc.spawnDefinition.spawn.period).sort(), ['always', 'night', 'night']);
assert.strictEqual(packets.at(-1)[0], 0x1d, 'night transition must broadcast the C4 Sunset packet');
assert.strictEqual(RemoveNpc.canRespawnDefinition(world, day, 0), false,
    'a pending day respawn must be invalidated when the period revision changes');

const secondChange = DayNightSpawnManager.changeMode(world, 'day');
assert.deepStrictEqual(secondChange, { changed: true, removed: 2, spawned: 2 });
assert.deepStrictEqual(world.npc.spawns.map((npc) => npc.spawnDefinition.spawn.period).sort(), ['always', 'day', 'day']);
assert.strictEqual(packets.at(-1)[0], 0x1c, 'day transition must broadcast the C4 Sunrise packet');
assert.strictEqual(RemoveNpc.canRespawnDefinition(world, day, world.npc.periodRevision), true);
assert.strictEqual(RemoveNpc.canRespawnDefinition(world, always, 0), true,
    'always-on respawns must survive period changes');

console.log('C4 day/night spawn lifecycle checks passed');
