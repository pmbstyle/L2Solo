const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

function skill(selfId, options = {}) {
    return {
        selfId,
        fetchSelfId: () => selfId,
        fetchName: () => options.name || `skill_${selfId}`,
        fetchConsumedMp: () => options.mp ?? 5,
        fetchPassive: () => false,
        fetchSemantic: () => ({}),
        fetchSkillType: () => options.type || C4SkillRules.DAMAGE,
        fetchTargetKind: () => options.target || 'enemy',
        fetchDistance: () => options.range ?? 600,
        fetchPower: () => options.power ?? 20,
        fetchSpell: () => options.spell === true
    };
}

function bot(classId, ownedSkills = [], mp = 100) {
    return {
        fetchClassId: () => classId,
        fetchMp: () => mp,
        fetchMaxMp: () => 100,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        skillset: {
            skills: ownedSkills,
            fetchSkill(selfId) {
                return this.skills.find((entry) => entry.selfId === selfId) || null;
            }
        }
    };
}

function npc(id = 1001) {
    return {
        fetchId: () => id,
        fetchLocX: () => 400,
        fetchLocY: () => 0
    };
}

function generics() {
    return {
        skills: [],
        attacks: [],
        skillExec(_session, _bot, data) {
            this.skills.push(data);
        },
        attackExec(_session, _bot, data) {
            this.attacks.push(data);
        }
    };
}

const originalRandom = Math.random;

try {
    Math.random = () => 0;

    const mage = bot(10, []);
    const mageGenerics = generics();
    BotAI.executeCombat({}, mage, npc(1101), mageGenerics);
    assert.strictEqual(mage.skillset.skills.length, 0, 'mage should not invent Wind Strike when it is not learned');
    assert.strictEqual(mageGenerics.skills.length, 0, 'mage without learned nuke should not cast an invented skill');
    assert.strictEqual(mageGenerics.attacks.length, 1, 'mage without learned nuke should fall back to a normal attack');

    const archer = bot(9, [skill(56, { mp: 5, range: 700, power: 24 })], 20);
    const archerGenerics = generics();
    BotAI.executeCombat({}, archer, npc(1102), archerGenerics);
    assert.deepStrictEqual(archerGenerics.skills[0], { id: 1102, selfId: 56, ctrl: true });
    assert.strictEqual(archerGenerics.attacks.length, 0, 'archer with learned Power Shot should cast it before ranged attack fallback');

    const fighter = bot(0, [], 20);
    const fighterGenerics = generics();
    BotAI.executeCombat({}, fighter, npc(1103), fighterGenerics);
    assert.strictEqual(fighter.skillset.skills.length, 0, 'fighter should not invent Power Strike when it is not learned');
    assert.strictEqual(fighterGenerics.skills.length, 0);
    assert.strictEqual(fighterGenerics.attacks.length, 1);

    const utilityMage = bot(10, [
        skill(1177, { name: 'Wind Strike', mp: 8, power: 12, spell: true }),
        skill(1234, { name: 'Strong Nuke', mp: 12, power: 80, spell: true })
    ], 100);
    const utilityGenerics = generics();
    const utilitySession = {};
    BotAI.executeCombat(utilitySession, utilityMage, npc(1104), utilityGenerics);
    assert.strictEqual(utilityGenerics.skills[0].selfId, 1234, 'mage should choose the stronger learned offensive spell');
    assert.strictEqual(utilitySession.lastCombatDecision.skillId, 1234, 'combat choice should be observable');

    const reserveHealer = bot(15, [skill(1300, { mp: 20, power: 100, spell: true })], 50);
    const reserveGenerics = generics();
    BotAI.executeCombat({}, reserveHealer, npc(1105), reserveGenerics);
    assert.strictEqual(reserveGenerics.skills.length, 0, 'healer should preserve support MP instead of casting an expensive nuke');
    assert.strictEqual(reserveGenerics.attacks.length, 1, 'healer with no affordable utility should use a basic attack');

    const dagger = bot(7, [
        skill(1400, { mp: 5, power: 30, range: 40 }),
        skill(1401, { mp: 5, power: 25, range: 40, type: C4SkillRules.BLOW })
    ], 100);
    const daggerGenerics = generics();
    BotAI.executeCombat({}, dagger, npc(1106), daggerGenerics);
    assert.strictEqual(daggerGenerics.skills[0].selfId, 1401, 'dagger should prefer a learned blow over generic damage');

    console.log('Bot combat skill selection checks passed');
} finally {
    Math.random = originalRandom;
}
