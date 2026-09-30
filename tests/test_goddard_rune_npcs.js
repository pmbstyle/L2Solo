const assert = require('assert');
const fs = require('fs');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
const BuyShop = invoke('GameServer/World/Generics/NpcBypasses/BuyShop');
const Shops = invoke('GameServer/World/Generics/NpcShopBuyLists');
DataCache.init();

const groups = DataCache.npcSpawns.filter(group => ['c4_goddard', 'c4_rune'].includes(group.selfId));
assert.deepStrictEqual(groups.map(group => group.spawns.length), [97, 85]);
const allSpawns = DataCache.npcSpawns.flatMap(group => group.spawns);
for (const spawn of groups.flatMap(group => group.spawns)) {
    assert.strictEqual(DataCache.npcs.filter(npc => npc.selfId === spawn.selfId).length, 1);
    const c = spawn.coords[0];
    assert.strictEqual(allSpawns.filter(s => s.selfId === spawn.selfId && s.coords.some(p => p.locX === c.locX && p.locY === c.locY && p.locZ === c.locZ)).length, 1);
}
// The four pre-existing city services must remain single instances.
for (const id of [8256, 8275, 8300, 8320]) {
    assert.strictEqual(DataCache.npcs.filter(npc => npc.selfId === id).length, 1);
    assert.strictEqual(allSpawns.filter(spawn => spawn.selfId === id).length, 1);
}
DataCache.npcSpawns = groups;
const world = { npc: { nextId: 1000000, spawns: [], periodMode: 'day' } };
SpawnNpcs.call(world);
assert.strictEqual(world.npc.spawns.length, 182);
const NpcInfo = invoke('GameServer/Network/Response/NpcInfo');
const guildDisplayIds = new Map([[8833, 8735], [8834, 8729], [8835, 8733], [8836, 8730],
    [8837, 8731], [8838, 8738], [8839, 8730], [8840, 8732], [8841, 8734]]);
for (const npc of world.npc.spawns) {
    const selfId = npc.fetchSelfId();
    const packet = NpcInfo(npc);
    assert.strictEqual(packet.readInt32LE(5), 1000000 + (guildDisplayIds.get(selfId) ?? selfId));
    assert.strictEqual(npc.fetchSelfId(), selfId);
}
for (const selfId of guildDisplayIds.keys()) {
    const npc = world.npc.spawns.find(npc => npc.fetchSelfId() === selfId);
    const session = { actor: {}, dataSendToMe: () => {} };
    NpcTalk(session, npc);
    assert.strictEqual(session.activeNpcTalk.selfId, selfId);
}
for (const [id, coords] of [[8267, [146440, -57500, -2968]], [8311, [43556, -48592, -792]],
    [8698, [38208, -48048, 896]], [8699, [38384, -48064, -1152]]]) {
    const npc = world.npc.spawns.find(npc => npc.fetchSelfId() === id);
    assert.deepStrictEqual([npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()], coords);
}
const shops = require('../data/Npcs/c4_goddard_rune_shops.json');
assert.strictEqual(Object.keys(shops).length, 24);
for (const id of Object.keys(shops).map(Number)) {
    const entries = Shops.fetchForNpc(id);
    assert(entries.length > 0);
    assert(entries.every(row => row.price > 0 && DataCache.items.some(item => item.selfId === row.selfId)));
    const npc = world.npc.spawns.find(npc => npc.fetchSelfId() === id);
    const packets = [];
    const session = { actor: { backpack: { fetchTotalAdena: () => 100000 } }, dataSendToMe: packet => packets.push(packet) };
    NpcTalk(session, npc);
    assert(packets[0].toString('utf16le', 5).includes('buy-shop npc'));
    packets.length = 0;
    BuyShop(session, ['buy-shop', 'npc']);
    assert.strictEqual(packets[0][0], 0x11);
    assert.strictEqual(packets[0].readInt16LE(9), entries.length);
    assert.strictEqual(session.activeNpcShop.npcSelfId, id);
}
for (const id of [8267, 8268, 8269, 8270, 8311, 8312, 8313, 8314, 8315]) {
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
    for (const id of [8292, 8340, 8673, 8674]) {
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

const Gatekeeper = invoke('GameServer/World/C4GatekeeperTeleports');
const GatekeeperBypass = invoke('GameServer/World/Generics/NpcBypasses/GatekeeperTeleport');
for (const [npcId, routeIds] of [[8698, [131, 122]], [8699, [131, 123]]]) {
    const packets = [];
    GatekeeperBypass({ activeNpcTalk: { selfId: npcId, objectId: 1 }, dataSendToMe: packet => packets.push(packet) }, ['gatekeeper-teleport']);
    for (const routeId of routeIds) {
        assert(packets[0].toString('utf16le', 5).includes(`gatekeeper-teleport ${routeId}`));
        assert.strictEqual(Gatekeeper.destination(npcId, routeId).price, 150);
    }
    assert.strictEqual(Gatekeeper.destination(npcId, npcId === 8698 ? 123 : 122), null);
    assert.strictEqual(packets[1][0], 0x25);
}
assert.deepStrictEqual(Gatekeeper.destination(8698, 131), { locX: 43799, locY: -47727, locZ: -798, price: 150 });
console.log('Goddard/Rune: 182 new spawns, 24 shops, 9 warehouses, guard PK rules and internal Rune routes passed');
