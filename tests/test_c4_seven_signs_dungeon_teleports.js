'use strict';

const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const DungeonTeleports = invoke('GameServer/World/C4SevenSignsDungeonTeleports');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const NpcTalk = invoke('GameServer/World/Generics/NpcTalk');
const SevenSignsDungeonTeleport = invoke('GameServer/World/Generics/NpcBypasses/SevenSignsDungeonTeleport');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');

const expected = [
    ['Necropolis of Sacrifice', 8095, [-41564, 209356, -5088, 8192], [-41570, 209785, -5089], 8103, [-41571, 210126, -5080, 18318], [-41567, 209292, -5091]],
    ['Necropolis of Pilgrims', 8096, [45248, 124352, -5408, 16500], [45251, 123890, -5415], 8104, [45280, 123504, -5408, 49000], [45250, 124366, -5417]],
    ['Necropolis of Worshipers', 8097, [110848, 174016, -5432, 16384], [111273, 174015, -5417], 8105, [111600, 174016, -5432, 16500], [110818, 174010, -5443]],
    ['Necropolis of Patriots', 8098, [-22224, 77376, -5168, 32500], [-21726, 77385, -5177], 8106, [-21392, 77376, -5168, 16500], [-22197, 77369, -5177]],
    ['Necropolis of Ascetics', 8099, [-52784, 79104, -4736, 33000], [-52254, 79103, -4743], 8107, [-51920, 79104, -4736, 0], [-52716, 79106, -4745]],
    ['Necropolis of Martyrs', 8100, [117872, 132800, -4824, 32500], [118308, 132800, -4833], 8108, [118640, 132800, -4824, 16500], [117793, 132810, -4835]],
    ['Necropolis of Saints', 8101, [82688, 209216, -5432, 32500], [83000, 209213, -5443], 8109, [83440, 209216, -5432, 16500], [82608, 209225, -5443]],
    ['Necropolis of the Disciples', 8102, [171936, -17600, -4896, 48457], [172251, -17605, -4903], 8110, [172649, -17599, -4896, 32768], [171902, -17595, -4905]],
    ['Catacomb of the Heretics', 8114, [42590, 143933, -5376, 16384], [43050, 143933, -5383], 8120, [43375, 143937, -5376, 16384], [42514, 143917, -5385]],
    ['Catacomb of the Branded', 8115, [45800, 170296, -4976, 0], [46217, 170290, -4983], 8121, [46578, 170304, -4976, 134], [45770, 170299, -4985]],
    ['Catacomb of the Apostate', 8116, [77250, 78388, -5120, 60891], [78042, 78404, -5128], 8122, [78055, 78405, -5120, 30488], [77225, 78362, -5119]],
    ['Catacomb of the Witch', 8117, [140052, 79682, -5424, 16384], [140404, 79678, -5431], 8123, [140771, 79682, -5424, 16384], [139965, 79678, -5433]],
    ['Catacomb of Dark Omens', 8118, [-19847, 13500, -4896, 624], [-19500, 13508, -4905], 8124, [-19085, 13504, -4896, 64238], [-19931, 13502, -4905]],
    ['Catacomb of the Forbidden Path', 8119, [113505, 84534, -6536, 64055], [113865, 84543, -6545], 8125, [114286, 84543, -6536, 946], [113429, 84540, -6545]]
];

const authored = DungeonTeleports.DUNGEONS.map((dungeon) => [
    dungeon.name,
    dungeon.outside.npcId,
    dungeon.outside.spawn,
    dungeon.outside.destination,
    dungeon.inside.npcId,
    dungeon.inside.spawn,
    dungeon.inside.destination
]);
assert.deepStrictEqual(authored, expected, 'all fourteen dungeons must retain their exact Lisvus NPC and teleport rows');

DataCache.init();
const expectedNpcIds = expected.flatMap((row) => [row[1], row[4]]);
assert.strictEqual(new Set(expectedNpcIds).size, 28, 'every dungeon side must use a distinct C4 Gatekeeper Ziggurat id');
assert.deepStrictEqual(DungeonTeleports.npcs.map((npc) => npc.selfId), expectedNpcIds);
assert.ok(DungeonTeleports.npcs.every((npc) =>
    npc.template.kind === 'Teleporter'
    && npc.template.name === 'Gatekeeper Ziggurat'
    && npc.collision.radius === 7
    && npc.collision.size === 15
));
assert.deepStrictEqual(
    expectedNpcIds.map((npcId) => DataCache.npcs.filter((npc) => npc.selfId === npcId).length),
    Array(28).fill(1),
    'all sourced Ziggurat templates must load exactly once'
);

