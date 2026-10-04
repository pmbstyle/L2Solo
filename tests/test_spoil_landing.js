// Spoil, Spoil Festival and the cold spoil of a kill land only when the C4
// magic success roll passes (Lisvus Spoil.java, Formulas.calcMagicSuccess):
// the fail chance grows as 1.3^(mob level - the skill's magic level).
const assert = require('assert');

process.env.L2NODE_PROGRESSION_RATE = 'x1';
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
const SkillModel = invoke('GameServer/Model/Skill');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ColdKillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');

DataCache.init();

const SPOIL_MAGIC_LEVELS = [10, 20, 28, 36, 43, 49, 55, 60, 64, 68, 72];

// Exact landing percent: one random value inside each of the 10000 roll steps.
function landingPercent(skillId, skillLevel, targetLevel) {
    let landed = 0;
    for (let i = 0; i < 10000; i++) {
        if (Formulas.calcSpoilSuccess({ skillId, skillLevel, attackerLevel: 80, targetLevel }, () => (i + 0.5) / 10000)) landed += 1;
    }
    return landed / 100;
}

// C4 table: gap (mob level - magic level) -> landing percent.
const C4_TABLE = [[-5, 99.72], [0, 98.99], [5, 96.28], [10, 86.2], [14, 60.62], [16, 33.45], [18, 0], [25, 0]];
SPOIL_MAGIC_LEVELS.forEach((magicLevel, index) => {
    for (const [gap, percent] of C4_TABLE) {
        assert.strictEqual(landingPercent(254, index + 1, magicLevel + gap), percent,
            `Spoil ${index + 1} (magic level ${magicLevel}) at gap ${gap} must land ${percent}%`);
    }
});
[28, 36, 43, 49, 55, 62, 66, 70, 74].forEach((magicLevel, index) => {
    assert.strictEqual(landingPercent(302, index + 1, magicLevel + 10), 86.2,
        `Spoil Festival ${index + 1} must roll against magic level ${magicLevel}`);
});
assert.strictEqual(landingPercent(348, 1, 76 + 10), 86.2, 'Spoil Crush keeps its magic level 76');

// Hot Spoil and Spoil Festival.
const spoilNpcId = 93; // Orc Fighter, level 10, has a spoil list
function npc(id, level) {
    return {
        model: {},
        combat: 0,
        fetchId: () => id,
        fetchSelfId: () => spoilNpcId,
        fetchLevel: () => level,
        fetchAttackable: () => true,
        isDead: () => false,
        enterCombatState() { this.combat += 1; }
    };
}
function caster() {
    let casts = false;
    let mp = 1000;
    return {
        state: { fetchCasts: () => casts, setCasts(value) { casts = value; } },
        attack: { queueTimer(callback) { callback(); } },
        fetchId: () => 2000100,
        fetchName: () => 'Spoiler',
        fetchLevel: () => 40,
        fetchMp: () => mp,
        setMp(value) { mp = value; },
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        statusUpdateVitals() {},
        automation: { replenishVitals() {} },
        isDead: () => false
    };
}
function session() {
    return { texts: 0, dataSendToMe() { this.texts += 1; }, dataSendToMeAndOthers() {} };
}
function skill(selfId, level) {
    const template = DataCache.skills.find((entry) => Number(entry.selfId) === selfId);
    const row = template.levels.find((entry) => Number(entry.level) === level);
    return new SkillModel({ ...utils.crushOb(template), ...row, selfId, level });
}

