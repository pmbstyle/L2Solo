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
        fetchSemantic: () => options.semantic || {},
        fetchSkillType: () => options.type || C4SkillRules.SPOIL,
        fetchTargetKind: () => options.target || 'enemy',
        fetchDistance: () => options.range ?? 600,
        fetchPower: () => options.power ?? 20,
        fetchSpell: () => true
    };
}

function bot(classId, spoilSkill, mpRef) {
    return {
        fetchClassId: () => classId,
        fetchLevel: () => 40,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => mpRef.value,
        fetchMaxMp: () => 100,
        fetchCollectivePAtk: () => 100,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        skillset: {
            fetchSkill(selfId) {
                return selfId === spoilSkill.selfId ? spoilSkill : null;
            }
        },
        backpack: {
            fetchTotalWeaponKind: () => '',
            fetchTotalWeaponPAtkRnd: () => 0,
            fetchEquippedArmors: () => []
        }
    };
}

const mpRef = { value: 0 };
const spoilSkill = skill(254, { name: 'Spoil', mp: 5 });
const spoiler = bot(55, spoilSkill, mpRef);
const target = {
    fetchId: () => 22001,
    fetchHp: () => 1000,
    fetchCollectivePDef: () => 100,
    fetchLocX: () => 400,
    fetchLocY: () => 0,
    fetchAttackable: () => true,
    isDead: () => false
};
const session = {};
const generics = {
    skills: [],
    attacks: [],
    skillExec(_session, _bot, data) {
        this.skills.push(data);
    },
    attackExec(_session, _bot, data) {
        this.attacks.push(data);
    }
};

BotAI.executeCombat(session, spoiler, target, generics);
assert.strictEqual(generics.skills.length, 0, 'insufficient MP must defer Spoil');

mpRef.value = 100;
BotAI.executeCombat(session, spoiler, target, generics);
assert.deepStrictEqual(generics.skills[0], { id: 22001, selfId: 254, ctrl: true },
    'Spoil must be retried after MP recovers during the same encounter');

console.log('test_bot_spoil_retry: ok');
