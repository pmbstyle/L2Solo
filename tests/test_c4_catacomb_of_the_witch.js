const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const skillBindings = require('../data/Npcs/Skills/c4_catacomb_of_the_witch.json');

DataCache.init();

const mobIds = [
    1156, 1157, 1159, 1160, 1179, 1180, 1181, 1182, 1183, 1200,
    1201, 1202, 1203, 1204, 1248, 1249, 1250, 1251, 1252
];
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));

assert.strictEqual(npcs.length, 19, 'all nineteen Lisvus Catacomb of the Witch monsters must be loaded');
assert.strictEqual(rewards.length, 19, 'every Catacomb of the Witch monster must have rewards');

const mobiusIds = new Set(DataCache.npcSpawns.filter((area) => String(area.selfId).startsWith('mobius:'))
    .flatMap((area) => area.spawns.map((spawn) => Number(spawn.selfId))));
assert.deepStrictEqual(mobIds.filter((id) => !mobiusIds.has(id)), [],
    'Catacomb of the Witch monsters are spawned from Mobius');

const shadow = npcs.find((npc) => npc.selfId === 1156);
assert.deepStrictEqual(
    {
        name: shadow.template.name, level: shadow.template.level, hostile: shadow.template.hostile,
        pAtk: shadow.stats.pAtk, pDef: shadow.stats.pDef, mAtk: shadow.stats.mAtk, mDef: shadow.stats.mDef,
        hp: shadow.vitals.maxHp, exp: Math.round(shadow.rewards.exp * shadow.template.level ** 2),
        sp: shadow.rewards.sp, clan: shadow.clan.clanName, race: shadow.traits.race
    },
    {
        name: 'Purgatory Shadow', level: 61, hostile: true, pAtk: 901, pDef: 321,
        mAtk: 505, mDef: 307, hp: 3137, exp: 4036, sp: 355, clan: 'c_dungeon_clan', race: 'demonic'
    },
    'the representative template must retain exact Lisvus combat and reward values'
);

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 343, 'all Lisvus drop and spoil rows must survive the category transform');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
assert.deepStrictEqual(
    [5811, 5814, 5815].map((itemId) => DataCache.items.find((item) => item.selfId === itemId).template.name),
    ['Spellbook: Mass Slow', 'Spellbook: Servitor Blessing', 'Spellbook: Wild Magic'],
    'all three previously missing spellbooks must load with their exact source identities'
);

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template), locX: 145000, locY: 84000, locZ: -5424, head: 0
    });
}

const expectedCombatSkills = new Map([
    [1156, [4158, 4160, 4076]], [1157, [4035]], [1159, [4072]], [1160, [4157, 4160, 4038]],
    [1179, [4098, 4046, 4002]], [1180, [4072, 4092, 4032]], [1181, [4067]],
    [1182, [4098, 4046, 4002]], [1183, [4072, 4092, 4032]], [1200, [4098, 4046, 4030]],
    [1201, [4072, 4032]], [1202, [4032]], [1203, [4098, 4046, 4030]], [1204, [4072, 4032]],
    [1248, [4317]], [1249, [4099]], [1250, [4032]], [1251, [4002]], [1252, [4317]]
]);
assert.strictEqual(skillBindings.length, 147, 'all Lisvus Catacomb NPC skill rows must be present');
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

const priest = npcInstance(npcs.find((npc) => npc.selfId === 1179), 10001179);
const bishop = npcInstance(npcs.find((npc) => npc.selfId === 1200), 10001200);
assert.strictEqual(EffectStats.multiplier(priest, 'maxHpMul'), 4,
    'Strong Type must retain its exact four-times HP multiplier');
assert.strictEqual(EffectStats.multiplier(priest, 'darkVuln'), 0.5,
    'Lilim dark resistance level three must retain its exact source multiplier');
assert.strictEqual(EffectStats.multiplier(bishop, 'darkVuln'), 1.2,
    'Nephilim dark weakness level three must retain its exact source multiplier');

console.log('C4 Catacomb of the Witch source-fidelity checks passed');
