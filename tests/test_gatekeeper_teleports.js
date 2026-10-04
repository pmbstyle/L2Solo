const assert = require('assert');

require('../src/Global');

const GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
const LateTownGatekeepers = invoke('GameServer/World/C4LateTownGatekeepers');
const QuestService = invoke('GameServer/Quest/QuestService');

const cityGatekeepers = [7006, 7059, 7080, 7134, 7146, 7162, 7177, 7233, 7256, 7320, 7540, 7576, 7848, 8275, 8320];
for (const npcId of cityGatekeepers) {
    assert.ok(GatekeeperTeleports.html(npcId), `gatekeeper ${npcId} must have a C4 destination list`);
    assert.ok(GatekeeperTeleports.lists[npcId].length >= 4, `gatekeeper ${npcId} must not be reduced to a one-link list`);
    for (const [id] of GatekeeperTeleports.lists[npcId]) {
        assert.ok(GatekeeperTeleports.destination(npcId, id), `gatekeeper ${npcId} destination ${id} must resolve`);
    }
    assert.match(GatekeeperTeleports.menu(npcId, false), /gatekeeper-teleport/, `gatekeeper ${npcId} must always offer teleport from its main dialog`);
    assert.doesNotMatch(GatekeeperTeleports.menu(npcId, false), /gatekeeper-quest/, `gatekeeper ${npcId} must not offer an unavailable quest`);
    assert.match(GatekeeperTeleports.menu(npcId, true), /gatekeeper-teleport/, `quest-capable gatekeeper ${npcId} must keep teleport in its main dialog`);
    assert.match(GatekeeperTeleports.menu(npcId, true), /gatekeeper-quest/, `quest-capable gatekeeper ${npcId} must offer the quest branch`);
}

