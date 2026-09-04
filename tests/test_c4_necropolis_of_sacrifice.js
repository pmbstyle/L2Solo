const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const baseSpawns = require('../data/Npcs/Spawns/spawns.json');
const skillBindings = require('../data/Npcs/Skills/c4_necropolis_of_sacrifice.json');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');

DataCache.init();

const mobIds = [1139, 1140, 1141, 1142, 1166, 1167, 1168, 1169, 1187, 1188, 1189, 1190, 1208, 1209, 1210, 1211];
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-necropolis-of-sacrifice');

assert.strictEqual(npcs.length, 16, 'all sixteen Lisvus Necropolis of Sacrifice monsters must be loaded');
assert.strictEqual(rewards.length, 16, 'every Necropolis of Sacrifice monster must have rewards');
assert.ok(spawnArea, 'the Necropolis of Sacrifice spawn slice must be loaded');
assert.ok(baseSpawns.every((area) => area.spawns.every((spawn) => !mobIdSet.has(Number(spawn.selfId)))),
    'the additive import must remain limited to monster families absent from the old datapack');

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnArea.spawns.length, 16, 'spawn definitions must cover every source monster family');
assert.strictEqual(spawnCoords.length, 256, 'the import must retain all 256 Lisvus spawn rows');
assert.ok(spawnArea.spawns.every((spawn) => spawn.total === 1 && spawn.respawn === 120 && spawn.bias === 0));
assert.deepStrictEqual(
    spawnArea.spawns.map((spawn) => [spawn.selfId, spawn.coords.length]),
    [[1139, 16], [1140, 16], [1141, 18], [1142, 18], [1166, 15], [1167, 15], [1168, 16], [1169, 18],
        [1187, 15], [1188, 15], [1189, 16], [1190, 18], [1208, 15], [1209, 15], [1210, 15], [1211, 15]],
    'every family must retain its exact local population'
);

assert.deepStrictEqual(
    [...new Set(spawnCoords.map((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY)))],
    ['18_24'],
    'the underground source rows must stay in the Necropolis geodata region'
);
verifyGeodataWhenAvailable(GeodataEngine, [[18, 24]], 'Necropolis of Sacrifice', () => {
    const heightDeltas = spawnCoords.map((coord) => Math.abs(
        GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
    ));
    assert.ok(heightDeltas.every((delta) => delta <= 64), 'every source coordinate must agree with geodata within 64 Z');
    assert.strictEqual(Math.max(...heightDeltas), 56, 'the audited underground source/geodata maximum must remain exact');
});

const bat = npcs.find((npc) => npc.selfId === 1139);
assert.deepStrictEqual(
    {
        name: bat.template.name, level: bat.template.level, hostile: bat.template.hostile,
        pAtk: bat.stats.pAtk, pDef: bat.stats.pDef, mAtk: bat.stats.mAtk, mDef: bat.stats.mDef,
        hp: bat.vitals.maxHp, exp: Math.round(bat.rewards.exp * bat.template.level ** 2),
        sp: bat.rewards.sp, clan: bat.clan.clanName, race: bat.traits.race
    },
    {
        name: 'Catacomb Barbed Bat', level: 23, hostile: true, pAtk: 75, pDef: 91,
        mAtk: 31, mDef: 87, hp: 648, exp: 655, sp: 31, clan: 'c_dungeon_clan', race: 'beast'
    },
    'the representative template must retain exact Lisvus combat and reward values'
);
assert.strictEqual(npcs.find((npc) => npc.selfId === 1210).traits.race, 'fairy',
    'Vault Guardian must retain its source Fairy race marker');

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 193, 'all Lisvus drop and spoil rows must survive the category transform');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
const heavySword = DataCache.items.find((item) => item.selfId === 5285);
assert.deepStrictEqual(
    {
        kind: heavySword.template.kind, pAtk: heavySword.stats.pAtk, mAtk: heavySword.stats.mAtk,
        shots: heavySword.etc.soulshot, rank: heavySword.etc.rank, crystals: heavySword.etc.cristals
    },
    { kind: 'Weapon.GreatSword', pAtk: 49, mAtk: 26, shots: 2, rank: 'd', crystals: 743 },
    'the missing Heavy Sword drop must load as its exact weapon type rather than a generic item'
);
const equipmentItemIds = new Set(npcs.flatMap((npc) => [npc.equipment.weapon, npc.equipment.shield]).filter(Boolean));
equipmentItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId),
        `equipped NPC item ${itemId} must have a loaded template`);
});
const tombSavant = DataCache.items.find((item) => item.selfId === 5793);
assert.deepStrictEqual(
    {
        kind: tombSavant.template.kind, slot: tombSavant.etc.slot,
        pAtk: tombSavant.stats.pAtk, mAtk: tombSavant.stats.mAtk,
        pAtkRnd: tombSavant.stats.pAtkRnd, atkSpd: tombSavant.stats.atkSpd
    },
    { kind: 'Weapon.Sword', slot: 7, pAtk: 156, mAtk: 83, pAtkRnd: 10, atkSpd: 379 },
    'NPC equipment dependencies must retain their exact Lisvus weapon semantics'
);
assert.deepStrictEqual(
    { pAtkRnd: npcs.find((npc) => npc.selfId === 1188).stats.pAtkRnd, accur: npcs.find((npc) => npc.selfId === 1188).stats.accur },
    { pAtkRnd: 10, accur: 0 },
    'NPC combat stats must derive random damage and accuracy from the equipped source weapon'
);

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template), locX: -47000, locY: 215000, locZ: -5080, head: 0
    });
}

const expectedCombatSkills = new Map([
    [1139, []], [1140, [4151, 4160]], [1141, [4101]], [1142, []],
    [1166, [4067]], [1167, [4001]], [1168, [4029]], [1169, [4067]],
    [1187, [4032]], [1188, [4078]], [1189, [4029]], [1190, [4032]],
    [1208, [4317]], [1209, [4099]], [1210, [4032]], [1211, [4002]]
]);
assert.strictEqual(skillBindings.length, 92, 'all Lisvus Necropolis NPC skill rows must be present');
expectedCombatSkills.forEach((skillIds, npcId) => {
    const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 9970000 + npcId);
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

const gigant = npcInstance(npcs.find((npc) => npc.selfId === 1187), 9981187);
assert.strictEqual(EffectStats.multiplier(gigant, 'maxHpMul'), 4,
    'Strong Type must retain its exact four-times HP multiplier');
assert.strictEqual(Math.round(gigant.fetchAcquiredExp()), 2376,
    'Strong Type must apply its four-times multiplier to the full XP reward');
assert.strictEqual(Math.round(gigant.fetchRewardSp()), 108,
    'Strong Type must apply its four-times multiplier to the full SP reward');
assert.strictEqual(EffectStats.multiplier(gigant, 'darkVuln'), 1.2,
    'Dark Attack Weak Point level three must retain its exact source multiplier');

const watchman = npcInstance(npcs.find((npc) => npc.selfId === 1208), 9981208);
const rageMight = NpcSkills.forNpc(watchman).find((skill) => skill.fetchSelfId() === 4317);
assert.deepStrictEqual(
    {
        type: rageMight.fetchSkillType(), effect: rageMight.fetchSemantic().effect,
        target: rageMight.fetchTargetKind(), duration: rageMight.fetchBuffTime(), mp: rageMight.fetchConsumedMp()
    },
    { type: 'effect', effect: 'increase_rage_might', target: 'self', duration: 60000, mp: 50 },
    'Increase Rage Might must retain its sourced self-buff runtime semantics'
);

console.log('C4 Necropolis of Sacrifice source-fidelity checks passed');
