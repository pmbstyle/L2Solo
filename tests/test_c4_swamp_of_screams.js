const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
const Attack = invoke('GameServer/Actor/Attack');
const skillBindings = require('../data/Npcs/Skills/c4_swamp_of_screams.json');

DataCache.init();

const mobIds = Array.from({ length: 11 }, (_, index) => 1508 + index);
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-swamp-of-screams');

assert.strictEqual(npcs.length, 11, 'all eleven Lisvus Swamp of Screams templates must be loaded');
assert.strictEqual(rewards.length, 11, 'all eleven Lisvus reward templates must be loaded');
assert.ok(spawnArea, 'Swamp of Screams spawn slice must be loaded');

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnArea.spawns.length, 11, 'spawn definitions should cover every Swamp monster');
assert.strictEqual(spawnCoords.length, 558, 'the imported slice must retain all 558 Lisvus spawn rows');
assert.ok(spawnArea.spawns.every((spawn) => spawn.total === 1 && spawn.respawn === 60 && spawn.bias === 0));
assert.ok(spawnCoords.every((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY) === '22_16'));

assert.strictEqual(GeodataEngine.loadRegion(22, 16), true, 'the source spawn region must have geodata');
const heightDeltas = spawnCoords.map((coord) => Math.abs(
    GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
));
assert.ok(heightDeltas.filter((delta) => delta <= 128).length >= 556, 'at least 556 source spawns must agree with geodata within 128 Z');
assert.ok(Math.max(...heightDeltas) <= 368, 'the source/geodata Z delta must stay within the audited maximum');

const splinter = npcs.find((npc) => npc.selfId === 1508);
assert.deepStrictEqual(
    {
        name: splinter.template.name,
        level: splinter.template.level,
        hostile: splinter.template.hostile,
        pAtk: splinter.stats.pAtk,
        pDef: splinter.stats.pDef,
        mAtk: splinter.stats.mAtk,
        mDef: splinter.stats.mDef,
        hp: splinter.vitals.maxHp,
        exp: Math.round(splinter.rewards.exp * splinter.template.level ** 2),
        sp: splinter.rewards.sp,
        clan: splinter.clan.clanName
    },
    {
        name: 'Splinter Stakato',
        level: 66,
        hostile: true,
        pAtk: 1123,
        pDef: 364,
        mAtk: 649,
        mDef: 348,
        hp: 3546,
        exp: 8452,
        sp: 796,
        clan: 'stakato_clan'
    },
    'the representative template must retain Lisvus combat and reward values'
);
assert.strictEqual(npcs.find((npc) => npc.selfId === 1512).template.hostile, false);
assert.strictEqual(npcs.find((npc) => npc.selfId === 1517).template.hostile, false);
assert.strictEqual(npcs.find((npc) => npc.selfId === 1518).template.hostile, false);

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 158, 'all Lisvus drop and spoil rows must survive the category transform');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
assert.ok(rewards.every((reward) => reward.spoils.every((group) => group.items.length === 1 && group.overall === 100)),
    'category -1 rows must remain independent spoil rolls');

const richestSpoil = rewards.reduce((best, reward) => reward.spoils.length > best.spoils.length ? reward : best);
assert.ok(richestSpoil.spoils.length > 1, 'fixture must exercise multiple independent spoil rolls');
const originalRandom = Math.random;
try {
    Math.random = () => 0;
    const rolled = SpoilSweep.rollSpoils({
        model: { level: 70, dropAttackerLevels: [] },
        fetchSelfId: () => richestSpoil.selfId,
        fetchLevel: () => 70
    });
    assert.strictEqual(rolled.length, richestSpoil.spoils.length, 'one sweep can award every independently successful spoil row');
} finally {
    Math.random = originalRandom;
}

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template),
        locX: 70006,
        locY: -49902,
        locZ: -3251,
        head: 0
    });
}

const splinterNpc = npcInstance(splinter, 9001508);
assert.strictEqual(NpcSkills.forNpc(splinterNpc).length, 6, 'all sourced active and passive skill bindings must instantiate');
assert.deepStrictEqual(NpcSkills.combatSkillsFor(splinterNpc).map((skill) => skill.fetchSelfId()), [4643]);
const decreaseSpeed = NpcSkills.combatSkillsFor(splinterNpc)[0];
assert.strictEqual(decreaseSpeed.fetchSkillType(), 'damageEffect');
assert.strictEqual(decreaseSpeed.fetchSemantic().stats.runSpdMul, 0.5);
assert.strictEqual(decreaseSpeed.fetchBuffTime(), 120000);
assert.strictEqual(EffectStats.multiplier(splinterNpc, 'bowWpnVuln'), 0.5, 'Resist Archery level 3 must be active');
assert.strictEqual(EffectStats.multiplier(splinterNpc, 'bluntWpnVuln'), 1.1, 'Blunt Weak Point level 1 must be active');
assert.strictEqual(EffectStats.multiplier(splinterNpc, 'rootVuln'), 0.7, 'Resist Hold level 2 must be active');
assert.strictEqual(splinterNpc.fetchCollectiveMDef(), 435, 'Resist M.Atk level 4 must multiply M.Def by 1.25');

const expectedCombatSkills = new Map([
    [1508, [4643]],
    [1509, []],
    [1510, [4073]],
    [1511, []],
    [1512, [4067]],
    [1513, [4643]],
    [1514, []],
    [1515, [4073]],
    [1516, [4072]],
    [1517, [4244]],
    [1518, [4032]]
]);
assert.strictEqual(skillBindings.length, 61, 'all Lisvus NPC skill rows must be present');
expectedCombatSkills.forEach((skillIds, npcId) => {
    const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 9100000 + npcId);
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

const needleDrone = npcInstance(npcs.find((npc) => npc.selfId === 1517), 9001517);
assert.deepStrictEqual(NpcSkills.combatSkillsFor(needleDrone).map((skill) => skill.fetchSelfId()), [4244]);
const wildSweep = NpcSkills.combatSkillsFor(needleDrone)[0];
assert.strictEqual(wildSweep.fetchSkillType(), 'damage');
assert.strictEqual(wildSweep.fetchSemantic().sourceTarget, 'area');
assert.strictEqual(wildSweep.fetchSemantic().radius, 150);

const attacker = {
    fetchCollectivePAtk: () => 1000,
    fetchCollectiveCritical: () => 0,
    fetchDex: () => 30,
    fetchHead: () => 0,
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    backpack: {
        kind: 'Weapon.Sword',
        fetchTotalWeaponKind() { return this.kind; },
        fetchTotalWeaponPAtkRnd: () => 0,
        fetchEquippedArmors: () => []
    }
};
const attack = new Attack();
const swordDamage = attack.prepareMeleeHit(attacker, splinterNpc, true, false, () => 0.99).damage;
attacker.backpack.kind = 'Weapon.Blunt';
const bluntDamage = attack.prepareMeleeHit(attacker, splinterNpc, true, false, () => 0.99).damage;
assert.ok(bluntDamage > swordDamage, 'the sourced blunt weakness must affect real melee damage');

console.log('C4 Swamp of Screams source-fidelity checks passed');