assert.strictEqual(GatekeeperTeleports.destination(7006, 18), null, 'a gatekeeper must not expose another city’s route by raw id');
assert.deepStrictEqual(
    GatekeeperTeleports.destination(7006, 462),
    { locX: 49315, locY: 248452, locZ: -5960, price: 2500 },
    'Roxxy must teleport to the interior geodata layer of Elven Ruins'
);
assert.strictEqual(
    GatekeeperTeleports.destination(7006, 1003),
    null,
    'Roxxy must not replace the interior Elven Ruins route with its surface entrance'
);
assert.match(GatekeeperTeleports.html(7006), /gatekeeper-teleport 462/, 'Roxxy must expose the interior Elven Ruins route');
assert.deepStrictEqual(GatekeeperTeleports.destination(7059, 19), { locX: 83400, locY: 147943, locZ: -3404, price: 8100 });
assert.match(GatekeeperTeleports.html(7080), /Dragon Valley - 6400 Adena/);
assert.match(GatekeeperTeleports.html(7848), /Forsaken Plains - 840 Adena/);
assert.match(GatekeeperTeleports.html(7233), /Enchanted Valley/);
assert.match(GatekeeperTeleports.html(8275), /Forge of the Gods/);
assert.match(GatekeeperTeleports.html(8320), /Forest of the Dead/);
for (const npcId of [8275, 8320]) {
    assert.ok(LateTownGatekeepers.npcs.some((npc) => npc.selfId === npcId), `NPC template ${npcId} must be present`);
    assert.ok(LateTownGatekeepers.spawns.some((group) => group.spawns.some((spawn) => spawn.selfId === npcId)), `NPC ${npcId} must spawn`);
}
for (const npcId of [8256, 8300]) {
    assert.ok(LateTownGatekeepers.npcs.some((npc) => npc.selfId === npcId && npc.template.kind === 'Merchant'), `late-town merchant ${npcId} must be present`);
    assert.ok(LateTownGatekeepers.spawns.some((group) => group.spawns.some((spawn) => spawn.selfId === npcId)), `late-town merchant ${npcId} must spawn`);
}
(async () => {
    const session = {
        actor: { fetchLevel: () => 10, fetchRace: () => 0 },
        questStatesLoaded: true,
        questStates: new Map()
    };
    assert.strictEqual(await QuestService.hasTalk(session, { fetchSelfId: () => 7006 }), true, 'Roxxy must expose the quest branch when Step into the Future can start');
    assert.strictEqual(await QuestService.hasTalk(session, { fetchSelfId: () => 7059 }), false, 'a gatekeeper without a relevant quest must stay teleport-only');
    // Siff/Ciffon at the entrance uses the free C4 route, not Roxxy's paid town route.
    const destination = { locX: 48736, locY: 248463, locZ: -6162, price: 0 };
    assert.deepStrictEqual(GatekeeperTeleports.destination(7427, 30), destination);
    assert.strictEqual(GatekeeperTeleports.destination(7006, 30), null);
    assert.strictEqual(GatekeeperTeleports.destination(7427, 462), null);
    const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
    const Teleport = invoke('GameServer/World/Generics/NpcBypasses/GatekeeperTeleport');
    const Generics = invoke(path.actor);
    const originalTeleport = Generics.teleportTo;
    const packets = [];
    const arrivals = [];
    const entranceSession = {
        actor: { fetchLevel: () => 20, fetchRace: () => 0, backpack: {
            fetchItemFromSelfId: () => null,
            deleteItem: () => assert.fail('Entrance teleport must not charge Adena')
        } },
        questStatesLoaded: true, questStates: new Map(),
        dataSendToMe: packet => packets.push(packet)
    };
    try {
        Generics.teleportTo = (session, actor, coords) => arrivals.push(coords);
        NpcTalk(entranceSession, {
            fetchSelfId: () => 7427, fetchId: () => 1007427,
            fetchName: () => 'Siff', fetchTitle: () => 'Gatekeeper'
        });
        await new Promise(resolve => setImmediate(resolve));
        assert(packets.some(packet => packet[0] === 0x0f && packet.toString('utf16le', 5).includes('gatekeeper-teleport')),
            'Talking to Siff at level 20 must offer teleport');
        packets.length = 0;
        Teleport(entranceSession, ['gatekeeper-teleport']);
        assert(packets[0].toString('utf16le', 5).includes('gatekeeper-teleport 30'));
        Teleport(entranceSession, ['gatekeeper-teleport', '30']);
        assert.deepStrictEqual(arrivals, [destination], 'Level 20 with no Adena must enter the ruins');

        // The pre-C4 route "teleport <id>" (no NPC, no Adena) and its pages are gone.
        invoke('GameServer/DataCache').init();
        const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');
        packets.length = 0;
        NpcTalkResponse(entranceSession, { link: 'teleport 1009' });
        NpcTalkResponse(entranceSession, { link: 'html Gatekeeper/7080-teleport' });
        assert.deepStrictEqual(arrivals, [destination], 'a forged old teleport bypass must not move the player');
        assert.strictEqual(packets.length, 0, 'the old gatekeeper teleport page must not be served');

        // C4: a gatekeeper refuses a player with karma after the choice and takes no Adena.
        for (const karma of [500, 0]) {
            const paidPackets = [];
            const paidArrivals = arrivals.length;
            let adenaTaken = 0;
            const adena = { fetchId: () => 57001, fetchAmount: () => 10000 };
            const paidSession = {
                actor: { fetchId: () => 2000901, fetchName: () => 'Payer', fetchKarma: () => karma,
                    backpack: {
                        fetchItemFromSelfId: () => adena,
                        deleteItem: (_session, _id, amount, callback) => { adenaTaken += amount; callback(); }
                    } },
                activeNpcTalk: { selfId: 7059, objectId: 1007059 },
                dataSendToMe: packet => paidPackets.push(packet)
            };
            Teleport(paidSession, ['gatekeeper-teleport', '19']);
            if (karma > 0) {
                assert.strictEqual(arrivals.length, paidArrivals, 'a gatekeeper must not teleport a player with karma');
                assert.strictEqual(adenaTaken, 0, 'a refused player with karma keeps the Adena');
                assert(paidPackets.some(packet => packet[0] === 0x4a
                    && packet.includes(Buffer.from('Go away, you\'re not welcome here.', 'ucs2'))),
                'a gatekeeper must tell a player with karma he is not welcome');
            } else {
                assert.deepStrictEqual(arrivals[arrivals.length - 1], { locX: 83400, locY: 147943, locZ: -3404, price: 8100 },
                    'a player without karma still teleports');
                assert.strictEqual(adenaTaken, 8100, 'a player without karma pays the fee');
            }
        }
    } finally { Generics.teleportTo = originalTeleport; }
    console.log('gatekeeper teleport checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
