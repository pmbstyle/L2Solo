const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const skillBindings = require('../data/Npcs/Skills/c4_forest_of_the_dead.json');

DataCache.init();

const mobIds = [
    1547, 1548, 1549, 1552, 1553, 1555, 1557, 1559, 1560, 1561, 1562,
    1563, 1564, 1565, 1566, 1567, 1569, 1570, 1571, 1572, 1573, 1574,
    1577, 1578, 1579, 1580, 1581, 1582, 1583, 1585, 1586, 1587, 1588,
    1589, 1590, 1591, 1593, 1594, 1596, 1599, 12789
];
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-forest-of-the-dead');

assert.strictEqual(npcs.length, 41, 'all 41 Lisvus Forest monster variants must be loaded');
assert.strictEqual(rewards.length, 41, 'every Forest monster must have a reward template');
assert.ok(spawnArea, 'Forest of the Dead spawn slice must be loaded');

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnCoords.length, 572, 'the import must retain all 572 Lisvus L2Monster spawn rows');
assert.ok(spawnArea.spawns.every((spawn) => spawn.total === 1 && spawn.respawn === 240 && spawn.bias === 0));
assert.deepStrictEqual(
    Object.fromEntries(['always', 'day', 'night'].map((period) => [
        period,
        spawnArea.spawns.filter((spawn) => spawn.period === period).reduce((sum, spawn) => sum + spawn.coords.length, 0)
    ])),
    { always: 98, day: 227, night: 247 },
    'default, day, and night populations must retain their exact source split'
);
assert.ok(!spawnArea.spawns.some((spawn) => [8386, 8387, 8388, 8389, 8522].includes(spawn.selfId)),
    'Forest merchants and named non-monster NPCs must not leak into the monster slice');

assert.deepStrictEqual(
    [...new Set(spawnCoords.map((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY)))],
    ['21_16'],
    'all source spawns must remain in the Forest geodata region'
);
assert.strictEqual(GeodataEngine.loadRegion(21, 16), true, 'the source spawn region must have geodata');
const heightDeltas = spawnCoords.map((coord) => Math.abs(
    GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
));
assert.ok(heightDeltas.every((delta) => delta <= 64),
    'every Forest source coordinate must agree with the selected geodata layer within 64 Z');

const corruptedKnight = npcs.find((npc) => npc.selfId === 1547);
assert.deepStrictEqual(
    {
        name: corruptedKnight.template.name,
        level: corruptedKnight.template.level,
        pAtk: corruptedKnight.stats.pAtk,
        pDef: corruptedKnight.stats.pDef,
        mAtk: corruptedKnight.stats.mAtk,
        mDef: corruptedKnight.stats.mDef,
        hp: corruptedKnight.vitals.maxHp,
        exp: Math.round(corruptedKnight.rewards.exp * corruptedKnight.template.level ** 2),
        sp: corruptedKnight.rewards.sp,
        clan: corruptedKnight.clan.clanName,
        race: corruptedKnight.traits.race,
        undead: corruptedKnight.traits.undead
    },
    {
        name: 'Corrupted Knight', level: 63, pAtk: 987, pDef: 398, mAtk: 560,
        mDef: 323, hp: 3302, exp: 8116, sp: 733, clan: 'necro_clan', race: 'undead', undead: true
    },
    'the representative template must retain exact Lisvus combat and reward values'
);

function periodCounts(npcId) {
    return Object.fromEntries(spawnArea.spawns.filter((spawn) => spawn.selfId === npcId)
        .map((spawn) => [spawn.period, spawn.coords.length]));
}
assert.deepStrictEqual(periodCounts(1547), { always: 8, day: 2 });
assert.deepStrictEqual(periodCounts(1582), { always: 3, night: 14 });
assert.deepStrictEqual(periodCounts(12789), { always: 48, day: 9 });
assert.deepStrictEqual(periodCounts(1588), { always: 1 });
assert.deepStrictEqual(periodCounts(1589), { night: 12 });
assert.strictEqual(npcs.find((npc) => npc.selfId === 1588).template.name, 'Vampire Wizard');
assert.strictEqual(npcs.find((npc) => npc.selfId === 1589).template.name, 'Vampire Wizard',
    'same-name day/night variants must remain distinct NPC templates');

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 564, 'all Lisvus drop and spoil rows must survive the category transform');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
assert.ok(rewards.every((reward) => reward.spoils.every((group) => group.items.length === 1 && group.overall === 100)),
    'category -1 rows must remain independent spoil rolls');

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template), locX: 50000, locY: -50000, locZ: -2500, head: 0
    });
}

