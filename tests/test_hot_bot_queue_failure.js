const assert = require('assert');
require('../src/Global');

const BotAI = invoke('GameServer/Bot/BotAI');
const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotContextAssembler = invoke('GameServer/Bot/AI/BotContextAssembler');
const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const BotManager = invoke('GameServer/Bot/BotManager');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const World = invoke('GameServer/World/World');

function actor(id, name, x = 0) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLevel: () => 20,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchKarma: () => 0,
        fetchDestId: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false
    };
}

function response() {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            choices: [{ message: { content: JSON.stringify({
                action: 'none',
                reply: '',
                reason: 'queue_failure_test',
                confidence: 0.95
            }) } }]
        })
    };
}

async function main() {
    const originalConfig = options.default.OpenRouter;
    const originalWorldUser = World.user;
    const originalWorldNpc = World.npc;
    const originalFetchVisibleUsers = World.fetchVisibleUsers;
    const originalAssemble = BotContextAssembler.assemble;
    const originalContextFor = BotConversationService.contextFor;
    const originalStatus = BotAI.getStatus;
    const originalBotTell = BotManager.botTell;
    const originalWithObservation = LangfuseTracing.withObservation;
    const originalWithRootObservation = LangfuseTracing.withRootObservation;
    const observations = [];
    const requests = [];
    const fallbackReplies = [];
    let releaseFirst;

    try {
        options.default.OpenRouter = {
            ...originalConfig,
            enabled: true,
            apiKey: 'queue-failure-test-key',
            model: 'test/queue-failure',
            timeoutMs: 1000,
            cooldownMs: 0,
            hotBotGlobalBudgetEnabled: false
        };
        const playerSession = {
            accountId: 'player_queue_failure',
            actor: actor(9901, 'QueueFailurePlayer'),
            dataSendToMe() {}
        };
        const botSession = {
            accountId: 'bot_queue_failure',
            actor: actor(9902, 'QueueFailureBot', 100),
            plan: 'hunting'
        };
        World.user = { sessions: [playerSession, botSession] };
        World.npc = { spawns: [] };
        World.fetchVisibleUsers = () => [playerSession];
        BotAI.getStatus = () => ({ available: true, mode: 'hunting', level: 20, name: 'QueueFailureBot' });
        BotConversationService.contextFor = async () => ({ recentTurns: [] });
        BotContextAssembler.assemble = async ({ text }) => {
            if (text === 'second') throw new Error('synthetic queued context failure');
            return { bot: {}, fragments: [], telemetry: {}, conversation: { recentTurns: [] } };
        };
        BotManager.botTell = (_bot, _player, text) => fallbackReplies.push(text);
        LangfuseTracing.withObservation = (name, input, metadata, work) => {
            observations.push({ name, metadata });
            return Promise.resolve(work(null));
        };
        LangfuseTracing.withRootObservation = (name, input, metadata, work) => {
            observations.push({ name, metadata });
            return Promise.resolve(work(null));
        };
        BotInferenceBudget.reset();
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.setTransport(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            if (requests.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
            return response();
        });

        const status = BotAI.getStatus(botSession);
        const requestContext = (turnId) => ({
            playerSession,
            source: 'client_tell',
            channel: 'client_tell',
            conversation: {
                recentTurns: [{ turnId, role: 'player', channel: 'client_tell', text: turnId, createdAt: Date.now() }]
            },
            conversationTurn: { turnId, channel: 'client_tell' },
            requestId: turnId,
            assembledContext: { bot: {}, fragments: [], telemetry: {} }
        });

        assert.strictEqual(BotBrain.maybeThink(botSession, 'player_chat', status, 'first', requestContext('first')), true);
        for (let attempt = 0; attempt < 40 && !releaseFirst; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.strictEqual(typeof releaseFirst, 'function', 'the first provider request must start');
        assert.strictEqual(BotBrain.maybeThink(botSession, 'player_chat', status, 'second', requestContext('second')), true);
        assert.strictEqual(BotBrain.maybeThink(botSession, 'player_chat', status, 'third', requestContext('third')), true);
        releaseFirst();

        for (let attempt = 0; attempt < 100 && (requests.length < 2 || botSession.brainInFlight); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await Promise.resolve(botSession.lastConversationWrite);

        assert.strictEqual(requests.length, 2, 'the third turn must continue after the failed second turn');
        assert.strictEqual(fallbackReplies.length, 1, 'the failed queued turn must receive exactly one fallback');
        assert.strictEqual(botSession.pendingBrainTurns.length, 0, 'the dialogue queue must drain completely');
        assert.strictEqual(botSession.brainInFlight, false, 'the bot must leave the in-flight state');
        const failedRoot = observations.find((entry) =>
            entry.name === 'hot-bot.dialogue' && entry.metadata?.providerOutcome === 'queued_context_error'
        );
        assert(failedRoot, 'the failed queued turn must create its own Langfuse root');
        assert(observations.some((entry) =>
            entry.name === 'bot.reply.deliver' && entry.metadata?.providerOutcome === 'queued_context_error'
        ), 'the queued fallback delivery must be traced');
        assert(observations.some((entry) =>
            entry.name === 'bot.conversation.persist' && entry.metadata?.providerOutcome === 'queued_context_error'
        ), 'the queued fallback persistence must be traced');
    } finally {
        releaseFirst?.();
        options.default.OpenRouter = originalConfig;
        World.user = originalWorldUser;
        World.npc = originalWorldNpc;
        World.fetchVisibleUsers = originalFetchVisibleUsers;
        BotContextAssembler.assemble = originalAssemble;
        BotConversationService.contextFor = originalContextFor;
        BotAI.getStatus = originalStatus;
        BotManager.botTell = originalBotTell;
        LangfuseTracing.withObservation = originalWithObservation;
        LangfuseTracing.withRootObservation = originalWithRootObservation;
        BotInferenceBudget.reset();
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.resetTransport();
    }

    console.log('Hot bot queued failure trace checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
