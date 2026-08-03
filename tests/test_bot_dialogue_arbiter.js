const assert = require('assert');

require('../src/Global');

const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');
const BotDialogueArbiter = invoke('GameServer/Bot/AI/BotDialogueArbiter');
const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotContextAssembler = invoke('GameServer/Bot/AI/BotContextAssembler');
const BotAI = invoke('GameServer/Bot/BotAI');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

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
    const originalEnabled = BotBrain.isEnabled;
    const originalStatus = BotAI.getStatus;
    const originalBotTell = BotManager.botTell;
    const originalRecordEvent = BotSocialMemory.recordEvent;
    const originalAssemble = BotContextAssembler.assemble;
    const originalWithObservation = LangfuseTracing.withObservation;
    const originalWithRootObservation = LangfuseTracing.withRootObservation;
    const originalSessions = BotManager.sessions;
    const originalRoute = BotDialogueArbiter.route;
    const originalWorldUser = invoke('GameServer/World/World').user;

    const observations = [];
    try {
        const player = session('player_dialogue', actor(101, 'Slava'));
        const playerTwo = session('player_dialogue_two', actor(102, 'OtherPlayer'));
        const bot = session('bot_dialogue_arbiter', actor(201, 'Aria'));
        const captured = [];
        BotSocialMemory.recordEvent = () => Promise.resolve(null);
        BotBrain.isEnabled = () => true;
        BotAI.getStatus = () => ({ available: true, mode: 'hunting', level: 10, name: 'Aria' });
        BotBrain.maybeThink = (_bot, _event, _status, text, requestContext) => {
            captured.push({ text, requestContext });
            return true;
        };
        LangfuseTracing.withObservation = (name, input, metadata, work) => {
            observations.push(name);
            return Promise.resolve(work(null));
        };
        LangfuseTracing.withRootObservation = (name, input, metadata, work) => {
            observations.push(name);
            return Promise.resolve(work(null));
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
        assert.ok(
            !fallbackContext.recentTurns.some((turn) => turn.text === fallback.reply),
            'deterministic fallback replies must not become model-visible history'
        );

        const observationsBeforeContextFailure = observations.length;
        BotContextAssembler.assemble = async () => { throw new Error('context assembly failed'); };
        const contextFailure = await BotDialogueArbiter.route({
            playerSession: player,
            botSession: bot,
            channel: 'client_tell',
            source: 'client_tell',
            turnId: 'arbiter-context-failure',
            text: 'Please answer after a context failure.'
        });
        assert.strictEqual(contextFailure.reason, 'conversation_error');
        assert.strictEqual(fallbackReplies.length, 2, 'context errors must still deliver a fallback');
        const storedConversation = await BotConversationStore.ensureConversation(101, 201);
        assert(storedConversation.turns.some((turn) =>
            turn.turnId === 'arbiter-context-failure' && turn.role === 'bot' && turn.meta?.fallback === true
        ), 'context-error fallback must be persisted for audit while remaining hidden from the model');
        assert.deepStrictEqual(
            observations.slice(observationsBeforeContextFailure),
            ['hot-bot.dialogue', 'bot.reply.deliver', 'bot.conversation.persist'],
            'context-error fallback must retain a complete Langfuse trace'
        );

        LangfuseTracing.withRootObservation = () => Promise.reject(new Error('trace backend unavailable'));
        const traceFailure = await BotDialogueArbiter.route({
            playerSession: player,
            botSession: bot,
            channel: 'client_tell',
            source: 'client_tell',
            turnId: 'arbiter-trace-failure',
            text: 'The trace backend must not block this fallback.'
        });
        assert.strictEqual(traceFailure.ok, true);
        assert.strictEqual(traceFailure.delivered, true);
        assert.strictEqual(traceFailure.persisted, true);
        assert.strictEqual(fallbackReplies.length, 3, 'trace failures must fail open without dropping the player reply');

        const world = invoke('GameServer/World/World');
        world.user = { sessions: [player, bot] };
        const botTwo = session('bot_dialogue_two', actor(202, 'Belen', 100));
        bot.followPlayerSession = player;
        bot.partyCompanion = true;
        botTwo.followPlayerSession = player;
        botTwo.partyCompanion = true;
        BotManager.sessions = [bot, botTwo];
        const routes = [];
        BotDialogueArbiter.route = (input) => {
            routes.push(input.botSession.actor.fetchName());
            return Promise.resolve({ ok: true, started: true });
        };
        BotManager.handlePlayerSpeak(player, { text: 'bots, can anyone help?' });
        assert.deepStrictEqual(routes, ['Aria'], 'a group message must select one hot responder');

        delete player.botDialogueResponderId;
        delete player.botDialogueResponderAt;
        routes.length = 0;
        BotManager.handlePlayerSpeak(player, { text: 'nice weather today' });
        assert.deepStrictEqual(routes, [], 'unaddressed local chat must not fan out to hot bots');

        routes.length = 0;
        BotManager.handlePlayerSpeak(player, { text: 'Belen, are you there?' });
        assert.deepStrictEqual(routes, ['Belen'], 'a named bot message must select only the named responder');

        delete player.botDialogueResponderId;
        delete player.botDialogueResponderAt;
        routes.length = 0;
        BotManager.handlePlayerSpeak(player, { kind: 3, text: 'party, regroup' });
        assert.deepStrictEqual(routes, ['Aria'], 'party chat must select one companion responder');
    } finally {
        BotBrain.maybeThink = originalBrain;
        BotBrain.isEnabled = originalEnabled;
        BotAI.getStatus = originalStatus;
        BotManager.botTell = originalBotTell;
        BotSocialMemory.recordEvent = originalRecordEvent;
        BotContextAssembler.assemble = originalAssemble;
        LangfuseTracing.withObservation = originalWithObservation;
        LangfuseTracing.withRootObservation = originalWithRootObservation;
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
