const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const baseSpawns = require('../data/Npcs/Spawns/spawns.json');
const importedNpcs = require('../data/Npcs/c4_necropolis_of_the_disciples.json');
const newSkillBindings = require('../data/Npcs/Skills/c4_necropolis_of_the_disciples.json');
const witchSkillBindings = require('../data/Npcs/Skills/c4_catacomb_of_the_witch.json');

DataCache.init();

const mobIds = [1161, 1162, 1164, 1165, 1183, 1184, 1185, 1186, 1204, 1205, 1206, 1207, 1228, 1229, 1230, 1231];
const reusedMobIds = new Set([1183, 1204]);
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-necropolis-of-the-disciples');

assert.strictEqual(importedNpcs.length, 14, 'only the fourteen previously unloaded monster templates may be imported');
assert.ok(importedNpcs.every((npc) => !reusedMobIds.has(npc.selfId)),
    'Witch-slice monster templates must be reused instead of duplicated');
assert.strictEqual(npcs.length, 16, 'all sixteen Lisvus Necropolis of the Disciples monsters must be loaded exactly once');
assert.strictEqual(rewards.length, 16, 'every Disciples monster must have exactly one reward table');
assert.ok(spawnArea, 'the Necropolis of the Disciples spawn slice must be loaded');
assert.ok(baseSpawns.every((area) => area.spawns.every((spawn) => !mobIdSet.has(Number(spawn.selfId)))),
    'the additive import must remain limited to monster families absent from the old datapack');

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnArea.spawns.length, 16, 'spawn definitions must cover every source monster family');
assert.strictEqual(spawnCoords.length, 225, 'the import must retain all 225 Lisvus monster spawn rows');
assert.ok(spawnArea.spawns.every((spawn) => spawn.total === 1 && spawn.respawn === 120 && spawn.bias === 0));
assert.deepStrictEqual(
    spawnArea.spawns.map((spawn) => [spawn.selfId, spawn.coords.length]),
    [[1161, 16], [1162, 13], [1164, 15], [1165, 12], [1183, 16], [1184, 13], [1185, 15], [1186, 12],
        [1204, 17], [1205, 13], [1206, 15], [1207, 12], [1228, 16], [1229, 12], [1230, 15], [1231, 13]],
    'every family must retain its exact local population'
);

assert.deepStrictEqual(
    [...new Set(spawnCoords.map((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY)))],
    ['25_17'],
    'the underground source rows must stay in the Necropolis geodata region'
);
assert.strictEqual(GeodataEngine.loadRegion(25, 17), true, 'Necropolis geodata region 25_17 must be available');
const heightDeltas = spawnCoords.map((coord) => Math.abs(
    GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
));
assert.ok(heightDeltas.every((delta) => delta === 0), 'every source monster coordinate must match underground geodata exactly');

const soldier = npcs.find((npc) => npc.selfId === 1161);
assert.deepStrictEqual(
    {
        name: soldier.template.name, level: soldier.template.level, hostile: soldier.template.hostile,
        pAtk: soldier.stats.pAtk, pDef: soldier.stats.pDef, mAtk: soldier.stats.mAtk, mDef: soldier.stats.mDef,
        hp: soldier.vitals.maxHp, exp: Math.round(soldier.rewards.exp * soldier.template.level ** 2),
        sp: soldier.rewards.sp, clan: soldier.clan.clanName, race: soldier.traits.race
    },
    {
        name: 'Lesser Ancient Soldier', level: 73, hostile: true, pAtk: 1463, pDef: 502,
        mAtk: 885, mDef: 407, hp: 4086, exp: 5945, sp: 611, clan: 'c_dungeon_clan', race: 'beast'
    },
    'the representative template must retain exact Lisvus combat and reward values'
);

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 251, 'all Lisvus drop and spoil rows must exist across new and reused reward tables');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
const importedItemIds = [7645, 7665, 7666, 7667, 7672, 7673, 7674, 7675, 7676, 7835];
assert.deepStrictEqual(
    importedItemIds.map((itemId) => DataCache.items.find((item) => item.selfId === itemId).template.name),
    ['Spellbook - Balance Life', 'Spellbook - Prophecy of Water', 'Spellbook - Prophecy of Fire',
        'Spellbook - Prophecy of Wind', 'Amulet - Chant of Spirit', 'Amulet - Chant of Victory',
        "Amulet - Pa'agrio's Eye", "Amulet - Pa'agrio's Soul", 'Amulet - Seal of Despair',
        'Amulet: Seal of Disease'],
    'all ten previously missing spellbooks and amulets must retain their exact source identities'
);

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template), locX: 177000, locY: -14000, locZ: -4896, head: 0
    });
}

const expectedCombatSkills = new Map([
    [1161, [4035]], [1162, [4069]], [1164, [4101]], [1165, [4098, 4046, 4105]],
    [1183, [4072, 4092, 4032]], [1184, [4067]], [1185, [4098, 4046, 4002]],
    [1186, [4072, 4092, 4032]], [1204, [4072, 4032]], [1205, [4032]],
    [1206, [4098, 4046, 4030]], [1207, [4072, 4032]], [1228, [4317]],
    [1229, [4099]], [1230, [4032]], [1231, [4002]]
]);
const allSkillBindings = [
    ...newSkillBindings,
    ...witchSkillBindings.filter((binding) => reusedMobIds.has(binding.npcId))
];
assert.strictEqual(newSkillBindings.length, 98, 'only new monster families may receive imported skill bindings');
assert.strictEqual(allSkillBindings.length, 117, 'all source skill rows must exist across new and reused bindings');
expectedCombatSkills.forEach((skillIds, npcId) => {
    const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 9990000 + npcId);
    assert.strictEqual(
        NpcSkills.forNpc(instance).length,
        allSkillBindings.filter((binding) => binding.npcId === npcId).length,
        `NPC ${npcId} must instantiate every sourced active and passive binding exactly once`
    );
    assert.deepStrictEqual(
        NpcSkills.combatSkillsFor(instance).map((skill) => skill.fetchSelfId()),
        skillIds,
        `NPC ${npcId} must expose exactly its usable Lisvus combat skills`
    );
});

const slayer = npcInstance(npcs.find((npc) => npc.selfId === 1184), 10001184);
const cardinal = npcInstance(npcs.find((npc) => npc.selfId === 1206), 10001206);
assert.strictEqual(EffectStats.multiplier(slayer, 'maxHpMul'), 4,
    'Strong Type must retain its exact four-times HP multiplier');
assert.strictEqual(EffectStats.multiplier(slayer, 'darkVuln'), 0.5,
    'Lilim dark resistance level three must retain its exact source multiplier');
assert.strictEqual(EffectStats.multiplier(cardinal, 'darkVuln'), 1.2,
    'Nephilim dark weakness level three must retain its exact source multiplier');

console.log('C4 Necropolis of the Disciples source-fidelity checks passed');
