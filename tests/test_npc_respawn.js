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

// Every spawn of a datapack template, a respawn included, starts from the
// template's data: the same fields, the same NpcInfo and the same fetch results
// as a flat copy of the row; what one NPC writes stays its own.
const DataCache = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
DataCache.init();
const spawnWorld = { npc: { spawns: [], nextId: 2000000, periodMode: 'day' }, user: { sessions: [] }, addNpcToGrid() {} };
const at = (n) => ({ locX: 1000 + n, locY: -2000 - n, locZ: -3000, head: 1234 });
const flatCopy = (row, coords) => new Npc(spawnWorld.npc.nextId - 1, { ...utils.crushOb(row), ...coords });
const fieldsOf = (model) => { const fields = {}; for (const key in model) fields[key] = model[key]; return fields; };
const fetchers = (() => {
    const names = new Set();
    for (let proto = Npc.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        Object.getOwnPropertyNames(proto).filter((name) => name.startsWith('fetch') && proto[name].length === 0)
            .forEach((name) => names.add(name));
    }
    return [...names];
})();
const observed = (npc) => {
    const out = { fields: fieldsOf(npc.model), npcInfo: ServerResponse.npcInfo(npc).toString('hex') };
    for (const name of fetchers) {
        try { out[name] = npc[name](); } catch (error) { out[name] = `throws ${error?.message}`; }
    }
    return out;
};
const ServerResponse = invoke('GameServer/Network/Response');
assert(DataCache.npcs.length > 2000, 'the whole datapack is checked');
DataCache.npcs.forEach((row, n) => {
    const npc = SpawnNpcs.spawnChildNpc(spawnWorld, row, at(n));
    assert.deepStrictEqual(observed(npc), observed(flatCopy(row, at(n))), `template ${row.selfId} spawns as its row`);
});

const row = DataCache.npcRow(558);
const [first, second] = [SpawnNpcs.spawnChildNpc(spawnWorld, row, at(1)), SpawnNpcs.spawnChildNpc(spawnWorld, row, at(2))];
const untouched = observed(second);
first.setTitle('Champion'); first.setLevel(80); first.setMaxHp(9999); first.setHp(1); first.setMp(0);
first.setLocXYZH({ locX: 5, locY: 6, locZ: 7, head: 8 }); first.setStateDead(true); first.setCollectivePAtk(500);
first.model.spoil = { spoiled: true, swept: false }; first.model.dropAttackerLevels = [40];
assert.deepStrictEqual([first.fetchTitle(), first.fetchLevel(), first.fetchMaxHp(), first.fetchHp(), first.fetchLocX(),
    first.fetchCollectivePAtk(), first.isSpoil()], ['Champion', 80, 9999, 1, 5, 500, true], 'an NPC reads its own writes');
assert.deepStrictEqual(observed(second), untouched, 'one NPC\'s writes never reach another of its template');
const respawned = SpawnNpcs.spawnChildNpc(spawnWorld, row, at(3));
assert.deepStrictEqual(observed(respawned), observed(flatCopy(row, at(3))), 'a respawn starts from the template, not the last NPC');

// Athrea's quest chest edits its own cloned template; a datapack chest keeps the row's HP.
const chestRow = DataCache.npcRow(5173);
const questChest = SpawnNpcs.spawnQuestNpc(spawnWorld, { selfId: 5173, ...at(4), questId: 501 });
const chest = SpawnNpcs.spawnChildNpc(spawnWorld, chestRow, at(5));
assert.strictEqual(questChest.fetchMaxHp(), 1, 'the quest chest has its quest HP');
assert.strictEqual(chest.fetchMaxHp(), chestRow.vitals.maxHp, 'a datapack chest keeps its template HP');

console.log('NPC respawn regression checks passed');
