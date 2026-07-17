const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotAI = invoke('GameServer/Bot/BotAI');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const Generics = invoke(path.actor);
const SkillModel = invoke('GameServer/Model/Skill');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function fakeActor(id, name, options = {}) {
    const actor = {
        id,
        name,
        hp: options.hp ?? 100,
        maxHp: options.maxHp ?? 100,
        mp: options.mp ?? 100,
        maxMp: options.maxMp ?? 100,
        classId: options.classId ?? 0,
        locX: options.locX ?? 0,
        locY: options.locY ?? 0,
        locZ: options.locZ ?? 0,
        moveCalls: [],
        vitalUpdates: 0,
        fetchId() { return this.id; },
        fetchName() { return this.name; },
        fetchClassId() { return this.classId; },
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; },
        fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMp() { return this.mp; },
        fetchMaxMp() { return this.maxMp; },
        setHp(value) { this.hp = value; },
        setMp(value) { this.mp = value; },
        fetchIsOnline() { return true; },
        isDead() { return false; },
        statusUpdateVitals() { this.vitalUpdates += 1; },
        moveTo(data) { this.moveCalls.push(data); },
        skillset: {
            skills: [],
            fetchSkill(selfId) { return this.skills.find((skill) => skill.fetchSelfId() === selfId) || null; }
        }
    };
    return actor;
}

function fakeSession(accountId, actor) {
    return {
        accountId,
        actor,
        selfPackets: 0,
        dataSendToMe() { this.selfPackets += 1; },
        dataSendToOthers() {}
    };
}

const originalSessions = BotManager.sessions;
const originalSetTimeout = global.setTimeout;
const originalRecordEvent = BotSocialMemory.recordEvent;
const originalSkillExec = Generics.skillExec;
const originalBotTell = BotManager.botTell;

