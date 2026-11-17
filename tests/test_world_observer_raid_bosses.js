const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Observer = invoke('WorldObserver/WorldObserverServer');
const RaidBossState = invoke('GameServer/World/RaidBossState');
const World = invoke('GameServer/World/World');

(async () => {
    DataCache.init();
    RaidBossState.resetForTests();

    assert.strictEqual(Observer.loopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.strictEqual(Observer.loopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
    assert.strictEqual(Observer.loopbackRequest({ socket: { remoteAddress: '100.92.15.42' } }), false);

    const catalog = Observer.raidBossCatalog();
    assert.strictEqual(catalog.length, 182, 'observer must expose the C4 raid catalogue, including Queen Ant, Core and Orfen');
    const knowledgeBase = Observer.knowledgeBaseService();
    for (const { id, name } of catalog) {
        assert.ok(knowledgeBase.npcDetail(id), `the raid list must link to a database entry for ${name} (${id})`);
    }

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
    assert.strictEqual(definition.respawnMs, 5 * 60 * 60 * 1000,
        'Observer must report the effective real-time raid respawn, not the original datapack window');
    await RaidBossState.markDefeated(definition.id, now + 90_000);
    snapshot = Observer.raidBossSnapshot(now);
    const respawning = snapshot.bosses.find((boss) => boss.id === definition.id);
    assert.strictEqual(respawning.status, 'respawning');
    assert.strictEqual(respawning.remainingMs, 90_000);
    assert.strictEqual(snapshot.counts.respawning, 1);

    const originalNpcs = DataCache.npcs, originalSpawns = DataCache.npcSpawns;
    try {
        DataCache.npcs = [{ selfId: 1, template: { raidBoss: true, name: 'First', level: 20 } },
            { selfId: '1', template: { raidBoss: true, name: 'Last raid', level: 21 } },
            { selfId: 1, template: { raidBoss: false, name: 'Ordinary', level: 80 } },
            { selfId: 2, template: { raidBoss: true, level: 30 } }];
        DataCache.npcSpawns = [{ spawns: [{ selfId: 2, name: 'Spawn name', coords: [] },
            { selfId: '1', coords: [{ locX: '1', locY: '2', locZ: '-3' }] },
            { selfId: 1, coords: [{ locX: 99, locY: 99, locZ: 99 }] }] }];
        const expected = [{ id: 2, name: 'Spawn name', level: 30, respawnMs: definition.respawnMs, spawnLoc: null },
            { id: 1, name: 'Last raid', level: 21, respawnMs: definition.respawnMs,
                spawnLoc: { locX: 1, locY: 2, locZ: -3 } }];
        assert.deepStrictEqual(Observer.raidBossCatalog(), expected,
            'observer preserves last raid-marked template, first spawn and spawn-file order');
        assert.deepStrictEqual(Observer.raidBossCatalog(), expected, 'warm raid presentation keeps shape and metadata');
        DataCache.npcs.push({ selfId: 3, template: { raidBoss: true, name: 'Appended' } });
        DataCache.npcSpawns.push({ spawns: [{ selfId: 3, coords: [] }] });
        assert.strictEqual(Observer.raidBossCatalog().at(-1).name, 'Appended', 'growing source arrays revise raid definitions');
    } finally { DataCache.npcs = originalNpcs; DataCache.npcSpawns = originalSpawns; }

    RaidBossState.resetForTests();
    console.log('World observer raid boss checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
