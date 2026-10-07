const assert = require('assert');
const fs = require('fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('rule-c4-heine');
require('../src/Global');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
const BuyShop = invoke('GameServer/World/Generics/NpcBypasses/BuyShop');
const Shops = invoke('GameServer/World/Generics/NpcShopBuyLists');
DataCache.init();
const groups = DataCache.npcSpawns.filter(group => group.selfId === 'c4_heine');
assert.strictEqual(groups.length, 1);
assert.strictEqual(groups[0].spawns.length, 31);
for (const spawn of groups[0].spawns) {
    assert.strictEqual(DataCache.npcs.filter(npc => npc.selfId === spawn.selfId).length, 1);
    assert.strictEqual(DataCache.npcSpawns.flatMap(group => group.spawns).filter(row => row.selfId === spawn.selfId).length, 1);
}
DataCache.npcSpawns = groups;
const world = { npc: { nextId: 1000000, spawns: [], periodMode: 'day' } };
SpawnNpcs.call(world);
assert.strictEqual(world.npc.spawns.length, 31);
for (const npc of world.npc.spawns) {
    const spawn = groups[0].spawns.find(row => row.selfId === npc.fetchSelfId());
    assert.deepStrictEqual([npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()],
        [spawn.coords[0].locX, spawn.coords[0].locY, spawn.coords[0].locZ]);
}
for (const [id, count] of [[7890, 70], [7891, 77], [7892, 115], [7893, 157]]) {
    const entries = Shops.fetchForNpc(id);
    const ngShots = new Set([1835, 2509, 3947]);
    assert.strictEqual(entries.filter(row => !ngShots.has(row.selfId)).length, count, 'all authored non-shot merchant rows remain');
    const added = id === 7893 ? 3 : 0;
    assert.deepStrictEqual(entries.filter(row => ngShots.has(row.selfId)).map(row => row.selfId),
        added ? [1835, 2509, 3947] : [], 'only the C4 grocer gains the three no-grade shots');
    assert.strictEqual(entries.length, count + added);
    assert(entries.every(row => row.price > 0 && DataCache.items.some(item => item.selfId === row.selfId)));
    assert(fs.readFileSync(`data/Html/${id}.html`, 'utf8').includes('buy-shop npc'));
    const packets = [];
    const session = { activeNpcTalk: { selfId: id }, actor: { backpack: { fetchTotalAdena: () => 100000 } }, dataSendToMe: packet => packets.push(packet) };
    BuyShop(session, ['buy-shop', 'npc']);
    assert.strictEqual(packets[0][0], 0x11);
    assert.strictEqual(packets[0].readInt16LE(9), count + added);
    assert.strictEqual(packets[1][0], 0x25);
    assert.strictEqual(session.activeNpcShop.npcSelfId, id);
}
// Exercise the real NPC interaction routing and warehouse HTML packet.
for (const id of [7894, 7895, 7896]) {
    const packets = [];
    NpcTalk({ actor: {}, dataSendToMe: packet => packets.push(packet) }, world.npc.spawns.find(npc => npc.fetchSelfId() === id));
    assert(packets[0].toString('utf16le', 5).includes('warehouse deposit'));
    assert(packets[0].toString('utf16le', 5).includes('warehouse withdraw'));
    assert.strictEqual(packets[1][0], 0x25);
}
const TownGuard = invoke('GameServer/Npc/TownGuard');
const NpcAggro = invoke('GameServer/Npc/NpcAggro');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const originalLos = Geodata.hasLineOfSight;
Geodata.hasLineOfSight = () => true;
try {
    for (const id of [7916, 7917, 7920, 7921]) {
        const guard = world.npc.spawns.find(npc => npc.fetchSelfId() === id);
        assert.strictEqual(guard.fetchHostile(), false);
        assert.strictEqual(TownGuard.isTownGuard(guard), true);
        const player = { fetchKarma: () => 0, fetchLocX: () => guard.fetchLocX() + 20,
            fetchLocY: () => guard.fetchLocY(), fetchLocZ: () => guard.fetchLocZ() };
        let attacks = 0;
        guard.enterCombatState = () => attacks++;
        // Even a stale imported hostile flag must not bypass guard PK rules.
        guard.fetchHostile = () => true;
        guard.aggroEligibleAt = 0;
        NpcAggro.engageNearby({ actor: player }, player, { world, npcs: [guard] });
        TownGuard.engageNearby({ actor: player }, player, [guard]);
        assert.strictEqual(attacks, 0, `guard ${id} must not attack a white player`);
        assert.strictEqual(TownGuard.canEngage(guard, { ...player, fetchKarma: undefined }), false);
        player.fetchKarma = () => 720;
        TownGuard.engageNearby({ actor: player }, player, [guard]);
        assert.strictEqual(attacks, 1, `guard ${id} must still attack a PK`);
    }
} finally {
    Geodata.hasLineOfSight = originalLos;
}
const Flauen = world.npc.spawns.find(npc => npc.fetchSelfId() === 7899);
assert.strictEqual(Flauen.fetchName(), 'Flauen');
assert.strictEqual(Flauen.fetchKind(), 'Teleporter');
const Gatekeeper = invoke('GameServer/World/C4GatekeeperTeleports');
const GatekeeperBypass = invoke('GameServer/World/Generics/NpcBypasses/GatekeeperTeleport');
const routes = [[59, 83400, 147943, -3404, 9200], [60, 47942, 186764, -3485, 8500],
    [65, 15670, 142983, -2705, 9800], [66, 82684, 183551, -3597, 2400],
    [67, 91186, 217104, -3649, 2400], [68, 126450, 174774, -3079, 3500]];
const teleportPackets = [];
GatekeeperBypass({ activeNpcTalk: { selfId: 7899, objectId: Flauen.fetchId() },
    dataSendToMe: packet => teleportPackets.push(packet) }, ['gatekeeper-teleport']);
for (const [id, locX, locY, locZ, price] of routes) {
    assert.deepStrictEqual(Gatekeeper.destination(7899, id), { locX, locY, locZ, price });
    assert(teleportPackets[0].toString('utf16le', 5).includes(`gatekeeper-teleport ${id}`));
}
assert.strictEqual(Gatekeeper.destination(7899, 1), null);
assert.strictEqual(teleportPackets[1][0], 0x25);
console.log('Heine: 31 spawns, shops, warehouses, guard PK rules and six Flauen routes passed');

require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
