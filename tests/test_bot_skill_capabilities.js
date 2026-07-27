const assert = require('assert');

require('../src/Global');

const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');

function skill(type, { power = 10, target = 'friendly', mp = 0 } = {}) {
    return {
        fetchPassive: () => false,
        fetchSkillType: () => type,
        fetchTargetKind: () => target,
        fetchPower: () => power,
        fetchConsumedMp: () => mp
    };
}

const rechargeLow = skill('manaRecharge', { power: 20, mp: 10 });
const rechargeHigh = skill('manaRecharge', { power: 60, mp: 20 });
const damage = skill('damage', { power: 999 });
const actor = {
    fetchMp: () => 30,
    canUseSkill: () => true,
    skillset: { skills: [damage, rechargeLow, rechargeHigh] }
};

assert.strictEqual(
    BotSkillCapabilities.manaRechargeSkill(actor),
    rechargeHigh,
    'party support should select the strongest affordable learned Recharge skill'
);
assert.strictEqual(
    BotSkillCapabilities.manaRechargeSkill({ ...actor, fetchMp: () => 15 }),
    rechargeLow,
    'party support should not select a Recharge spell it cannot afford'
);
assert.strictEqual(
    BotSkillCapabilities.manaRechargeSkill({ ...actor, skillset: { skills: [damage] } }),
    null,
    'ordinary damage skills must never be treated as mana support'
);

console.log('Bot skill capability checks passed');
