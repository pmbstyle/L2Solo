const assert = require('assert');

require('../src/Global');

const Arbiter = invoke('GameServer/Bot/AI/BotDialogueArbiter');
const Router = invoke('GameServer/Bot/AI/PartyDialogueRouter');
const Conversations = invoke('GameServer/Bot/AI/BotConversationService');
const Social = invoke('GameServer/Bot/AI/BotSocialMemory');
const Takeover = invoke('GameServer/Bot/AI/PlayerPartyTakeover');
const Manager = invoke('GameServer/Bot/BotManager');
const DialogueState = invoke('GameServer/Bot/AI/PartyDialogueState');

const saved = [];
function replace(object, key, value) {
    saved.push(() => { object[key] = value; });
    object[key] = value;
}

function actor(id, name, locX = 0) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchClassId: () => 0,
        fetchIsOnline: () => true,
        fetchLocX: () => locX,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        isDead: () => false
    };
}

async function run() {
    assert.strictEqual(Takeover.isJoinRequest('hey guys can I join?'), true,
        'a nearby player should not need to repeat the word party in a clear join request');

    const playerSession = {
        accountId: 'player_dialogue_test',
        actor: actor(9001, 'Player')
    };
    const solo = { accountId: 'bot_solo', actor: actor(101, 'SoloBot', 50) };
    const member = {
        accountId: 'bot_member',
        actor: actor(102, 'PartyMember', 100),
        hotBackgroundPartyId: 'party-dialogue-test'
    };

    const route = Router.select({
        text: 'hey guys can I join the party?',
        playerSession,
        sessions: [solo, member],
        kind: 0
    });
    assert.strictEqual(route.candidate?.session, member,
        'an unaddressed join request must route to an autonomous party member, not the first nearby solo bot');
    assert.strictEqual(route.reason, 'nearby_party_member');

    let takeoverCalls = 0;
    let delivered = null;
    let recorded = null;
    replace(Conversations, 'validPair', () => true);
    replace(Conversations, 'beginTurn', async () => ({
        turnId: 'party-join-turn',
        channel: 'local_chat',
        playerText: 'can I join your party?',
        context: null
    }));
    replace(Conversations, 'recordBotReply', async (entry) => {
        recorded = entry;
        return true;
    });
    replace(Social, 'recordEvent', async () => true);
    replace(Takeover, 'request', async ({ target }) => {
        takeoverCalls += 1;
        assert.strictEqual(target, member, 'the addressed member must represent its full party');
        return {
            ok: true,
            applied: true,
            reason: 'party_taken_over',
            reply: 'All right. You are leading now.',
            partyId: 'party-dialogue-test',
            count: 5
        };
    });
    replace(Manager, 'botTell', (_bot, _player, text) => { delivered = text; });
    replace(DialogueState, 'recordDeliveredReply', () => true);

    const result = await Arbiter.route({
        playerSession,
        botSession: member,
        text: 'can I join your party?',
        channel: 'local_chat',
        source: 'local_chat',
        allowFallback: true
    });
    assert.strictEqual(takeoverCalls, 1, 'recognized join intent must execute without waiting for an LLM result');
    assert(result.ok && result.applied);
    assert.strictEqual(delivered, 'All right. You are leading now.');
    assert.strictEqual(recorded.meta.action, 'request_player_join_party');
    assert.strictEqual(recorded.meta.deterministic, true);
}

run().then(() => {
    while (saved.length) saved.pop()();
    console.log('player party takeover dialogue tests passed');
}).catch((error) => {
    while (saved.length) saved.pop()();
    console.error(error);
    process.exit(1);
});
