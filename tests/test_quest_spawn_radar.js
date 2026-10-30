const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const QuestService = invoke('GameServer/Quest/QuestService');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');

DataCache.init();

function viewer(locX, locY) {
    return {
        actor: {
            fetchIsOnline: () => true,
            fetchLocX: () => locX,
            fetchLocY: () => locY
        },
        sent: [],
        dataSendToMe(packet) {
            this.sent.push(packet);
            NpcVisibility.trackNpcPacket(this, packet);
        }
    };
}

const nearby = viewer(1000, 2000);
const distant = viewer(10000, 2000);
const world = {
    npc: { nextId: 4000000, spawns: [], grid: {} },
    user: { sessions: [nearby, distant] },
    indexSpawnsInGrid() {
        this.npc.grid = {};
        this.npc.spawns.forEach((npc) => {
            const key = `${Math.floor(npc.fetchLocX() / 6000)}_${Math.floor(npc.fetchLocY() / 6000)}`;
            (this.npc.grid[key] ||= []).push(npc);
        });
    }
};

const questNpc = SpawnNpcs.spawnQuestNpc(world, {
    selfId: 5032,
    locX: 1000,
    locY: 2000,
    locZ: -3000,
    ownerId: 77,
    questId: 409
});
assert.ok(questNpc, 'a valid quest NPC template must spawn');
assert.strictEqual(questNpc.spawnDefinition, null, 'quest NPCs must not enter static respawn');
assert.deepStrictEqual(
    { ownerId: questNpc.questSpawn.ownerId, questId: questNpc.questSpawn.questId },
    { ownerId: 77, questId: 409 },
    'quest spawn ownership must stay attached to the NPC'
);
assert.strictEqual(world.npc.spawns.length, 1);
assert.strictEqual(nearby.sent[0][0], 0x16, 'nearby clients must receive NpcInfo immediately');
assert.strictEqual(distant.sent.length, 0, 'distant clients must not receive unrelated quest NPCs');
assert.ok(Object.values(world.npc.grid).flat().includes(questNpc), 'quest NPC must enter the spatial grid');
assert.strictEqual(SpawnNpcs.despawnQuestNpc(world, questNpc), true);
assert.strictEqual(world.npc.spawns.length, 0, 'despawn must remove the temporary NPC');
assert.strictEqual(nearby.sent.at(-1)[0], 0x12, 'despawn must clean the object from known clients');

const radarSession = { sent: [], dataSendToMe(packet) { this.sent.push(packet); } };
assert.strictEqual(QuestService.addRadar(radarSession, -16760, 78268, -3480), true);
assert.strictEqual(radarSession.sent.length, 2, 'a waypoint requires the C4 arm and marker packets');
assert.strictEqual(radarSession.sent[0][0], 0xeb);
assert.strictEqual(radarSession.sent[0].readInt32LE(1), 2);
assert.strictEqual(radarSession.sent[0].readInt32LE(5), 2);
assert.strictEqual(radarSession.sent[1].readInt32LE(1), 0);
assert.strictEqual(radarSession.sent[1].readInt32LE(5), 1);
assert.strictEqual(QuestService.removeRadar(radarSession, -16760, 78268, -3480), true);
assert.strictEqual(radarSession.sent.at(-1).readInt32LE(1), 1, 'removal must send RadarControl delete');

// Cat's Eye Bandit (Q403 Path to Rogue target) stands at its nine Mobius C4 points.
const bandits = DataCache.npcSpawns.flatMap((entry) => entry.spawns).filter((spawn) => spawn.selfId === 5038);
assert.strictEqual(bandits.flatMap((spawn) => spawn.coords).length, 9, 'Cat’s Eye Bandit must have all nine source spawns');
assert.ok(bandits.flatMap((spawn) => spawn.coords).some((coord) =>
    coord.locX === -49201 && coord.locY === 147781 && coord.locZ === -2784 && coord.head === 14037));

console.log('quest spawn and radar checks passed');