const expectedCombatSkills = new Map([
    [1547, [4649, 4032]], [1548, [4649]], [1549, [4649, 4067]],
    [1552, [4649, 4073]], [1553, [4649, 4001]], [1555, [4028]],
    [1557, [4155, 4561, 4654, 4047]], [1559, [4561, 4654, 4047]],
    [1560, [4561, 4654, 4098]], [1561, [4649, 4073]], [1562, [4635]],
    [1563, [4561, 4654, 4047]], [1564, [4658, 4561, 4654, 4076]],
    [1565, [4155, 4561, 4654, 4047]], [1566, [4561, 4654, 4098]],
    [1567, [4654]], [1569, [4664]], [1570, [4649]], [1571, [4074]],
    [1572, [4561, 4654, 4076]], [1573, [4664, 4028]], [1574, [4654]],
    [1577, [4561]], [1578, [4649, 4073]], [1579, [4635]],
    [1580, [4155, 4561, 4654, 4047]], [1581, [4561, 4654, 4098]],
    [1582, [4664, 4028, 4663]], [1583, [4561, 4654, 4047]],
    [1585, [4561, 4664, 4047]], [1586, [4152, 4561, 4664, 4033]],
    [1587, [4664, 4099, 4663]], [1588, [4152, 4561, 4664]],
    [1589, [4622, 4561, 4664]], [1590, [4157, 4561, 4664]],
    [1591, [4157, 4561, 4664, 4033]], [1593, [4664]],
    [1594, [4664, 4028, 4663]], [1596, [4561, 4654]],
    [1599, [4257, 4561, 4654]], [12789, []]
]);
assert.strictEqual(skillBindings.length, 309, 'all Lisvus Forest NPC skill rows must be present');
expectedCombatSkills.forEach((skillIds, npcId) => {
    const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 9500000 + npcId);
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

const knightInstance = npcInstance(corruptedKnight, 9601547);
assert.strictEqual(EffectStats.multiplier(knightInstance, 'holyVuln'), 1.2,
    'Sacred Attack Weak Point level three must expose the exact Lisvus vulnerability');
assert.strictEqual(EffectStats.multiplier(knightInstance, 'pDefMul'), 1.43,
    'NPC High P. Def. level six must expose the exact Lisvus multiplier');

const skullCollector = npcInstance(npcs.find((npc) => npc.selfId === 1564), 9601564);
const drainRoot = NpcSkills.forNpc(skullCollector).find((skill) => skill.fetchSelfId() === 4658);
assert.deepStrictEqual(
    {
        type: drainRoot.fetchSkillType(), effect: drainRoot.fetchSemantic().effect,
        absorbPart: drainRoot.fetchSemantic().absorbPart, duration: drainRoot.fetchBuffTime(),
        distance: drainRoot.fetchDistance()
    },
    { type: 'drain', effect: 'root', absorbPart: 0.2, duration: 30000, distance: 600 },
    'Hold must retain its combined drain and root semantics'
);
skullCollector.setHp(skullCollector.fetchMaxHp() - 500);
const drainTarget = npcInstance(npcs.find((npc) => npc.selfId === 1582), 9602564);
const drainOutcome = C4SkillEffects.execute({
    actor: skullCollector,
    dataSendToMe() {},
    dataSendToMeAndOthers() {},
    dataSendToOthers() {}
}, skullCollector, drainTarget, drainRoot, {
    magicSkill: true,
    rng: () => 0,
    attack: { prepareSkillDamage: () => 100, clearLoadedShot() {} }
});
assert.deepStrictEqual(
    { damage: drainOutcome.damage, heal: drainOutcome.heal, rooted: EffectStore.impairments(drainTarget).rooted },
    { damage: 100, heal: 20, rooted: true },
    'a successful Hold cast must both drain 20 percent of damage and apply its root'
);

const vampire = npcInstance(npcs.find((npc) => npc.selfId === 1582), 9601582);
assert.strictEqual(EffectStats.multiplier(vampire, 'darkVuln'), 0.5,
    'Resist Dark Attack level three must expose its exact Lisvus multiplier');
assert.strictEqual(NpcSkills.forNpc(vampire).find((skill) => skill.fetchSelfId() === 4664).fetchSemantic().absorbPart, 1,
    'NPC 100% HP Drain must retain full source absorption');
const todoIds = new Set([4278, 4573, 4581, 4582, 4585, 4590, 4592, 4593, 4596, 4597, 4650, 4651, 4652, 4672]);
npcs.forEach((template, index) => {
    const instance = npcInstance(template, 9700000 + index);
    const sourcedTodo = NpcSkills.forNpc(instance).filter((skill) => todoIds.has(skill.fetchSelfId()));
    assert.ok(sourcedTodo.every((skill) => skill.fetchSkillType() === 'notDone'));
    assert.ok(sourcedTodo.every((skill) => !NpcSkills.combatSkillsFor(instance).includes(skill)),
        `NPC ${template.selfId} must never execute Lisvus TODO skills`);
});

console.log('C4 Forest of the Dead source-fidelity checks passed');