const savedRandom = Math.random;
const savedInfo = console.info;
console.info = () => {};
try {
    // Spoil 4 (magic level 36) on a level-36 mob: lands unless the roll is in the lowest 1%.
    const spoil4 = skill(254, 4);
    Math.random = () => 0.005;
    const missed = npc(1, 36);
    SpoilSweep.castSpoil(session(), caster(), missed, spoil4);
    assert.strictEqual(missed.model.spoil, undefined, 'hot Spoil must be able to fail');
    assert.strictEqual(missed.combat, 1, 'a failed Spoil still draws the mob into combat');

    Math.random = () => 0.5;
    const landed = npc(2, 36);
    SpoilSweep.castSpoil(session(), caster(), landed, spoil4);
    assert.strictEqual(landed.model.spoil?.spoiled, true, 'hot Spoil lands on a passing roll');

    // Spoil Festival 2 (magic level 36): a level-36 mob lands, a level-56 mob (gap 20) cannot.
    const festival = skill(302, 2);
    const near = npc(3, 36);
    const far = npc(4, 56);
    SpoilSweep.castSpoilTargets(session(), caster(), [near, far], festival);
    assert.strictEqual(near.model.spoil?.spoiled, true, 'Spoil Festival lands on a close-level mob');
    assert.strictEqual(far.model.spoil, undefined, 'Spoil Festival must fail 20 levels above its magic level');
    assert.strictEqual(far.combat, 1, 'a failed Spoil Festival target still enters combat');
} finally {
    Math.random = savedRandom;
    console.info = savedInfo;
}

// Cold spoil: a test mob whose spoil list always yields one item once spoiled.
const savedRewards = DataCache.npcRewards;
try {
    DataCache.npcRewards = [{
        selfId: 99201,
        template: { name: 'Spoil Landing Mob' },
        rewards: [],
        spoils: [{ overall: 100, items: [{ selfId: 1867, name: 'Animal Skin', chance: 100, min: 1, max: 1 }] }]
    }];
    const spot = (level) => ({
        id: `spoil-landing-${level}`, avgLevel: level,
        npcEntries: [{ selfId: 99201, count: 1 }], npcSelfIds: [99201], npcNames: [],
        rewards: { exp: 10, sp: 1, adenaMin: 1, adenaMax: 1 }
    });
    const coldSpoil = (spotLevel, spoiler, value) => ColdKillRewards.roll({
        spot: spot(spotLevel), kills: [{ npcSelfId: 99201 }], killerLevel: spotLevel, rng: () => value, spoiler
    }).loot[0].spoil;

    // Spoil 1 (magic level 10) on a level-10 mob: the landing roll fails at 0.005 and passes at 0.02.
    const spoil1 = { level: 15, skillLevel: 1 };
    assert.deepStrictEqual(coldSpoil(10, spoil1, 0.005), [], 'cold spoil loot needs a landed Spoil');
    assert.deepStrictEqual(coldSpoil(10, spoil1, 0.02).map((item) => item.selfId), [1867],
        'a landed cold Spoil yields the spoil list');
    assert.deepStrictEqual(coldSpoil(10, null, 0.5), [], 'a fighter without Spoil gets no spoil loot');
    assert.strictEqual(ColdKillRewards.spoilerFor({ level: 5 }, { skills: [] }), null,
        'a dwarf that has not learned Spoil is not a spoiler');

    // An Artisan keeps Spoil 1 from its Dwarven Fighter days.
    const artisanState = { level: 38, classId: 56, stats: { classId: 56 } };
    const artisan = ColdKillRewards.spoilerFor(artisanState, ColdCombatProfile.profileFor(artisanState));
    assert.deepStrictEqual(artisan, { level: 38, skillLevel: 1 }, 'an Artisan spoils with Spoil 1');
    let state = 7;
    const rng = () => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return state / 4294967296;
    };
    let spoiled = 0;
    for (let kill = 0; kill < 2000; kill++) {
        if (ColdKillRewards.roll({ spot: spot(35), kills: [{ npcSelfId: 99201 }], killerLevel: 38, rng, spoiler: artisan })
            .loot[0].spoil.length > 0) spoiled += 1;
    }
    assert.strictEqual(spoiled, 0, 'an Artisan with Spoil 1 must not land Spoil on level-35 mobs');

    // A Scavenger with Spoil 4 (magic level 36) on level-36 mobs lands about 99%.
    spoiled = 0;
    for (let kill = 0; kill < 2000; kill++) {
        if (ColdKillRewards.roll({ spot: spot(36), kills: [{ npcSelfId: 99201 }], killerLevel: 38, rng,
            spoiler: { level: 38, skillLevel: 4 } }).loot[0].spoil.length > 0) spoiled += 1;
    }
    assert(spoiled > 1940 && spoiled < 2000, `Spoil 4 at gap 0 must land about 99% (landed ${spoiled} of 2000)`);
} finally {
    DataCache.npcRewards = savedRewards;
}

console.log('test_spoil_landing: ok');
