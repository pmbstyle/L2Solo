const assert = require('assert');

require('../src/Global');

const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');
const BotDialogueArbiter = invoke('GameServer/Bot/AI/BotDialogueArbiter');
const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotAI = invoke('GameServer/Bot/BotAI');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');

function actor(id, name, x = 0) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        fetchDestId: () => 0
    };
}

function session(accountId, actorValue) {
    return {
        accountId,
        actor: actorValue,
        dataSendToMe() {},
        dataSendToOthers() {}
    };
}

async function main() {
    BotConversationStore.resetMemory();

    const originalBrain = BotBrain.maybeThink;
    const originalStatus = BotAI.getStatus;
    const originalBotTell = BotManager.botTell;
    const originalRecordEvent = BotSocialMemory.recordEvent;
    const originalSessions = BotManager.sessions;
    const originalRoute = BotDialogueArbiter.route;
    const originalWorldUser = invoke('GameServer/World/World').user;

    try {
        const player = session('player_dialogue', actor(101, 'Slava'));
        const playerTwo = session('player_dialogue_two', actor(102, 'OtherPlayer'));
        const bot = session('bot_dialogue_arbiter', actor(201, 'Aria'));
        const captured = [];
        BotSocialMemory.recordEvent = () => Promise.resolve(null);
        BotAI.getStatus = () => ({ available: true, mode: 'hunting', level: 10, name: 'Aria' });
        BotBrain.maybeThink = (_bot, _event, _status, text, requestContext) => {
            captured.push({ text, requestContext });
            return true;
        };

        const first = await BotDialogueArbiter.route({
            playerSession: player,
            botSession: bot,
            channel: 'client_tell',
            source: 'client_tell',
            turnId: 'arbiter-1',
            text: 'Hello, Aria.'
        });
        assert.strictEqual(first.ok, true);
        assert.strictEqual(first.started, true);
        assert.strictEqual(captured[0].requestContext.conversation.recentTurns[0].text, 'Hello, Aria.');

        await BotConversationService.recordBotReply({
            playerSession: player,
            botSession: bot,
            turnId: 'arbiter-1',
            channel: 'client_tell',
            text: 'Hello, Slava.'
        });
        await BotDialogueArbiter.route({
            playerSession: player,
            botSession: bot,
            channel: 'client_tell',
            source: 'client_tell',
            turnId: 'arbiter-2',
            text: 'Do you remember me?'
        });
        assert.deepStrictEqual(
            captured[1].requestContext.conversation.recentTurns.map((turn) => turn.text),
            ['Hello, Aria.', 'Hello, Slava.', 'Do you remember me?']
        );

        await BotDialogueArbiter.route({
            playerSession: playerTwo,
            botSession: bot,
            channel: 'client_tell',
            source: 'client_tell',
            turnId: 'arbiter-other',
            text: 'This history must stay separate.'
        });
        assert.deepStrictEqual(
            captured[2].requestContext.conversation.recentTurns.map((turn) => turn.text),
            ['This history must stay separate.']
        );

        const fallbackReplies = [];
        BotManager.botTell = (_botSession, _playerSession, text) => fallbackReplies.push(text);
        BotBrain.maybeThink = () => false;
        const fallback = await BotDialogueArbiter.route({
            playerSession: player,
            botSession: bot,
            channel: 'client_tell',
            source: 'client_tell',
            turnId: 'arbiter-fallback',
            text: 'Are you still hunting?'
        });
        assert.strictEqual(fallback.started, false);
        assert.strictEqual(fallbackReplies.length, 1);
        const fallbackContext = await BotConversationService.contextFor(player, bot, { limit: 10 });
        assert.ok(fallbackContext.recentTurns.some((turn) => turn.text === fallback.reply));

        const world = invoke('GameServer/World/World');
        world.user = { sessions: [player, bot] };
        const botTwo = session('bot_dialogue_two', actor(202, 'Belen', 100));
        BotManager.sessions = [bot, botTwo];
        const routes = [];
        BotDialogueArbiter.route = (input) => {
            routes.push(input.botSession.actor.fetchName());
            return Promise.resolve({ ok: true, started: true });
        };
        BotManager.handlePlayerSpeak(player, { text: 'bots, can anyone help?' });
        assert.deepStrictEqual(routes, ['Aria'], 'a group message must select one hot responder');
    } finally {
        BotBrain.maybeThink = originalBrain;
        BotAI.getStatus = originalStatus;
        BotManager.botTell = originalBotTell;
        BotSocialMemory.recordEvent = originalRecordEvent;
        BotManager.sessions = originalSessions;
        BotDialogueArbiter.route = originalRoute;
        invoke('GameServer/World/World').user = originalWorldUser;
    }

    console.log('Bot dialogue arbiter checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