try {
    global.setTimeout = (fn) => {
        fn();
        return 0;
    };

    const player = fakeActor(2000001, 'Slava', { hp: 20, mp: 7 });
    const playerSession = fakeSession('player_test', player);
    const followBot = fakeActor(2000002, 'FollowBot', { locX: 100 });
    const bystanderBot = fakeActor(2000003, 'BystanderBot', { locX: 120 });
    const followSession = fakeSession('bot_follow', followBot);
    const bystanderSession = fakeSession('bot_bystander', bystanderBot);

    BotManager.sessions = [followSession, bystanderSession];
    BotManager.handlePlayerSpeak(playerSession, { text: 'follow me' });

    assert.strictEqual(followBot.moveCalls.length, 0, 'untargeted follow command should not move nearby bots');
    assert.strictEqual(bystanderBot.moveCalls.length, 0, 'untargeted follow command should not move bystanders');

    player.fetchDestId = () => followBot.fetchId();
    BotManager.handlePlayerSpeak(playerSession, { text: 'follow me' });

    assert.strictEqual(followBot.moveCalls.length, 1, 'selected bot should obey direct follow command');
    assert.strictEqual(bystanderBot.moveCalls.length, 0, 'direct follow command should not spill to other nearby bots');

    const healer = fakeActor(2000004, 'HealerBot', { classId: 15, mp: 30, locX: 100 });
    healer.skillset.skills.push(new SkillModel({
        selfId: 1011,
        name: 'Heal',
        level: 1,
        passive: false,
        spell: true,
        hp: 0,
        mp: 15,
        hitTime: 1000,
        reuse: 1000,
        power: 20,
        distance: 600
    }));
    const healerSession = fakeSession('bot_healer', healer);
    BotManager.sessions = [healerSession];
    player.fetchDestId = () => healer.fetchId();

    let supportCast = null;
    Generics.skillExec = (_session, _actor, data) => { supportCast = data; };
    BotManager.handlePlayerSpeak(playerSession, { text: 'heal me' });

    assert.deepStrictEqual(supportCast, {
        id: player.fetchId(),
        selfId: 1011,
        ctrl: false
    }, 'direct healer support should cast the learned heal through normal skill execution');
    assert.strictEqual(player.fetchHp(), 20, 'support command should not bypass skill execution with a full-HP write');

    const unskilledHealer = fakeActor(2000007, 'UnskilledHealer', { classId: 15, mp: 30, locX: 100 });
    const unskilledHealerSession = fakeSession('bot_unskilled_healer', unskilledHealer);
    BotManager.sessions = [unskilledHealerSession];
    player.fetchDestId = () => unskilledHealer.fetchId();
    supportCast = null;
    BotManager.handlePlayerSpeak(playerSession, { text: 'heal me' });
    assert.strictEqual(supportCast, null, 'direct support should reject a heal the bot has not learned');

    const partyPackets = [];
    const partyBot = fakeActor(2000012, 'PartyBot', { locX: 100 });
    const partyBotSession = fakeSession('bot_party', partyBot);
    partyBotSession.partyCompanion = true;
    partyBotSession.followPlayerSession = playerSession;
    partyBotSession.dataSendToOthers = () => {
        throw new Error('party companion chat must not use nearby chat');
    };
    playerSession.dataSendToMe = (packet) => partyPackets.push(packet);
    BotManager.sessions = [partyBotSession];
    BotManager.botSay(partyBotSession, 'Party call');
    BotManager.botTell(partyBotSession, playerSession, 'Direct party call');
    BotAI.say(partyBotSession, 'AI party call');
    BotAI.tell(partyBotSession, playerSession, 'AI direct party call');
    assert.deepStrictEqual(
        partyPackets.map((packet) => packet.readInt32LE(5)),
        [3, 3, 3, 3],
        'companion messages to its leader must use the party-chat channel, including BotAI messages'
    );
    const outsidePackets = [];
    const outsideSession = fakeSession('outside_player', fakeActor(2000013, 'OutsidePlayer'));
    outsideSession.dataSendToMe = (packet) => outsidePackets.push(packet);
    BotManager.botTell(partyBotSession, outsideSession, 'External tell');
    assert.deepStrictEqual(outsidePackets.map((packet) => packet.readInt32LE(5)), [2], 'a message outside the party must remain a private tell');
    BotManager.botSay(partyBotSession, 'External reply', outsideSession);
    assert.deepStrictEqual(outsidePackets.map((packet) => packet.readInt32LE(5)), [2, 2], 'an addressed reply outside the party must remain a private tell');

    const tank = fakeActor(2000011, 'TankWithoutBuffs', { classId: 1, mp: 30, locX: 100 });
    const tankSession = fakeSession('bot_tank', tank);
    const tankReplies = [];
    BotManager.sessions = [tankSession];
    BotManager.botTell = (_botSession, _playerSession, text) => tankReplies.push(text);
    player.fetchDestId = () => tank.fetchId();
    supportCast = null;
    BotManager.handlePlayerSpeak(playerSession, { text: 'buff me' });
    assert.strictEqual(supportCast, null, 'a bot without friendly support skills must not cast a buff');
    assert.deepStrictEqual(tankReplies, [], 'a bot without friendly support skills must ignore a direct buff request');
    BotManager.botTell = originalBotTell;

    const buffer = fakeActor(2000008, 'MageWithBuff', { classId: 25, mp: 30, locX: 100 });
    buffer.skillset.skills.push(new SkillModel({
        selfId: 1068,
        name: 'Might',
        level: 2,
        passive: false,
        spell: true,
        hp: 0,
        mp: 10,
        hitTime: 1000,
        reuse: 1000,
        power: 0,
        distance: 600
    }));
    const bufferSession = fakeSession('bot_buffer', buffer);
    const supportReplies = [];
    BotManager.botTell = (_botSession, _playerSession, text) => supportReplies.push(text);
    supportCast = null;
    BotManager.handleDirectSupportRequest(bufferSession, playerSession, 100, { buff: true });
    assert.deepStrictEqual(supportCast, {
        id: player.fetchId(),
        selfId: 1068,
        ctrl: false
    }, 'any bot with a learned friendly buff should cast it, regardless of role');
    supportReplies.length = 0;

    EffectStore.apply(player, {
        key: 'might', id: 1068, level: 2, type: 'buff', stats: { pAtkMul: 1.12 }, durationMs: 20 * 60 * 1000
    });
    supportCast = null;
    BotManager.handleDirectSupportRequest(bufferSession, playerSession, 100, { buff: true });
    assert.strictEqual(supportCast, null, 'do not overwrite an active equal-level support buff');
    assert.deepStrictEqual(supportReplies, [
        'You already have the party buffs I can improve: Might.'
    ], 'the bot should name the already-active buff instead of claiming it has nothing to offer');

    EffectStore.remove(player, 'might');
    player.supportReservations = {};
    const lowerMpBuffer = fakeActor(2000009, 'LowerMpBuffer', { classId: 25, mp: 20, locX: 100 });
    const higherMpBuffer = fakeActor(2000010, 'HigherMpBuffer', { classId: 25, mp: 50, locX: 100 });
    [lowerMpBuffer, higherMpBuffer].forEach((caster) => caster.skillset.skills.push(new SkillModel({
        selfId: 1068, name: 'Might', level: 1, passive: false, spell: true, hp: 0, mp: 10, hitTime: 1000, reuse: 1000, power: 0, distance: 600
    })));
    const lowerMpSession = fakeSession('bot_lower_mp', lowerMpBuffer);
    const higherMpSession = fakeSession('bot_higher_mp', higherMpBuffer);
    lowerMpSession.partyCompanion = true;
    lowerMpSession.followPlayerSession = playerSession;
    higherMpSession.partyCompanion = true;
    higherMpSession.followPlayerSession = playerSession;
    BotManager.sessions = [lowerMpSession, higherMpSession];
    supportReplies.length = 0;
    supportCast = null;
    BotManager.handleDirectSupportRequest(lowerMpSession, playerSession, 100, { buff: true });
    assert.strictEqual(supportCast, null, 'a lower-MP bot should wait when a party peer owns the same buff');
    BotManager.handleDirectSupportRequest(higherMpSession, playerSession, 100, { buff: true });
    assert.deepStrictEqual(supportCast, {
        id: player.fetchId(), selfId: 1068, ctrl: false
    }, 'the highest-MP party bot should cast the shared requested buff');
    assert.deepStrictEqual(supportReplies, ['Casting Might on you.'], 'only the selected party caster should answer the direct buff request');
    BotManager.botTell = originalBotTell;

    const socialEvents = [];
    BotSocialMemory.recordEvent = (fromSession, botSession, eventName, detail) => {
        socialEvents.push({
            player: fromSession.actor.fetchName(),
            bot: botSession.actor.fetchName(),
            eventName,
            detail
        });
        return Promise.resolve(null);
    };

    const insultBot = fakeActor(2000005, 'InsultBot', { locX: 100 });
    const nearbyBot = fakeActor(2000006, 'NearbyBot', { locX: 120 });
    const insultSession = fakeSession('bot_insult', insultBot);
    const nearbySession = fakeSession('bot_nearby', nearbyBot);
    BotManager.sessions = [insultSession, nearbySession];
    player.fetchDestId = () => insultBot.fetchId();

    BotManager.handlePlayerSpeak(playerSession, { text: 'you idiot' });

    assert.deepStrictEqual(socialEvents, [{
        player: 'Slava',
        bot: 'InsultBot',
        eventName: 'insulted',
        detail: 'chat'
    }], 'direct insult should be recorded only for the targeted bot');

    console.log('Bot chat command checks passed');
} finally {
    BotManager.sessions = originalSessions;
    global.setTimeout = originalSetTimeout;
    BotSocialMemory.recordEvent = originalRecordEvent;
    Generics.skillExec = originalSkillExec;
    BotManager.botTell = originalBotTell;
}
