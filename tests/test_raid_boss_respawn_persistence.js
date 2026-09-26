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

    const fiveHours = 5 * 60 * 60 * 1000;
    const killedAt = Date.now() - 2 * 60 * 60 * 1000;
    const expiredKill = Date.now() - 6 * 60 * 60 * 1000;
    await Database.execute(['DELETE FROM schema_migrations WHERE version = 46', []]);
    for (const [npcId, death] of [[10019, killedAt], [10020, expiredKill]]) {
        await Database.execute([`INSERT INTO raid_boss_state(npcId, respawnTime, hp, mp, updatedAt)
            VALUES (?, ?, 0, 0, ?)`, [npcId, death + 36 * 60 * 60 * 1000, death]]);
    }
    await Database.close(); Database.init();
    RaidBossState.resetForTests(); await RaidBossState.load();
    assert.strictEqual(RaidBossState.get(10019).respawnTime, killedAt + fiveHours);
    assert.strictEqual(RaidBossState.get(10019).updatedAt, killedAt, 'migration preserves the original death timestamp');
    assert.strictEqual(RaidBossState.isDelayed(10020), false, 'five hours elapsed while offline counts toward respawn');
    assert.strictEqual(RaidBossState.isDelayed(10019, killedAt + fiveHours - 1), true);
    assert.strictEqual(RaidBossState.isDelayed(10019, killedAt + fiveHours), false);
    await Database.close(); Database.init();
    RaidBossState.resetForTests(); await RaidBossState.load();
    assert.strictEqual(RaidBossState.get(10019).respawnTime, killedAt + fiveHours,
        'another restart must not start a fresh five-hour countdown');
    assert.strictEqual(SpawnNpcs.respawnDelayForDefinitionMs(definition), fiveHours);
    const profiles = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').all();
    assert(profiles.length > 100);
    assert(profiles.every(profile => profile.respawnSeconds === 18000 && profile.respawnBiasSeconds === 0),
        'bot planning metadata must reflect the actual fixed respawn window');
    await Database.close();
    console.log('Raid boss respawn persistence ok');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
