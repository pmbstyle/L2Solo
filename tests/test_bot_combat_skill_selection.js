const assert = require('assert');

require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');

function skill(selfId, mp = 5) {
    return {
        selfId,
        fetchConsumedMp: () => mp
    };
}

function bot(classId, ownedSkills = [], mp = 100) {
    return {
        fetchClassId: () => classId,
        fetchMp: () => mp,
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
        fetchId: () => id
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

    const archer = bot(9, [skill(56, 5)], 20);
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

    console.log('Bot combat skill selection checks passed');
} finally {
    Math.random = originalRandom;
}
