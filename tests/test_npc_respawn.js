const assert = require('assert');

require('../src/Global');

const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');

assert.strictEqual(SpawnNpcs.respawnDelayMs({ respawn: 60, bias: 0 }, () => 0.5), 60000, 'fixed NPC respawn should use its datapack seconds');
assert.strictEqual(SpawnNpcs.respawnDelayMs({ respawn: 60, bias: 10 }, () => 0), 50000, 'respawn bias should permit the sourced early bound');
assert.strictEqual(SpawnNpcs.respawnDelayMs({ respawn: 60, bias: 10 }, () => 1), 70000, 'respawn bias should permit the sourced late bound');
assert.strictEqual(SpawnNpcs.shouldRespawn({ respawn: -1 }), false, 'datapack sentinel -1 must not schedule an NPC respawn');
assert.strictEqual(SpawnNpcs.shouldRespawn({ respawn: 0 }), false, 'zero respawn must not schedule an NPC respawn');
assert.strictEqual(SpawnNpcs.shouldRespawn({ respawn: 60 }), true, 'positive respawn must schedule an NPC respawn');

const packets = [];
const npc = {
    fetchId: () => 1014747,
    fetchLocX: () => 0,
    fetchLocY: () => 0
};
const sessionAt = (x, online = true) => ({
    actor: {
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchIsOnline: () => online
    },
    dataSendToMe(packet) { packets.push(packet); }
});

SpawnNpcs.notifyNearby({
    user: {
        sessions: [sessionAt(5999), sessionAt(6001), sessionAt(10, false)]
    }
}, npc, {
    npcInfo: (entry) => Buffer.from([0x16, entry.fetchId() & 0xff])
});

assert.strictEqual(packets.length, 1, 'a respawn must announce itself to nearby online players immediately');
assert.strictEqual(packets[0][0], 0x16, 'the respawn announcement must be NpcInfo');

console.log('NPC respawn regression checks passed');
