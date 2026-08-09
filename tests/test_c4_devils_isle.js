const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const skillBindings = require('../data/Npcs/Skills/c4_devils_isle.json');
const verifyGeodataWhenAvailable = require('./helpers/verify_geodata_when_available');

DataCache.init();

const mobIds = [832, 833, 834, 835, 836, 839, 840, 841, 842, 843, 844, 845, 846, 847, 986];
const mobIdSet = new Set(mobIds);
const npcs = DataCache.npcs.filter((npc) => mobIdSet.has(npc.selfId));
const rewards = DataCache.npcRewards.filter((reward) => mobIdSet.has(reward.selfId));
const spawnArea = DataCache.npcSpawns.find((area) => area.selfId === 'c4-devils-isle');

assert.strictEqual(npcs.length, 15, "all 15 Lisvus Devil's Isle monster variants must be loaded");
assert.strictEqual(rewards.length, 15, "every Devil's Isle monster must have a reward template");
assert.ok(spawnArea, "Devil's Isle spawn slice must be loaded");

const spawnCoords = spawnArea.spawns.flatMap((spawn) => spawn.coords);
assert.strictEqual(spawnArea.spawns.length, 15, 'spawn definitions must cover every source monster variant');
assert.strictEqual(spawnCoords.length, 452, 'the import must retain all 452 Lisvus spawn rows');
assert.ok(spawnArea.spawns.every((spawn) => spawn.total === 1 && spawn.bias === 0));
assert.ok(spawnArea.spawns.filter((spawn) => spawn.selfId !== 986).every((spawn) => spawn.respawn === 55));
assert.strictEqual(spawnArea.spawns.find((spawn) => spawn.selfId === 986).respawn, 320,
    'Sairon must retain its distinct source respawn');

assert.deepStrictEqual(
    [...new Set(spawnCoords.map((coord) => GeodataEngine.getRegionKey(coord.locX, coord.locY)))],
    ['21_24'],
    "all source spawns must remain in the Devil's Isle geodata region"
);
verifyGeodataWhenAvailable(GeodataEngine, [[21, 24]], "Devil's Isle", () => {
    const heightDeltas = spawnCoords.map((coord) => Math.abs(
        GeodataEngine.getHeight(coord.locX, coord.locY, coord.locZ) - coord.locZ
    ));
    assert.ok(heightDeltas.filter((delta) => delta <= 128).length >= 449,
        'at least 449 source coordinates must agree with geodata within 128 Z');
    assert.strictEqual(Math.max(...heightDeltas), 4432,
        'the audited multi-level ship coordinate must retain its exact source/geodata delta');
});
assert.ok(spawnArea.spawns.find((spawn) => spawn.selfId === 847).coords.some((coord) =>
    coord.locX === 52196 && coord.locY === 213895 && coord.locZ === -4032),
    'the lower-deck Vale Master source coordinate must not be snapped to the surface geodata layer');

const pikeman = npcs.find((npc) => npc.selfId === 832);
assert.deepStrictEqual(
    {
        name: pikeman.template.name,
        level: pikeman.template.level,
        hostile: pikeman.template.hostile,
        pAtk: pikeman.stats.pAtk,
        pDef: pikeman.stats.pDef,
        mAtk: pikeman.stats.mAtk,
        mDef: pikeman.stats.mDef,
        hp: pikeman.vitals.maxHp,
        exp: Math.round(pikeman.rewards.exp * pikeman.template.level ** 2),
        sp: pikeman.rewards.sp,
        clan: pikeman.clan.clanName,
        race: pikeman.traits.race,
        undead: pikeman.traits.undead
    },
    {
        name: "Zaken's Pikeman", level: 43, hostile: true, pAtk: 249, pDef: 252,
        mAtk: 163, mDef: 181, hp: 1728, exp: 2720, sp: 184,
        clan: 'undead_clan1', race: 'undead', undead: true
    },
    'the representative template must retain exact Lisvus combat and reward values'
);
assert.deepStrictEqual(
    npcs.filter((npc) => npc.template.hostile).map((npc) => npc.selfId),
    [832, 834, 835, 839, 841, 843, 845, 847, 986],
    "the source's alternating aggressive and passive monster variants must remain exact"
);

const sourceDropRows = rewards.reduce((count, reward) => count
    + reward.rewards.reduce((sum, group) => sum + group.items.length, 0)
    + reward.spoils.reduce((sum, group) => sum + group.items.length, 0), 0);
assert.strictEqual(sourceDropRows, 266, 'all Lisvus drop and spoil rows must survive the category transform');
const rewardItemIds = new Set(rewards.flatMap((reward) => [...reward.rewards, ...reward.spoils]
    .flatMap((group) => group.items.map((item) => item.selfId))));
rewardItemIds.forEach((itemId) => {
    assert.ok(DataCache.items.some((item) => item.selfId === itemId), `drop item ${itemId} must have a loaded template`);
});
assert.ok(rewards.every((reward) => reward.spoils.every((group) => group.items.length === 1 && group.overall === 100)),
    'category -1 rows must remain independent spoil rolls');

function npcInstance(template, objectId) {
    return new Npc(objectId, {
        ...utils.crushOb(template), locX: 50000, locY: 210000, locZ: -3500, head: 0
    });
}

const expectedCombatSkills = new Map([
    [832, [4244]], [833, [4040]], [834, [4074]], [835, [4151, 4160]],
    [836, [4067]], [839, [4088]], [840, [4074]], [841, []], [842, [4002]],
    [843, [4067]], [844, [4047]], [845, [4067]], [846, [4074]],
    [847, [4076, 4046, 4087]], [986, [4033]]
]);
assert.strictEqual(skillBindings.length, 88, "all Lisvus Devil's Isle NPC skill rows must be present");
expectedCombatSkills.forEach((skillIds, npcId) => {
    const instance = npcInstance(npcs.find((npc) => npc.selfId === npcId), 9800000 + npcId);
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

const mardianTemplate = npcs.find((npc) => npc.selfId === 834);
const mardian = npcInstance(mardianTemplate, 9900834);
assert.strictEqual(EffectStats.multiplier(mardian, 'maxHpMul'), 2,
    'Strong Type must expose its exact Lisvus maximum-HP multiplier');
assert.strictEqual(mardian.fetchMaxHp(), mardianTemplate.vitals.maxHp * 2,
    'Strong Type must affect the NPC maximum HP used by runtime vitals');

const seer = npcInstance(npcs.find((npc) => npc.selfId === 835), 9900835);
assert.strictEqual(EffectStats.multiplier(seer, 'daggerWpnVuln'), 0.7,
    'Resist Dagger level two must expose its exact Lisvus multiplier');

const fiendArcher = npcInstance(npcs.find((npc) => npc.selfId === 841), 9900841);
const windFist = NpcSkills.forNpc(fiendArcher).find((skill) => skill.fetchSelfId() === 4141);
assert.deepStrictEqual(
    { type: windFist.fetchSkillType(), distance: windFist.fetchDistance(), hitTime: windFist.fetchHitTime() },
    { type: 'notDone', distance: 500, hitTime: 1500 },
    'NPC Wind Fist must preserve its Lisvus TODO marker and timing without entering combat AI'
);
assert.ok(!NpcSkills.combatSkillsFor(fiendArcher).includes(windFist));

console.log("C4 Devil's Isle source-fidelity checks passed");