const spawnGroup = DataCache.npcSpawns.find((group) => group.selfId === 'c4-seven-signs-gatekeeper-ziggurats');
assert.ok(spawnGroup, 'the Seven Signs Ziggurat spawn group must load');
assert.strictEqual(spawnGroup.spawns.length, 28);
assert.ok(spawnGroup.spawns.every((spawn) =>
    spawn.total === 1 && spawn.respawn === 15 && spawn.bias === 0 && spawn.coords.length === 1
));

const geodataRegions = [...new Set(DungeonTeleports.DUNGEONS.flatMap((dungeon) =>
    [dungeon.outside, dungeon.inside].flatMap((endpoint) => [endpoint.spawn, endpoint.destination])
        .map((coords) => GeodataEngine.getRegionKey(coords[0], coords[1]))
))].map((key) => key.split('_').map(Number));
const geodataAvailable = verifyGeodataWhenAvailable(
    GeodataEngine,
    geodataRegions,
    'Seven Signs dungeon teleports',
    () => {}
);

for (const dungeon of DungeonTeleports.DUNGEONS) {
    for (const endpoint of [dungeon.outside, dungeon.inside]) {
        const spawn = endpoint.spawn;
        const destination = endpoint.destination;
        assert.deepStrictEqual(DungeonTeleports.destination(endpoint.npcId), {
            locX: destination[0], locY: destination[1], locZ: destination[2]
        });
        if (geodataAvailable) {
            assert.ok(Math.abs(GeodataEngine.getHeight(...spawn.slice(0, 3)) - spawn[2]) <= 8,
                `${dungeon.name} Ziggurat must stand on its sourced geodata layer`);
            assert.ok(Math.abs(GeodataEngine.getHeight(...destination) - destination[2]) <= 16,
                `${dungeon.name} teleport must land on its sourced geodata layer`);
        }
    }
    if (geodataAvailable) {
        assert.strictEqual(
            GeodataEngine.hasLineOfSight(...dungeon.outside.spawn.slice(0, 3), ...dungeon.inside.spawn.slice(0, 3)),
            false,
            `${dungeon.name} must retain the sealed geodata portal between its Ziggurat pair`
        );
    }
    assert.match(DungeonTeleports.html(dungeon.outside.npcId), /Enter the Forbidden Sanctum/);
    assert.match(DungeonTeleports.html(dungeon.inside.npcId), /Leave the Forbidden Sanctum/);
}
assert.strictEqual(DungeonTeleports.destination(7006), null, 'an unrelated gatekeeper must not resolve a dungeon teleport');
assert.strictEqual(DungeonTeleports.html(7006), null, 'an unrelated NPC must not expose the dungeon bypass');

const talkPackets = [];
const talkSession = { dataSendToMe: (packet) => talkPackets.push(packet) };
NpcTalk(talkSession, {
    fetchSelfId: () => 8095,
    fetchId: () => 9908095,
    fetchName: () => 'Gatekeeper Ziggurat',
    fetchTitle: () => ''
});
assert.strictEqual(talkPackets[0][0], 0x0f, 'talking to an outside Ziggurat must open its entry HTML');
assert.ok(talkPackets[0].includes(Buffer.from('Enter the Forbidden Sanctum', 'ucs2')));
assert.strictEqual(talkPackets[1][0], 0x25, 'Ziggurat talk must terminate the interaction packet sequence');

let teleported = null;
const originalInvoke = global.invoke;
global.invoke = function mockedInvoke(route) {
    if (route === path.actor) {
        return { teleportTo: (session, actor, destination) => { teleported = { session, actor, destination }; } };
    }
    return originalInvoke(route);
};
try {
    const actor = {};
    const session = { actor, activeNpcTalk: { selfId: 8095 } };
    SevenSignsDungeonTeleport(session);
    assert.strictEqual(teleported.session, session);
    assert.strictEqual(teleported.actor, actor);
    assert.deepStrictEqual(teleported.destination, { locX: -41570, locY: 209785, locZ: -5089 });

    const rejectedPackets = [];
    teleported = null;
    SevenSignsDungeonTeleport({
        actor,
        activeNpcTalk: { selfId: 7006 },
        dataSendToMe: (packet) => rejectedPackets.push(packet)
    });
    assert.strictEqual(teleported, null, 'a forged dungeon bypass from another NPC must not teleport');
    assert.strictEqual(rejectedPackets[0][0], 0x25);
} finally {
    global.invoke = originalInvoke;
}

console.log('C4 Seven Signs dungeon Ziggurat checks passed');
