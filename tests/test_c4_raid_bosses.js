const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
const bosses = require('../data/Npcs/c4_raid_bosses.json');
const spawnAreas = require('../data/Npcs/Spawns/c4_raid_bosses.json');
const rewards = require('../data/Npcs/Rewards/c4_raid_bosses.json');
const skillRows = require('../data/Npcs/Skills/c4_raid_bosses.json');
const minions = require('../data/Npcs/Minions/c4_raid_bosses.json');

assert.strictEqual(bosses.length, 174, 'the remaining ordinary C4 raid-boss slice must contain 174 bosses');
assert.strictEqual(spawnAreas.length, 1);
assert.strictEqual(spawnAreas[0].selfId, 'c4-raid-bosses');
assert.strictEqual(spawnAreas[0].spawns.length, 174, 'every imported boss must have one ordinary spawn');
assert.strictEqual(rewards.length, 174, 'every imported boss must have a reward table');
assert.strictEqual(skillRows.length, 1173, 'all sourced NPC-skill bindings must be imported');
assert.strictEqual(minions.length, 284, 'sourced minion groups must be preserved for the future manager');
assert.strictEqual(new Set(bosses.map((boss) => boss.selfId)).size, 174);
assert.deepStrictEqual(
    bosses.map((boss) => boss.selfId).filter((id) => [12001, 12052, 12169, 12211].includes(id)),
    [],
    'grand/world bosses must remain outside the ordinary raid-boss slice'
);

DataCache.init();

const sourceRowsByNpc = new Map();
skillRows.forEach((row) => {
    if (!sourceRowsByNpc.has(row.npcId)) sourceRowsByNpc.set(row.npcId, []);
    sourceRowsByNpc.get(row.npcId).push(row);
});
for (const template of bosses) {
    assert.strictEqual(template.template.kind, 'Boss');
    assert.strictEqual(template.template.raidBoss, true);
    assert.strictEqual(DataCache.npcs.filter((entry) => entry.selfId === template.selfId).length, 1,
        `raid boss ${template.selfId} must be loaded exactly once`);
    const npc = new Npc(900000 + template.selfId, utils.crushOb(template));
    const resolved = NpcSkills.forNpc(npc);
    const sourced = sourceRowsByNpc.get(template.selfId) || [];
    assert.strictEqual(resolved.length, sourced.length, `${template.template.name} must resolve every sourced skill row`);
    assert.deepStrictEqual(
        resolved.map((skill) => skill.fetchSelfId()).sort((a, b) => a - b),
        sourced.map((row) => row.skillId).sort((a, b) => a - b),
        `${template.template.name} must retain its source skill IDs`
    );
}

const allDropItems = rewards.flatMap((entry) => [entry.rewards, entry.spoils]).flat(2).flatMap((group) => group.items);
allDropItems.forEach((item) => {
    assert(DataCache.items.some((entry) => entry.selfId === item.selfId), `raid-boss drop item ${item.selfId} must have a loaded template`);
});

const specialRespawn = spawnAreas[0].spawns.find((spawn) => spawn.selfId === 10328);
assert(specialRespawn, 'source raid boss 10328 must retain its special respawn window');
assert.strictEqual(specialRespawn.respawn, 9000);
assert.strictEqual(specialRespawn.bias, 1800);
assert.strictEqual(SpawnNpcs.respawnDelayMs(specialRespawn, () => 0), 7200000);
assert.strictEqual(SpawnNpcs.respawnDelayMs(specialRespawn, () => 1), 10800000);

const bossesWithMinions = new Set(minions.map((entry) => entry.bossId));
assert(bossesWithMinions.size > 100, 'most sourced raid bosses should expose minion groups for the future manager');
minions.forEach((entry) => {
    assert(bosses.some((boss) => boss.selfId === entry.bossId), `minion group references unknown boss ${entry.bossId}`);
    assert(Number.isInteger(entry.minionId) && entry.minionId > 0);
    assert(Number.isInteger(entry.min) && Number.isInteger(entry.max) && entry.min > 0 && entry.max >= entry.min);
});

console.log('C4 raid bosses ok');
