const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const baseSpawns = require('../data/Npcs/Spawns/spawns.json');
const importedNpcs = require('../data/Npcs/c4_necropolis_of_saints.json');
const newSkillBindings = require('../data/Npcs/Skills/c4_necropolis_of_saints.json');
const disciplesSkillBindings = require('../data/Npcs/Skills/c4_necropolis_of_the_disciples.json');
const witchSkillBindings = require('../data/Npcs/Skills/c4_catacomb_of_the_witch.json');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');

DataCache.init();

const mobIds = [1161, 1162, 1163, 1183, 1184, 1185, 1204, 1205, 1206, 1228, 1230, 1231];
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-necropolis-of-saints');

assert.deepStrictEqual(importedNpcs.map((npc) => npc.selfId), [1163],
    'only the previously unloaded Lesser Ancient Shaman template may be imported');
assert.strictEqual(npcs.length, 12, 'all twelve Lisvus Necropolis of Saints monsters must be loaded exactly once');
assert.strictEqual(rewards.length, 12, 'every Saints monster must have exactly one reward table');
assert.ok(spawnArea, 'the Necropolis of Saints spawn slice must be loaded');
assert.ok(baseSpawns.every((area) => area.spawns.every((spawn) => !mobIdSet.has(Number(spawn.selfId)))),
    'the additive import must remain limited to monster families absent from the old datapack');

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnArea.spawns.length, 12, 'spawn definitions must cover every source monster family');
assert.strictEqual(spawnCoords.length, 197, 'the import must retain all 197 Lisvus monster spawn rows');
assert.ok(spawnArea.spawns.every((spawn) => spawn.total === 1 && spawn.respawn === 120 && spawn.bias === 0));
assert.deepStrictEqual(
    spawnArea.spawns.map((spawn) => [spawn.selfId, spawn.coords.length]),
    [[1161, 14], [1162, 17], [1163, 19], [1183, 14], [1184, 16], [1185, 18],
        [1204, 14], [1205, 17], [1206, 18], [1228, 14], [1230, 18], [1231, 18]],
    'every family must retain its exact local population'
);

assert.deepStrictEqual(
    [...new Set(spawnCoords.map((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY)))],
    ['22_24'],
    'the underground source rows must stay in the Necropolis geodata region'
);
verifyGeodataWhenAvailable(GeodataEngine, [[22, 24]], 'Necropolis of Saints', () => {
    const heightDeltas = spawnCoords.map((coord) => Math.abs(
        GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
    ));
    assert.ok(heightDeltas.every((delta) => delta === 0),
        'every source monster coordinate must match underground geodata exactly');
});

const shaman = npcs.find((npc) => npc.selfId === 1163);
assert.deepStrictEqual(
    {
        name: shaman.template.name, level: shaman.template.level, hostile: shaman.template.hostile,
        pAtk: shaman.stats.pAtk, pDef: shaman.stats.pDef, mAtk: shaman.stats.mAtk, mDef: shaman.stats.mDef,
        hp: shaman.vitals.maxHp, exp: Math.round(shaman.rewards.exp * shaman.template.level ** 2),
        sp: shaman.rewards.sp, clan: shaman.clan.clanName, race: shaman.traits.race
    },
    {
        name: 'Lesser Ancient Shaman', level: 76, hostile: true, pAtk: 1614, pDef: 454,
        mAtk: 994, mDef: 433, hp: 4297, exp: 6265, sp: 669, clan: 'c_dungeon_clan', race: 'demonic'
    },
    'the newly imported template must retain exact Lisvus combat and reward values'
);

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 187, 'all Lisvus drop and spoil rows must exist across new and reused reward tables');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
assert.deepStrictEqual(
    [7654, 7655, 7660, 7661].map((itemId) => DataCache.items.find((item) => item.selfId === itemId).template.name),
    ['Spellbook - Mass Warrior Bane', 'Spellbook - Mass Mage Bane',
        'Spellbook - Warrior Bane', 'Spellbook - Mage Bane'],
    'all four previously missing spellbooks must retain their exact source identities'
);

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template), locX: 86000, locY: 214000, locZ: -5432, head: 0
    });
}

const expectedCombatSkills = new Map([
    [1161, [4035]], [1162, [4069]], [1163, [4076]], [1183, [4072, 4092, 4032]],
    [1184, [4067]], [1185, [4098, 4046, 4002]], [1204, [4072, 4032]], [1205, [4032]],
    [1206, [4098, 4046, 4030]], [1228, [4317]], [1230, [4032]], [1231, [4002]]
]);
const allSkillBindings = [newSkillBindings, disciplesSkillBindings, witchSkillBindings]
    .flat()
    .filter((binding) => mobIdSet.has(binding.npcId));
assert.strictEqual(newSkillBindings.length, 5, 'only the new shaman may receive imported skill bindings');
assert.strictEqual(allSkillBindings.length, 84, 'all source skill rows must exist across new and reused bindings');
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

const shamanInstance = npcInstance(shaman, 10001163);
assert.strictEqual(EffectStats.multiplier(shamanInstance, 'maxHpMul'), 4,
    'Strong Type must retain its exact four-times HP multiplier');
assert.strictEqual(EffectStats.multiplier(shamanInstance, 'windVuln'), 1.15,
    'Wind weakness level two must retain its exact source multiplier');

console.log('C4 Necropolis of Saints source-fidelity checks passed');
