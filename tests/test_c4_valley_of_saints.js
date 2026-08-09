const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const skillBindings = require('../data/Npcs/Skills/c4_valley_of_saints.json');

DataCache.init();

const mobIds = [
    1520, 1521, 1523, 1524, 1526, 1527, 1529, 1530, 1531, 1532, 1533,
    1535, 1536, 1537, 1539, 1541, 1544, 5214, 5215, 5216, 5317
];
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-valley-of-saints');

assert.strictEqual(npcs.length, 21, 'all Lisvus Valley of Saints monster variants must be loaded');
assert.strictEqual(rewards.length, 21, 'every Valley monster must have a reward template, including empty quest rewards');
assert.ok(spawnArea, 'Valley of Saints spawn slice must be loaded');

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnArea.spawns.length, 21, 'spawn definitions must cover every ambient and permanent quest monster');
assert.strictEqual(spawnCoords.length, 381, 'the import must retain all 381 Lisvus L2Monster spawn rows');
assert.deepStrictEqual(
    [...new Set(spawnCoords.map((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY)))],
    ['22_15'],
    'all source spawns must remain in the original Valley geodata region'
);
assert.strictEqual(GeodataEngine.loadRegion(22, 15), true, 'the source spawn region must have geodata');
const heightDeltas = spawnCoords.map((coord) => Math.abs(
    GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
));
assert.ok(heightDeltas.filter((delta) => delta <= 128).length >= 333,
    'at least 333 source coordinates must agree with the selected geodata layer within 128 Z');
assert.ok(Math.max(...heightDeltas) <= 3800,
    'multi-level Valley coordinates must stay within the audited source/geodata maximum delta');

const eye = npcs.find((npc) => npc.selfId === 1520);
assert.deepStrictEqual(
    {
        name: eye.template.name,
        level: eye.template.level,
        pAtk: eye.stats.pAtk,
        pDef: eye.stats.pDef,
        mAtk: eye.stats.mAtk,
        mDef: eye.stats.mDef,
        hp: eye.vitals.maxHp,
        exp: Math.round(eye.rewards.exp * eye.template.level ** 2),
        sp: eye.rewards.sp,
        clan: eye.clan.clanName,
        race: eye.traits.race
    },
    {
        name: 'Eye of Splendor', level: 60, pAtk: 860, pDef: 368, mAtk: 478,
        mDef: 299, hp: 3054, exp: 7466, sp: 648, clan: 'saint_clan', race: 'divine'
    },
    'the representative ambient template must retain exact Lisvus combat and reward values'
);

const guardian = npcs.find((npc) => npc.selfId === 5214);
const guardianReward = rewards.find((reward) => reward.selfId === 5214);
const guardianSpawn = spawnArea.spawns.find((spawn) => spawn.selfId === 5214);
assert.strictEqual(guardian.template.title, 'Quest Monster');
assert.deepStrictEqual(guardian.rewards, { exp: 0, sp: 0 });
assert.deepStrictEqual({ rewards: guardianReward.rewards, spoils: guardianReward.spoils }, { rewards: [], spoils: [] });
assert.deepStrictEqual({ count: guardianSpawn.coords.length, respawn: guardianSpawn.respawn }, { count: 10, respawn: 360 });
assert.strictEqual(npcs.find((npc) => npc.selfId === 5317).clan.clanName, '',
    'SQL NULL faction must become an empty clan, not the literal string NULL');
assert.ok(spawnArea.spawns.filter((spawn) => spawn.selfId >= 5214).every((spawn) => spawn.respawn === 360),
    'permanent quest monsters must retain their six-minute source respawn');

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 262, 'all Lisvus drop and spoil rows must survive the category transform');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
assert.ok(rewards.every((reward) => reward.spoils.every((group) => group.items.length === 1 && group.overall === 100)),
    'category -1 rows must remain independent spoil rolls');

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template), locX: -71008, locY: -70912, locZ: -3408, head: 0
    });
}

