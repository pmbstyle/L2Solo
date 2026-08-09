const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const baseSpawns = require('../data/Npcs/Spawns/spawns.json');
const skillBindings = require('../data/Npcs/Skills/c4_catacomb_of_the_branded.json');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');

DataCache.init();

const mobIds = [1147, 1149, 1150, 1151, 1173, 1174, 1175, 1176, 1194, 1195, 1196, 1197, 1240, 1241, 1242, 1243];
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-catacomb-of-the-branded');

assert.strictEqual(npcs.length, 16, 'all sixteen Lisvus Catacomb of the Branded monsters must be loaded');
assert.strictEqual(rewards.length, 16, 'every Catacomb of the Branded monster must have rewards');
assert.ok(spawnArea, 'the Catacomb of the Branded spawn slice must be loaded');
assert.ok(baseSpawns.every((area) => area.spawns.every((spawn) => !mobIdSet.has(Number(spawn.selfId)))),
    'the additive import must remain limited to monster families absent from the old datapack');

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnArea.spawns.length, 16, 'spawn definitions must cover every source monster family');
assert.strictEqual(spawnCoords.length, 252, 'the import must retain all 252 Lisvus spawn rows');
assert.ok(spawnArea.spawns.every((spawn) => spawn.total === 1 && spawn.respawn === 60 && spawn.bias === 0));
assert.deepStrictEqual(
    spawnArea.spawns.map((spawn) => [spawn.selfId, spawn.coords.length]),
    [[1147, 15], [1149, 15], [1150, 16], [1151, 16], [1173, 17], [1174, 15], [1175, 15], [1176, 16],
        [1194, 17], [1195, 15], [1196, 15], [1197, 16], [1240, 17], [1241, 17], [1242, 15], [1243, 15]],
    'every family must retain its exact local population'
);

assert.deepStrictEqual(
    [...new Set(spawnCoords.map((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY)))],
    ['21_23'],
    'the underground source rows must stay in the Catacomb geodata region'
);
verifyGeodataWhenAvailable(GeodataEngine, [[21, 23]], 'Catacomb of the Branded', () => {
    const heightDeltas = spawnCoords.map((coord) => Math.abs(
        GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
    ));
    assert.ok(heightDeltas.every((delta) => delta === 0),
        'every source coordinate must match the underground geodata exactly');
});

const gargoyle = npcs.find((npc) => npc.selfId === 1147);
assert.deepStrictEqual(
    {
        name: gargoyle.template.name, level: gargoyle.template.level, hostile: gargoyle.template.hostile,
        pAtk: gargoyle.stats.pAtk, pDef: gargoyle.stats.pDef, mAtk: gargoyle.stats.mAtk, mDef: gargoyle.stats.mDef,
        hp: gargoyle.vitals.maxHp, exp: Math.round(gargoyle.rewards.exp * gargoyle.template.level ** 2),
        sp: gargoyle.rewards.sp, clan: gargoyle.clan.clanName, race: gargoyle.traits.race
    },
    {
        name: 'Catacomb Gargoyle', level: 43, hostile: true, pAtk: 332, pDef: 223,
        mAtk: 163, mDef: 181, hp: 1728, exp: 2114, sp: 143, clan: 'c_dungeon_clan', race: 'construct'
    },
    'the representative template must retain exact Lisvus combat and reward values'
);

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 236, 'all Lisvus drop and spoil rows must survive the category transform');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
assert.deepStrictEqual(
    [5164, 6036, 6361].map((itemId) => DataCache.items.find((item) => item.selfId === itemId).template.name),
    ['Recipe: Blessed Spiritshot (C) Compressed Package (100%)', 'Greater Magic Haste Potion', 'Green Seal Stone'],
    'all three previously missing Catacomb drops must load with their exact source identities'
);

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template), locX: 52000, locY: 175000, locZ: -4976, head: 0
    });
}

const expectedCombatSkills = new Map([
    [1147, [4072]], [1149, [4101]], [1150, [4073]], [1151, [4244]],
    [1173, [4001]], [1174, [4029]], [1175, [4067]], [1176, [4098, 4046, 4002]],
    [1194, [4078]], [1195, [4029]], [1196, [4032]], [1197, [4098, 4046, 4030]],
    [1240, [4317]], [1241, [4099]], [1242, [4032]], [1243, [4002]]
]);
assert.strictEqual(skillBindings.length, 109, 'all Lisvus Catacomb NPC skill rows must be present');
expectedCombatSkills.forEach((skillIds, npcId) => {
    const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 9990000 + npcId);
    assert.strictEqual(
        NpcSkills.forNpc(instance).length,
        skillBindings.filter((binding) => binding.npcId === npcId).length,
        `NPC ${npcId} must instantiate every sourced active and passive binding`
    );
    assert.deepStrictEqual(
        NpcSkills.combatSkillsFor(instance).map((skill) => skill.fetchSelfId()),
        skillIds,
        `NPC ${npcId} must expose exactly its usable Lisvus combat skills`
    );
});

const confessor = npcInstance(npcs.find((npc) => npc.selfId === 1194), 10001194);
assert.strictEqual(EffectStats.multiplier(confessor, 'maxHpMul'), 4,
    'Strong Type must retain its exact four-times HP multiplier');
assert.strictEqual(EffectStats.multiplier(confessor, 'darkVuln'), 1.2,
    'Dark Attack Weak Point level three must retain its exact source multiplier');

console.log('C4 Catacomb of the Branded source-fidelity checks passed');
