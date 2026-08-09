const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const skillBindings = require('../data/Npcs/Skills/c4_elmore_northeast_coast.json');

DataCache.init();

const mobIds = [1124, 1125, 1126, 1127, 1128, 1129, 1130];
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-elmore-northeast-coast');

assert.strictEqual(npcs.length, 7, 'all seven Lisvus northeast coast monster variants must be loaded');
assert.strictEqual(rewards.length, 7, 'every northeast coast monster must have a reward template');
assert.ok(spawnArea, 'Elmore northeast coast spawn slice must be loaded');

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnArea.spawns.length, 7, 'spawn definitions must cover every source variant');
assert.strictEqual(spawnCoords.length, 283, 'the import must retain all 283 Lisvus spawn rows');
assert.ok(spawnArea.spawns.every((spawn) => spawn.total === 1 && spawn.respawn === 120 && spawn.bias === 0));
assert.deepStrictEqual(
    spawnArea.spawns.map((spawn) => [spawn.selfId, spawn.coords.length]),
    [[1124, 43], [1125, 44], [1126, 39], [1127, 44], [1128, 39], [1129, 32], [1130, 42]],
    'every source family must retain its exact local population'
);

assert.deepStrictEqual(
    [...new Set(spawnCoords.map((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY)))].sort(),
    ['24_11', '25_11', '25_12'],
    'source spawns must stay in their three northeast coast geodata regions'
);
[[24, 11], [25, 11], [25, 12]].forEach(([x, y]) => {
    assert.strictEqual(GeodataEngine.loadRegion(x, y), true, `geodata region ${x}_${y} must be available`);
});
const heightDeltas = spawnCoords.map((coord) => Math.abs(
    GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
));
assert.ok(heightDeltas.filter((delta) => delta <= 128).length >= 279,
    'at least 279 source coordinates must agree with geodata within 128 Z');
assert.strictEqual(Math.max(...heightDeltas), 747,
    'coastal cliff coordinates must stay within the audited source/geodata maximum delta');

const bat = npcs.find((npc) => npc.selfId === 1124);
assert.deepStrictEqual(
    {
        name: bat.template.name, level: bat.template.level, hostile: bat.template.hostile,
        pAtk: bat.stats.pAtk, pDef: bat.stats.pDef, mAtk: bat.stats.mAtk, mDef: bat.stats.mDef,
        hp: bat.vitals.maxHp, exp: Math.round(bat.rewards.exp * bat.template.level ** 2),
        sp: bat.rewards.sp, clan: bat.clan.clanName, race: bat.traits.race
    },
    {
        name: 'Red Eye Barbed Bat', level: 18, hostile: false, pAtk: 48, pDef: 73,
        mAtk: 19, mDef: 70, hp: 476, exp: 640, sp: 28, clan: '', race: 'beast'
    },
    'the representative template must retain exact Lisvus combat and reward values'
);
assert.deepStrictEqual(
    npcs.filter((npc) => npc.template.hostile).map((npc) => npc.selfId),
    [1125, 1129, 1130],
    'the source aggressive variants must remain exact'
);

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 83, 'all Lisvus drop and spoil rows must survive the category transform');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
assert.ok(rewards.every((reward) => reward.spoils.every((group) => group.items.length === 1 && group.overall === 100)),
    'category -1 rows must remain independent spoil rolls');

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template), locX: 170000, locY: -200000, locZ: -2000, head: 0
    });
}

const expectedCombatSkills = new Map([
    [1124, []], [1125, []], [1126, []], [1127, []], [1128, [4254]], [1129, []], [1130, []]
]);
assert.strictEqual(skillBindings.length, 13, 'all Lisvus northeast coast NPC skill rows must be present');
expectedCombatSkills.forEach((skillIds, npcId) => {
    const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 9950000 + npcId);
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

const batInstance = npcInstance(bat, 9961124);
assert.strictEqual(EffectStats.multiplier(batInstance, 'windVuln'), 1.15,
    'Wind Attack Weak Point level two must expose its exact Lisvus multiplier');
assert.strictEqual(EffectStats.multiplier(batInstance, 'bowWpnVuln'), 1.1,
    'Archery Attack Weak Point level one must expose its exact Lisvus multiplier');

const golem = npcInstance(npcs.find((npc) => npc.selfId === 1128), 9961128);
assert.strictEqual(EffectStats.multiplier(golem, 'bowWpnVuln'), 0.3,
    'Resist Archery level four must expose its exact Lisvus multiplier');
assert.strictEqual(EffectStats.multiplier(golem, 'daggerWpnVuln'), 0.7,
    'Resist Dagger level two must expose its exact Lisvus multiplier');
const prominence = NpcSkills.combatSkillsFor(golem)[0];
assert.deepStrictEqual(
    {
        id: prominence.fetchSelfId(), type: prominence.fetchSkillType(), trait: prominence.fetchSemantic().trait,
        magicLevel: prominence.fetchSemantic().magicLevel, levelDepend: prominence.fetchSemantic().levelDepend,
        distance: prominence.fetchDistance(), effectRange: prominence.fetchSemantic().effectRange
    },
    { id: 4254, type: 'damage', trait: 'magic', magicLevel: 20, levelDepend: 1, distance: 1000, effectRange: 1500 },
    'NPC Prominence level two must retain exact source range and magic-level semantics'
);

console.log('C4 Elmore northeast coast source-fidelity checks passed');
