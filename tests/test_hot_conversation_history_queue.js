const assert = require('assert');

require('../src/Global');

const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotDialogueArbiter = invoke('GameServer/Bot/AI/BotDialogueArbiter');
const BotContextAssembler = invoke('GameServer/Bot/AI/BotContextAssembler');
const BotAI = invoke('GameServer/Bot/BotAI');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const World = invoke('GameServer/World/World');
const Brain = invoke('GameServer/Bot/AI/BotBrain');
const Conversations = invoke('GameServer/Bot/AI/BotConversationService');
const Manager = invoke('GameServer/Bot/BotManager');

function actor(id, name, x = 0) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLevel: () => 20,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
        fetchKarma: () => 0,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false
    };
}

function response(body) {
    return { ok: true, status: 200, json: async () => body };
}

async function until(check) {
    for (let i = 0; i < 150 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert(check(), 'queued dialogue must make progress without another external message');
}

async function main() {
    const originalConfig = options.default.OpenRouter;
    const originalAI = options.default.AI;
    const originalWorldUser = World.user;
    const originalWorldNpc = World.npc;
    const originalFetchVisibleUsers = World.fetchVisibleUsers;
    const originalStatus = BotAI.getStatus;
    const originalAssemble = BotContextAssembler.assemble;
    const originalContext = Conversations.contextFor;
    const originalTell = Manager.botTell;
    const requests = [];
    let releaseFirst;

    try {
        // Keep this OpenRouter fixture independent from developer-local [AI].
        options.default.AI = undefined;
        options.default.OpenRouter = {
            ...originalConfig,
            enabled: true,
            apiKey: 'hot-history-test-key',
            model: 'test/hot-history',
            strictSchema: false,
            maxConcurrentRequests: 32
        };
        BotConversationStore.resetMemory();
        const playerSession = {
            accountId: 'player_history',
            actor: actor(9201, 'HistoryPlayer'),
            dataSendToMe() {}
        };
        const botSession = { accountId: 'bot_history', actor: actor(9202, 'HistoryBot', 100), plan: 'hunting' };
        World.user = { sessions: [playerSession, botSession] };
        World.npc = { spawns: [] };
        World.fetchVisibleUsers = () => [playerSession];
        BotAI.getStatus = () => ({ available: true, name: 'HistoryBot', mode: 'hunting', level: 20 });
        BotContextAssembler.assemble = async () => ({ bot: {}, fragments: [], telemetry: {} });
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.setTransport(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            if (requests.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
            return response({
                choices: [{ message: { content: JSON.stringify({
                    action: 'say',
                    reply: requests.length === 1 ? 'first reply' : 'second reply',
                    reason: 'history_test',
                    confidence: 0.95
                }) } }]
            });
        });

        const first = BotDialogueArbiter.route({ playerSession, botSession, text: 'first message', channel: 'client_tell' });
        for (let i = 0; i < 20 && requests.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const second = BotDialogueArbiter.route({ playerSession, botSession, text: 'second message', channel: 'client_tell' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.strictEqual(requests.length, 1, 'second tell should wait in FIFO while the first provider call is active');
        releaseFirst();
        await Promise.all([first, second]);
        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.strictEqual(requests.length, 2);
        const secondPayload = JSON.parse(requests[1].messages[1].content);
        assert.deepStrictEqual(
            requests[1].messages.slice(2).map((turn) => turn.content),
            ['first message', 'first reply', 'second message']
        );
        await botSession.lastConversationWrite;
        const finalContext = await BotConversationStore.context(9201, 9202, { limit: 10 });
        assert.deepStrictEqual(
            finalContext.recentTurns.map((turn) => turn.text),
            ['first message', 'first reply', 'second message', 'second reply'],
            'persistent context must keep complete player/bot turn groups ordered'
        );
        for (const stage of ['before_dequeue', 'context_refresh', 'context_error', 'not_started', 'arrival_during_refresh']) {
            const firstActor = actor(9301, 'FirstPlayer');
            const firstPlayer = { accountId: 'player_queue_first', actor: firstActor };
            const otherPlayer = { accountId: 'player_queue_other', actor: actor(9303, 'OtherPlayer') };
            const queuedBot = { accountId: 'bot_queue_review', actor: actor(9302, 'QueueBot'), plan: 'hunting' };
            World.user = { sessions: [firstPlayer, otherPlayer, queuedBot] };
            const texts = [], replies = [];
            let releaseActive, releaseRefresh;
            Manager.botTell = (_bot, player, text) => replies.push({ playerId: player.actor.fetchId(), text });
            Conversations.contextFor = async player => {
                if (player === firstPlayer && ['context_refresh', 'arrival_during_refresh'].includes(stage)) await new Promise(resolve => { releaseRefresh = resolve; });
                return { recentTurns: [] };
            };
            BotContextAssembler.assemble = async ({ requestContext }) => {
                if (requestContext.playerSession === firstPlayer) {
                    if (stage === 'context_error') throw new Error('queued context unavailable');
                    if (stage === 'not_started') firstPlayer.accountId = 'bot_retired_player';
                }
                return { bot: {}, fragments: [] };
            };
            OpenRouterGateway.setTransport(async (_url, init) => {
                const body = JSON.parse(init.body);
                const text = body.messages.at(-1).content;
                texts.push(text);
                if (texts.length === 1) await new Promise(resolve => { releaseActive = resolve; });
                return response({ choices: [{ message: { content: JSON.stringify({ action: 'say', reply: 'reply: ' + text, reason: 'queue', confidence: 1 }) } }] });
            });
            assert(Brain.maybeThink(queuedBot, 'player_chat', {}, 'active first player', { playerSession: firstPlayer }));
            await until(() => releaseActive);
            assert(Brain.maybeThink(queuedBot, 'player_chat', {}, 'queued first player', { playerSession: firstPlayer }));
            assert(Brain.maybeThink(queuedBot, 'player_chat', {}, 'queued other player', { playerSession: otherPlayer }));
            if (stage === 'before_dequeue') firstPlayer.actor = actor(9304, 'Replacement');
            if (stage === 'not_started') World.user = { sessions: [queuedBot] };
            releaseActive();
            if (['context_refresh', 'arrival_during_refresh'].includes(stage)) {
                await until(() => releaseRefresh);
                if (stage === 'context_refresh') firstPlayer.actor = actor(9304, 'Replacement');
                else {
                    assert(Brain.maybeThink(queuedBot, 'player_chat', {}, 'new arrival', { playerSession: otherPlayer }));
                    assert.strictEqual(texts.length, 1, 'new arrivals cannot overtake the turn whose context is refreshing');
                }
                releaseRefresh();
            }
            await until(() => texts.includes('queued other player'));
            await until(() => !queuedBot.brainInFlight && !queuedBot.brainQueueDrain);
            if (stage === 'arrival_during_refresh') assert.deepStrictEqual(texts, ['active first player', 'queued first player', 'queued other player', 'new arrival']);
            else assert(!texts.includes('queued first player'), `${stage}: skipped turns cannot reach inference`);
            assert(replies.some(reply => reply.playerId === 9303 && reply.text === 'reply: queued other player'), `${stage}: the next player must receive its own answer`);
            assert(!replies.some(reply => reply.playerId === 9304), 'a replacement character cannot receive an old reply');
            assert.strictEqual(queuedBot.pendingBrainTurns.length, 0);
            World.fetchVisibleUsers = () => [playerSession];
        }
        console.log('Hot conversation queue history checks passed');
    } finally {
        releaseFirst?.();
        options.default.OpenRouter = originalConfig;
        options.default.AI = originalAI;
        World.user = originalWorldUser;
        World.npc = originalWorldNpc;
        World.fetchVisibleUsers = originalFetchVisibleUsers;
        BotAI.getStatus = originalStatus;
        BotContextAssembler.assemble = originalAssemble;
        Conversations.contextFor = originalContext;
        Manager.botTell = originalTell;
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.resetTransport();
        BotConversationStore.resetMemory();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
