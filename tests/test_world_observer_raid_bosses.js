const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Observer = invoke('WorldObserver/WorldObserverServer');
const RaidBossState = invoke('GameServer/World/RaidBossState');
const World = invoke('GameServer/World/World');

(async () => {
    DataCache.init();
    RaidBossState.resetForTests();

    const catalog = Observer.raidBossCatalog();
    assert.strictEqual(catalog.length, 179, 'observer must expose all ordinary C4 raid bosses');

    const definition = catalog[0];
    const liveBoss = {
        fetchIsRaidBoss: () => true,
        fetchSelfId: () => definition.id,
        fetchId: () => 9000001,
        fetchLocX: () => definition.spawnLoc.locX,
        fetchLocY: () => definition.spawnLoc.locY,
        fetchLocZ: () => definition.spawnLoc.locZ,
        state: { fetchDead: () => false },
        isDead: () => false
    };
    World.npc = { spawns: [liveBoss] };

    const now = Date.now();
    let snapshot = Observer.raidBossSnapshot(now);
    const live = snapshot.bosses.find((boss) => boss.id === definition.id);
    assert.strictEqual(snapshot.counts.alive, 1);
    assert.strictEqual(live.status, 'alive');
    assert.strictEqual(live.objectId, liveBoss.fetchId());
    assert.deepStrictEqual(live.loc, definition.spawnLoc);

    World.npc = { spawns: [] };
    await RaidBossState.markDefeated(definition.id, now + 90_000);
    snapshot = Observer.raidBossSnapshot(now);
    const respawning = snapshot.bosses.find((boss) => boss.id === definition.id);
    assert.strictEqual(respawning.status, 'respawning');
    assert.strictEqual(respawning.remainingMs, 90_000);
    assert.strictEqual(snapshot.counts.respawning, 1);

    RaidBossState.resetForTests();
    console.log('World observer raid boss checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
