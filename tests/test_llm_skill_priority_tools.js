const assert = require('assert');
require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');

function skill() {
    return {
        fetchSelfId: () => 123,
        fetchName: () => 'Power Strike',
        fetchPassive: () => false,
        fetchSemantic: () => ({}),
        fetchTargetKind: () => 'enemy',
        fetchSkillType: () => C4SkillRules.DAMAGE,
        fetchDistance: () => 40,
        fetchConsumedMp: () => 4,
        fetchPower: () => 80,
        fetchSpell: () => false
    };
}

const learned = skill();
const leader = { accountId: 'player_skill_leader', actor: { fetchId: () => 710, fetchName: () => 'SkillLeader', fetchIsOnline: () => true } };
const bot = {
    accountId: 'bot_skill_tools',
    plan: 'following',
    partyCompanion: true,
    followPlayerSession: leader,
    actor: {
        fetchId: () => 711,
        fetchName: () => 'SkillCompanion',
        fetchIsOnline: () => true,
        skillset: { skills: [learned], fetchSkill: (id) => Number(id) === 123 ? learned : null }
    }
};
BotManager.sessions = [bot];

function decision(action, turnId, extra = {}) {
    return {
        action,
        confidence: 0.99,
        reply: '',
        targetPlayerName: '',
        spotId: '',
        buffType: '',
        reason: 'skill policy test',
        turnId,
        ...extra
    };
}

try {
    const ctx = (turnId) => ({ playerSession: leader, conversationTurn: { turnId } });
    const set = BotAgentTools.execute(bot, decision('set_skill_priority', 'skill-1', { skillId: 123, skillPriority: 50 }), [], ctx('skill-1'));
    assert.strictEqual(set.applied, true);
    assert.strictEqual(HotBotPolicyOverlay.status(bot).skillPriorities['123'], 50);

    const stance = BotAgentTools.execute(bot, decision('set_combat_stance', 'skill-2', { combatStance: 'ranged' }), [], ctx('skill-2'));
    assert.strictEqual(stance.applied, true);
    const policy = HotBotPolicyOverlay.combatPolicy(bot);
    assert.strictEqual(policy.stance, 'ranged');
    assert(BotCombatUtility.policyAdjustment(learned, 'dps', 40, 4, 100, { stance: policy.stance }) < 0, 'ranged stance must not prefer melee range');

    const clear = BotAgentTools.execute(bot, decision('clear_skill_priority', 'skill-3', { skillId: 123 }), [], ctx('skill-3'));
    assert.strictEqual(clear.applied, true);
    assert.deepStrictEqual(HotBotPolicyOverlay.status(bot).skillPriorities, {});

    const invalid = BotAgentTools.execute(bot, decision('set_skill_priority', 'skill-4', { skillId: 123, skillPriority: 51 }), [], ctx('skill-4'));
    assert.deepStrictEqual(invalid, { applied: false, reason: 'invalid_skill_priority' });
    console.log('LLM skill priority tool checks passed');
} finally {
    HotBotPolicyOverlay.clear(bot, 'test_cleanup');
}
