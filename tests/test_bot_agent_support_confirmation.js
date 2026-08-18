const assert = require('assert');

require('../src/Global');

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');
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
const messages = [];

try {
    const bot = actor(10, 'Aria', 0, 0);
    const target = actor(20, 'Slava', 100, 0);
    const targetSession = { actor: target, accountId: 'player_slava' };
    const botSession = { actor: bot, accountId: 'bot_aria', plan: 'following' };
    World.user = { sessions: [targetSession] };
    Generics.skillExec = () => {};
    BotAI.tell = (_session, _targetSession, text) => {
        messages.push(text);
        return true;
    };

    const buffSkill = {
        fetchSelfId: () =>  buffSkill.id,
        fetchConsumedMp: () => 10,
        fetchName: () => 'Might',
        id: 1068
    };
    BotRoles.canBuff = () => true;
    BotSkillCapabilities.buffSkill = () => buffSkill;
    BotSkillCapabilities.supportBuffs = () => [{ type: 'might', skill: buffSkill }];

    const buff = BotAgentTools.execute(botSession, {
        action: 'buff_target',
        targetPlayerName: 'Slava',
        buffType: 'might',
        confidence: 0.95,
        reply: 'I will buff you.'
    }, [{ id: 20, name: 'Slava' }]);
    assert.strictEqual(buff.applied, true);
    assert.strictEqual(buff.reason, 'buff_requested:might');
    assert.strictEqual(messages.length, 0, 'a buff request must not speak before native effect confirmation');
    assert.strictEqual(botSession.pendingPartyChatResult.skillId, 1068);

    const fullTarget = actor(21, 'FullTarget', 100, 0);
    const fullTargetSession = { actor: fullTarget, accountId: 'player_full_target' };
    World.user = { sessions: [targetSession, fullTargetSession] };
    for (let index = 0; index < 20; index += 1) {
        EffectStore.apply(fullTarget, {
            key: `full_target_buff_${index}`,
            id: 6000 + index,
            level: 1,
            type: 'buff',
            durationMs: 10 * 60 * 1000
        });
    }
    botSession.pendingPartyChatResult = undefined;
    const fullBuff = BotAgentTools.execute(botSession, {
        action: 'buff_target',
        targetPlayerName: 'FullTarget',
        buffType: 'might',
        confidence: 0.95,
        reply: 'I will buff you.'
    }, [{ id: 21, name: 'FullTarget' }]);
    assert.strictEqual(fullBuff.applied, false, 'a direct buff request must not cast into a full buff bar');
    assert.strictEqual(fullBuff.reason, 'buff_capacity', 'a full buff bar should report capacity instead of queuing a cast');
    assert.strictEqual(botSession.pendingPartyChatResult, undefined, 'a rejected capacity request must not announce a pending cast');

    const partyAuraSkill = {
        fetchSelfId: () => partyAuraSkill.id,
        fetchConsumedMp: () => 10,
        fetchName: () => 'Party Aura',
        fetchTargetKind: () => 'party',
        fetchDistance: () => -1,
        fetchSemantic: () => ({
            effectType: 'buff',
            effect: 'party_aura',
            target: 'party',
            radius: 1000
        }),
        id: 5200
    };
    bot.session = botSession;
    botSession.partyCompanion = true;
    botSession.followPlayerSession = targetSession;
    fullTargetSession.partyCompanion = true;
    fullTargetSession.followPlayerSession = targetSession;
    BotSkillCapabilities.buffSkill = (_actor, requestedType) => requestedType === 'party_aura'
        ? partyAuraSkill
        : buffSkill;
    const fullPartyAura = BotAgentTools.execute(botSession, {
        action: 'buff_target',
        targetPlayerName: 'Slava',
        buffType: 'party_aura',
        confidence: 0.95,
        reply: 'I will buff the party.'
    }, [{ id: 20, name: 'Slava' }]);
    assert.strictEqual(fullPartyAura.applied, false, 'a direct party aura must not cast when one party member has no capacity');
    assert.strictEqual(fullPartyAura.reason, 'buff_capacity', 'party aura capacity failures should report the full recipient that blocks the cast');
    assert.strictEqual(botSession.pendingPartyChatResult, undefined, 'a rejected party aura must not announce a pending cast');

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
    BotPartyChat.cancelExpectedSkillResult({ pendingPartyChatResult: undefined });
}
