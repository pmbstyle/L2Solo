const assert = require('assert');

require('../src/Global');

const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');

assert.strictEqual(SpawnNpcs.respawnDelayMs({ respawn: 60, bias: 0 }, () => 0.5), 60000, 'fixed NPC respawn should use its datapack seconds');
assert.strictEqual(SpawnNpcs.respawnDelayMs({ respawn: 60, bias: 10 }, () => 0), 50000, 'respawn bias should permit the sourced early bound');
assert.strictEqual(SpawnNpcs.respawnDelayMs({ respawn: 60, bias: 10 }, () => 1), 70000, 'respawn bias should permit the sourced late bound');
assert.strictEqual(SpawnNpcs.shouldRespawn({ respawn: -1 }), false, 'datapack sentinel -1 must not schedule an NPC respawn');
assert.strictEqual(SpawnNpcs.shouldRespawn({ respawn: 0 }), false, 'zero respawn must not schedule an NPC respawn');
assert.strictEqual(SpawnNpcs.shouldRespawn({ respawn: 60 }), true, 'positive respawn must schedule an NPC respawn');

const fiveHours = 5 * 60 * 60 * 1000;
for (const respawn of [60, 9000, 86400]) {
    const definition = { npc: { template: { raidBoss: true } }, spawn: { respawn, bias: 1800 } };
    for (const roll of [0, 0.5, 1]) {
        assert.strictEqual(SpawnNpcs.respawnDelayForDefinitionMs(definition, () => roll), fiveHours,
            'every raid boss uses exactly five real hours, without datapack randomness');
    }
}
assert.strictEqual(SpawnNpcs.respawnDelayForDefinitionMs({ npc: { template: {} },
    spawn: { respawn: 60, bias: 10 } }, () => 0), 50000, 'ordinary mobs retain their sourced timer');

const State = invoke('GameServer/World/RaidBossState');
const Decay = invoke('GameServer/World/Generics/NpcDecay');
const Sweep = invoke('GameServer/Npc/SpoilSweep');
const originals = [State.markDefeated, SpawnNpcs.scheduleRaidBossRespawn, Decay.schedule, Sweep.corpseTime, Date.now];
try {
    const deathAt = 1790434932348;
    Date.now = () => deathAt;
    const recorded = [];
    State.markDefeated = (_npc, at) => { recorded.push(at); return Promise.resolve(true); };
    SpawnNpcs.scheduleRaidBossRespawn = (_world, _definition, at) => { recorded.push(at); };
    Decay.schedule = () => {};
    Sweep.corpseTime = () => 60000;
    invoke('GameServer/World/Generics/RemoveNpc').call({ npc: {}, npcRewards() {} }, {}, {
        fetchId: () => 1,
        spawnDefinition: { npc: { template: { raidBoss: true } }, spawn: { respawn: 86400, bias: 43200 } }
    });
    assert.deepStrictEqual(recorded, [deathAt + fiveHours, deathAt + fiveHours],
        'hot death persists and schedules five wall-clock hours from death, not from corpse decay');
} finally {
    [State.markDefeated, SpawnNpcs.scheduleRaidBossRespawn, Decay.schedule, Sweep.corpseTime, Date.now] = originals;
}

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
