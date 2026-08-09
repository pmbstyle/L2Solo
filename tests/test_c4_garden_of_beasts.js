const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
const skillBindings = require('../data/Npcs/Skills/c4_garden_of_beasts.json');

DataCache.init();

const mobIds = Array.from({ length: 20 }, (_, index) => 1274 + index);
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-garden-of-beasts');

assert.strictEqual(npcs.length, 20, 'all twenty Lisvus Garden of Beasts variants must be loaded');
assert.strictEqual(rewards.length, 20, 'all twenty Lisvus reward templates must be loaded');
assert.ok(spawnArea, 'Garden of Beasts spawn slice must be loaded');

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnArea.spawns.length, 20, 'spawn definitions should cover every Garden monster variant');
assert.strictEqual(spawnCoords.length, 265, 'the imported slice must retain all 265 Lisvus spawn rows');
assert.ok(spawnArea.spawns.every((spawn) => spawn.total === 1 && spawn.respawn === 40 && spawn.bias === 0));
assert.deepStrictEqual(
    [...new Set(spawnCoords.map((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY)))].sort(),
    ['23_16', '24_16'],
    'source spawns must stay in their two original geodata regions'
);

assert.strictEqual(GeodataEngine.loadRegion(23, 16), true, 'western source spawn region must have geodata');
assert.strictEqual(GeodataEngine.loadRegion(24, 16), true, 'eastern source spawn region must have geodata');
const heightDeltas = spawnCoords.map((coord) => Math.abs(
    GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
));
assert.ok(heightDeltas.filter((delta) => delta <= 128).length >= 262,
    'at least 262 source spawns must agree with geodata within 128 Z');
assert.ok(Math.max(...heightDeltas) <= 570, 'the source/geodata Z delta must stay within the audited maximum');

const kookaburra = npcs.find((npc) => npc.selfId === 1274);
assert.deepStrictEqual(
    {
        name: kookaburra.template.name,
        level: kookaburra.template.level,
        hostile: kookaburra.template.hostile,
        pAtk: kookaburra.stats.pAtk,
        pDef: kookaburra.stats.pDef,
        mAtk: kookaburra.stats.mAtk,
        mDef: kookaburra.stats.mDef,
        hp: kookaburra.vitals.maxHp,
        exp: Math.round(kookaburra.rewards.exp * kookaburra.template.level ** 2),
        sp: kookaburra.rewards.sp,
        clan: kookaburra.clan.clanName,
        race: kookaburra.traits.race
    },
    {
        name: 'Kookaburra',
        level: 67,
        hostile: false,
        pAtk: 1169,
        pDef: 373,
        mAtk: 681,
        mDef: 356,
        hp: 3626,
        exp: 8356,
        sp: 796,
        clan: 'animal_clan',
        race: 'animal'
    },
    'the representative template must retain Lisvus combat and reward values'
);

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 308, 'all Lisvus drop and spoil rows must survive the category transform');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
assert.deepStrictEqual(
    [5547, 5548].map((itemId) => DataCache.items.find((item) => item.selfId === itemId)?.template.name),
    ['Elemental Sword Edge', 'Tallum Blade Edge'],
    'both source-only A-grade material templates must be loaded'
);
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
    assert.strictEqual(rolled.length, richestSpoil.spoils.length,
        'one sweep can award every independently successful spoil row');
} finally {
    Math.random = originalRandom;
}

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template),
        locX: 132997,
        locY: -60608,
        locZ: -2960,
        head: 0
    });
}

const expectedCombatSkills = new Map([
    [1274, [4067]],
    [1275, [4032]],
    [1276, [4244]],
    [1277, [4157, 4160]],
    [1278, [4032]],
    [1279, [4073]],
    [1280, [4232]],
    [1281, [4257, 4160]],
    [1282, [4067]],
    [1283, [4073]],
    [1284, [4072]],
    [1285, [4158, 4160]],
    [1286, [4073]],
    [1287, [4072]],
    [1288, [4244]],
    [1289, [4157, 4160]],
    [1290, [4073]],
    [1291, [4072]],
    [1292, [4232]],
    [1293, [4158, 4160]]
]);
assert.strictEqual(skillBindings.length, 69, 'all Lisvus NPC skill rows must be present');
expectedCombatSkills.forEach((skillIds, npcId) => {
    const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 9200000 + npcId);
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

const feebleKookaburra = npcInstance(kookaburra, 9001274);
assert.strictEqual(EffectStats.multiplier(feebleKookaburra, 'maxHpMul'), 0.5,
    'Feeble Type must expose the Lisvus maximum-HP multiplier');
assert.strictEqual(feebleKookaburra.fetchMaxHp(), 1813,
    'Feeble Type must affect the NPC maximum HP used by runtime vitals');
assert.strictEqual(feebleKookaburra.fetchHp(), 1813,
    'newly spawned Feeble Type NPCs must fill to their adjusted maximum HP');

const antelopeCaster = npcInstance(npcs.find((npc) => npc.selfId === 1281), 9001281);
const antelopeSkills = NpcSkills.combatSkillsFor(antelopeCaster);
const hydroblast = antelopeSkills.find((skill) => skill.fetchSelfId() === 4257);
assert.strictEqual(hydroblast.fetchSkillType(), 'damage');
assert.strictEqual(hydroblast.fetchSemantic().trait, 'water');
assert.strictEqual(hydroblast.fetchSemantic().sourceTarget, 'area');
assert.strictEqual(hydroblast.fetchSemantic().radius, 200);
assert.strictEqual(hydroblast.fetchDistance(), 500);

const grendel = npcInstance(npcs.find((npc) => npc.selfId === 1292), 9001292);
const aeStrike = NpcSkills.combatSkillsFor(grendel)[0];
assert.strictEqual(aeStrike.fetchSelfId(), 4232);
assert.strictEqual(aeStrike.fetchSkillType(), 'damage');
assert.strictEqual(aeStrike.fetchSemantic().trait, 'physical');
assert.strictEqual(aeStrike.fetchSemantic().sourceTarget, 'area');
assert.strictEqual(aeStrike.fetchSemantic().radius, 20);

const buffaloCaster = npcInstance(npcs.find((npc) => npc.selfId === 1289), 9001289);
const buffaloSkills = NpcSkills.combatSkillsFor(buffaloCaster);
assert.strictEqual(buffaloSkills.find((skill) => skill.fetchSelfId() === 4157).fetchSemantic().trait, 'fire');
assert.strictEqual(buffaloSkills.find((skill) => skill.fetchSelfId() === 4160).fetchSemantic().trait, 'magic');

console.log('C4 Garden of Beasts source-fidelity checks passed');