const expectedCombatSkills = new Map([
    [1520, [4561, 4631, 4035]],
    [1521, [4160, 4035]],
    [1523, [4160, 4633, 4035]],
    [1524, [4641]],
    [1526, [4561, 4634, 4104]],
    [1527, [4566, 4160, 4632, 4102]],
    [1529, [4630, 4561, 4571, 4635, 4035]],
    [1530, [4160, 4636, 4119]],
    [1531, [4641]],
    [1532, [4158, 4160, 4566, 4104]],
    [1533, [4561, 4633, 4076]],
    [1535, [4630, 4160, 4571, 4636, 4104]],
    [1536, [4561, 4637, 4102]],
    [1537, [4155, 4160, 4104]],
    [1539, [4641]],
    [1541, [4158, 4566, 4036]],
    [1544, [4155, 4635, 4640]],
    [5214, []], [5215, []], [5216, []], [5317, []]
]);
assert.strictEqual(skillBindings.length, 105, 'all Lisvus Valley NPC skill rows must be present');
expectedCombatSkills.forEach((skillIds, npcId) => {
    const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 9300000 + npcId);
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

const eyeInstance = npcInstance(eye, 9301520);
assert.strictEqual(eyeInstance.selectCombatSkill({}).fetchSelfId(), 4631,
    'an unbuffed Valley caster must prioritize its source self-buff');
const eyeBuff = NpcSkills.forNpc(eyeInstance).find((skill) => skill.fetchSelfId() === 4631);
assert.deepStrictEqual(
    eyeBuff.fetchSemantic().stats,
    { pDefMul: 1.15, castSpdMul: 1.3, mCritRateMul: 4 },
    'level-three NPC buff stats must match Lisvus exactly'
);
EffectStore.apply(eyeInstance, {
    key: eyeBuff.fetchSemantic().effect, id: 4631, level: 3, name: eyeBuff.fetchName(),
    type: 'buff', stats: eyeBuff.fetchSemantic().stats, durationMs: 120000
});
assert.strictEqual(eyeInstance.selectCombatSkill({}).fetchSelfId(), 4561,
    'after its buff is active the caster must proceed to its first enemy skill');

const shout = npcInstance(npcs.find((npc) => npc.selfId === 1532), 9301532);
const clanBuff = NpcSkills.forNpc(shout).find((skill) => skill.fetchSelfId() === 4638);
assert.strictEqual(clanBuff.fetchTargetKind(), 'clan');
assert.ok(!NpcSkills.combatSkillsFor(shout).some((skill) => skill.fetchSelfId() === 4638),
    'Lisvus clan buffs are sourced but intentionally excluded from ordinary monster combat AI');

const flash = npcInstance(npcs.find((npc) => npc.selfId === 1523), 9301523);
const notDone = NpcSkills.forNpc(flash).filter((skill) => [4563, 4569].includes(skill.fetchSelfId()));
assert.deepStrictEqual(notDone.map((skill) => skill.fetchSkillType()), ['notDone', 'notDone']);
assert.ok(notDone.every((skill) => !NpcSkills.combatSkillsFor(flash).includes(skill)),
    'Lisvus TODO Solar Flare variants must instantiate for fidelity but never execute');
const blade = npcInstance(npcs.find((npc) => npc.selfId === 1524), 9301524);
assert.strictEqual(NpcSkills.forNpc(blade).find((skill) => skill.fetchSelfId() === 4671).fetchSkillType(), 'notDone');

const anger = npcInstance(npcs.find((npc) => npc.selfId === 1527), 9301527);
assert.strictEqual(EffectStats.multiplier(anger, 'pDefMul'), 1.17,
    'NPC High P. Def. level three must expose its exact passive multiplier');
assert.strictEqual(EffectStats.multiplier(anger, 'castSpdMul'), 1.09,
    'NPC Fast Spell Casting level three must expose its exact passive multiplier');
const bladePassives = npcInstance(npcs.find((npc) => npc.selfId === 1524), 9401524);
assert.strictEqual(EffectStats.multiplier(bladePassives, 'pCritDamageMul'), 1.25);
assert.strictEqual(EffectStats.multiplier(bladePassives, 'pCritRateMul'), 1.5);

const poison = NpcSkills.forNpc(eyeInstance).find((skill) => skill.fetchSelfId() === 4035);
assert.deepStrictEqual(
    { trait: poison.fetchSemantic().trait, count: poison.fetchSemantic().dot.count, interval: poison.fetchSemantic().dot.intervalMs, damage: poison.fetchSemantic().dot.damageByLevel[5] },
    { trait: 'poison', count: 10, interval: 3000, damage: 44 },
    'level-six NPC poison must retain its ten source ticks and damage table'
);
const eruption = NpcSkills.forNpc(anger).find((skill) => skill.fetchSelfId() === 4566);
assert.deepStrictEqual(
    { type: eruption.fetchSkillType(), trait: eruption.fetchSemantic().trait, target: eruption.fetchSemantic().sourceTarget, radius: eruption.fetchSemantic().radius, distance: eruption.fetchDistance() },
    { type: 'damage', trait: 'fire', target: 'area', radius: 205, distance: 500 }
);

console.log('C4 Valley of Saints source-fidelity checks passed');
