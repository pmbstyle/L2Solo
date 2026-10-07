const assert = require('assert');

const nativeFixture = require('./helpers/isolatedSocialDatabase')('f1-spatial-test_bot_agent_support_confirmation');
require('../src/Global');
nativeFixture.assertConfigured(options.default);

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');
const BuffService = invoke('GameServer/Bot/Economy/BuffService');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const BotAI = invoke('GameServer/Bot/BotAI');
const World = invoke('GameServer/World/World');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Generics = invoke(path.actor);

function actor(id, name, x = 0, y = 0) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchIsOnline: () => true,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => 0,
        fetchMp: () => 100,
        fetchClassId: () => 17
    };
}

const originalWorldUser = World.user;
const originalSkillExec = Generics.skillExec;
const originalCanBuff = BotRoles.canBuff;
const originalIsHealer = BotRoles.isHealer;
const originalBuffSkill = BotSkillCapabilities.buffSkill;
const originalSupportBuffs = BotSkillCapabilities.supportBuffs;
const originalHealSkill = BotSkillCapabilities.healSkill;
const originalTell = BotAI.tell;
const originalBuffQuote = BuffService.quote;
const messages = [];

try {
    const bot = actor(10, 'Aria', 0, 0);
    const target = actor(20, 'Slava', 100, 0);
    const targetSession = { actor: target, accountId: 'player_slava' };
    const botSession = { actor: bot, accountId: 'bot_aria', plan: 'following' };
    World.user = { sessions: [], revision: 0 };
    for (const session of [targetSession, botSession]) {
        session.fetchAccountId = () => session.accountId;
        session.actor.session = session;
        World.insertUser(session);
    }
    Generics.skillExec = () => {};
    BotAI.tell = (_session, _targetSession, text) => {
        messages.push(text);
        return true;
    };

    const quotes = [];
    BuffService.quote = (buyer, seller) => {
        quotes.push({ buyer, seller });
        return { ok: true, price: 100 };
    };
    BotSkillCapabilities.supportBuffs = () => [{ type: 'might' }];
    const buff = BotAgentTools.execute(botSession, {
        action: 'buff_target', targetPlayerName: 'Slava', buffType: 'might',
        confidence: 0.95, reply: 'I can quote my buffs.'
    }, [{ id: 20, name: 'Slava' }]);
    assert.strictEqual(buff.applied, true);
    assert.strictEqual(buff.reason, 'buff_quote');
    assert.deepStrictEqual(quotes, [{ buyer: targetSession, seller: botSession }]);
    assert.strictEqual(botSession.pendingPartyChatResult, undefined,
        'a buff quote must not queue an unpaid cast');
    assert.strictEqual(messages.length, 0, 'the action must not claim a completed buff');

    botSession.pendingPartyChatResult = undefined;
    const healSkill = {
        fetchSelfId: () => healSkill.id,
        fetchConsumedMp: () => 10,
        fetchName: () => 'Heal',
        id: 1011
    };
    BotRoles.isHealer = () => true;
    BotSkillCapabilities.healSkill = () => healSkill;

    const heal = BotAgentTools.execute(botSession, {
        action: 'heal_target',
        targetPlayerName: 'Slava',
        confidence: 0.95,
        reply: 'Healing you.'
    }, [{ id: 20, name: 'Slava' }]);
    assert.strictEqual(heal.applied, true);
    assert.strictEqual(heal.reason, 'heal_requested');
    assert.strictEqual(messages.length, 0, 'a heal request must not speak before native effect confirmation');
    assert.strictEqual(botSession.pendingPartyChatResult.skillId, 1011);

    console.log('Bot agent support confirmation checks passed');
} finally {
    World.user = originalWorldUser;
    Generics.skillExec = originalSkillExec;
    BotRoles.canBuff = originalCanBuff;
    BotRoles.isHealer = originalIsHealer;
    BotSkillCapabilities.buffSkill = originalBuffSkill;
    BotSkillCapabilities.supportBuffs = originalSupportBuffs;
    BotSkillCapabilities.healSkill = originalHealSkill;
    BotAI.tell = originalTell;
    BuffService.quote = originalBuffQuote;
    BotPartyChat.cancelExpectedSkillResult({ pendingPartyChatResult: undefined });
    require('node:fs').rmSync(nativeFixture.directory, { recursive: true, force: true });
}
