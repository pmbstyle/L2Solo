const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const RaidBossState = invoke('GameServer/World/RaidBossState');
const DataCache = invoke('GameServer/DataCache');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');

async function main() {
    const databasePath = path.join(process.cwd(), 'tmp', 'test-raid-boss-respawn.sqlite');
    fs.rmSync(databasePath, { force: true });
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    RaidBossState.resetForTests();
    await RaidBossState.load();

    const respawnAt = Date.now() + 60000;
    assert.strictEqual(await RaidBossState.markDefeated(10019, respawnAt, 0, 0), true);
    assert.strictEqual(RaidBossState.isDelayed(10019), true);

    await Database.close();
    Database.init();
    RaidBossState.resetForTests();
    await RaidBossState.load();
    assert.strictEqual(RaidBossState.get(10019).respawnTime, respawnAt);
    assert.strictEqual(RaidBossState.isDelayed(10019), true,
        'a raid boss must remain absent after a server restart until respawn_time');

    DataCache.init();
    const sourceNpc = DataCache.npcs.find((npc) => npc.selfId === 10019);
    const sourceSpawn = DataCache.npcSpawns.find((area) => area.selfId === 'c4-low-level-raid-bosses')
        .spawns.find((spawn) => spawn.selfId === 10019);
    const definition = { npc: sourceNpc, spawn: sourceSpawn, bounds: [] };
    const world = {
        user: { sessions: [] },
        npc: { spawns: [], nextId: 1000000, periodMode: 'day', raidBossRespawnTimers: new Map() },
        indexSpawnsInGrid() {}
    };
    assert.strictEqual(SpawnNpcs.spawnNpc(world, definition), null,
        'persisted respawn_time must gate startup spawning');
    assert.strictEqual(world.npc.spawns.length, 0);
    const timer = world.npc.raidBossRespawnTimers.get(10019);
    assert(timer?.timer, 'a persisted raid boss must have an in-process wake-up timer');
    clearTimeout(timer.timer);

    assert.strictEqual(await RaidBossState.markSpawned(10019), true);
    assert.strictEqual(RaidBossState.get(10019), null);
    await Database.close();
    console.log('Raid boss respawn persistence ok');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
