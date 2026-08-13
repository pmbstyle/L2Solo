const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
const bosses = require('../data/Npcs/c4_low_level_raid_bosses.json');
const spawnAreas = require('../data/Npcs/Spawns/c4_low_level_raid_bosses.json');
const rewards = require('../data/Npcs/Rewards/c4_low_level_raid_bosses.json');
const sourceSkillRows = require('../data/Npcs/Skills/c4_low_level_raid_bosses.json');

const expectedBosses = new Map([
    [10019, { name: 'Pan Dryad', level: 25, hp: 52415, coords: [7352, 169433, -3172], combat: [4175, 4732, 4172] }],
    [10127, { name: 'Langk Matriarch Rashkos', level: 24, hp: 49872, coords: [-47634, 219274, -1936], combat: [4175, 4732, 4172] }],
    [10272, { name: 'Partisan Leader Talakin', level: 28, hp: 60567, coords: [49194, 127999, -3161], combat: [4174, 4721, 4172] }],
    [10365, { name: 'Patriarch Kuroboros', level: 26, hp: 47184, coords: [-62171, 190489, -3160], combat: [4174, 4723, 4738] }],
    [10372, { name: 'Discarded Guardian', level: 20, hp: 34766, coords: [48000, 243376, -6611], combat: [4173, 4733, 4172] }]
]);

assert.strictEqual(bosses.length, expectedBosses.size, 'the first C4 slice must contain five solo raid bosses');
assert.strictEqual(rewards.length, expectedBosses.size, 'every imported raid boss must have a reward table');
assert.strictEqual(sourceSkillRows.length, 38, 'all 38 sourced NPC-skill bindings must be imported');
assert.strictEqual(spawnAreas.length, 1);
assert.strictEqual(spawnAreas[0].selfId, 'c4-low-level-raid-bosses');
assert.strictEqual(spawnAreas[0].spawns.length, expectedBosses.size);

DataCache.init();

for (const [bossId, expected] of expectedBosses) {
    const template = bosses.find((entry) => entry.selfId === bossId);
    assert(template, `raid boss ${bossId} must be imported`);
    assert.strictEqual(template.template.kind, 'Boss');
    assert.strictEqual(template.template.raidBoss, true);
    assert.strictEqual(template.template.name, expected.name);
    assert.strictEqual(template.template.title, 'Raid Boss');
    assert.strictEqual(template.template.level, expected.level);
    assert.strictEqual(template.vitals.maxHp, expected.hp);

    const loaded = DataCache.npcs.filter((entry) => entry.selfId === bossId);
    assert.strictEqual(loaded.length, 1, `raid boss ${bossId} must be loaded exactly once`);
    const npc = new Npc(900000 + bossId, utils.crushOb(loaded[0]));
    assert.strictEqual(npc.fetchIsRaidBoss(), true);
    assert.deepStrictEqual(
        NpcSkills.combatSkillsFor(npc).map((skill) => skill.fetchSelfId()),
        expected.combat,
        `${expected.name} must resolve its sourced combat skill set`
    );
    assert.strictEqual(EffectStats.multiplier(npc, 'rootVuln'), 0.1,
        `${expected.name} must apply sourced full-magic resistance`);

    const spawn = spawnAreas[0].spawns.find((entry) => entry.selfId === bossId);
    assert(spawn, `raid boss ${bossId} must have a spawn`);
    assert.deepStrictEqual(
        [spawn.coords[0].locX, spawn.coords[0].locY, spawn.coords[0].locZ],
        expected.coords,
        `${expected.name} must preserve its exact Lisvus coordinates`
    );
    assert.strictEqual(spawn.respawn, 86400);
    assert.strictEqual(spawn.bias, 43200);
    assert.strictEqual(SpawnNpcs.respawnDelayMs(spawn, () => 0), 43200000,
        'raid-boss respawn must preserve the sourced 12 hour minimum');
    assert.strictEqual(SpawnNpcs.respawnDelayMs(spawn, () => 1), 129600000,
        'raid-boss respawn must preserve the sourced 36 hour maximum');

    const reward = rewards.find((entry) => entry.selfId === bossId);
    assert(reward?.rewards.length > 0, `${expected.name} must retain sourced grouped drops`);
    reward.rewards.flatMap((group) => group.items).forEach((item) => {
        assert(DataCache.items.some((entry) => entry.selfId === item.selfId),
            `raid-boss drop item ${item.selfId} must have a loaded template`);
    });
}

assert.deepStrictEqual(
    bosses.map((boss) => boss.selfId).filter((id) => [12001, 12052, 12169, 12211].includes(id)),
    [],
    'grand/world bosses must remain outside the ordinary raid-boss slice'
);

const pan = new Npc(910019, utils.crushOb(DataCache.npcs.find((entry) => entry.selfId === 10019)));
const haste = NpcSkills.forNpc(pan).find((skill) => skill.fetchSelfId() === 4175);
assert.strictEqual(haste.fetchTargetKind(), 'self');
assert.strictEqual(haste.fetchSemantic().stats.pAtkSpdMul, 1.5);
assert.strictEqual(haste.fetchBuffTime(), 60000);
const shock = NpcSkills.forNpc(pan).find((skill) => skill.fetchSelfId() === 4172);
assert.strictEqual(shock.fetchTargetKind(), 'enemy');
assert.strictEqual(shock.fetchSemantic().sourceTarget, 'aura');
assert.strictEqual(shock.fetchSemantic().radius, 200);
assert.strictEqual(shock.fetchSemantic().effect, 'stun');

console.log('C4 low-level raid bosses ok');
