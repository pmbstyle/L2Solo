const assert = require('assert');

require('../src/Global');

const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const World = invoke('GameServer/World/World');

function actor(id, name, x = 0) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLevel: () => 10,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchKarma: () => 0,
        fetchDestId: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false
    };
}

function response(body) {
    return { ok: true, status: 200, json: async () => body };
}

async function main() {
    const originalConfig = options.default.OpenRouter;
    const originalWorldUser = World.user;
    const originalCompactStatus = BotBrainContext.compactStatus;
    const originalWithObservation = LangfuseTracing.withObservation;
    const originalWithRootObservation = LangfuseTracing.withRootObservation;
    let firstRequestRelease;
    const requests = [];
    const observations = [];

    try {
        options.default.OpenRouter = {
            ...originalConfig,
            enabled: true,
            apiKey: 'conversation-test-key',
            model: 'test/conversation',
            negotiationEnabled: true,
            maxConcurrentRequests: 32
        };
        const playerSession = { accountId: 'player_flow', actor: actor(301, 'FlowPlayer') };
        const botSession = {
            accountId: 'bot_flow',
            actor: actor(302, 'FlowBot', 100),
            plan: 'merchant'
        };
        World.user = { sessions: [playerSession, botSession] };
        BotBrainContext.compactStatus = (_session, status) => status;
        LangfuseTracing.withObservation = (name, input, metadata, work) => {
            observations.push(name);
            return Promise.resolve(work(null));
        };
        LangfuseTracing.withRootObservation = (name, input, metadata, work) => {
            observations.push(name);
            return Promise.resolve(work(null));
        };
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.setTransport(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            if (requests.length === 1) {
                await new Promise((resolve) => { firstRequestRelease = resolve; });
            }
            return response({
                choices: [{ message: { content: JSON.stringify({
                    action: 'none',
                    reply: '',
                    targetPlayerName: '',
                    spotId: '',
                    buffType: '',
                    reason: 'queued_test',
                    confidence: 0.9
                }) } }]
            });
        });

        const firstContext = {
            summary: null,
            recentTurns: [{ turnId: 'flow-1', role: 'player', channel: 'local_chat', text: 'first', createdAt: 1 }],
            version: 0
        };
        const secondContext = {
            summary: null,
            recentTurns: [
                ...firstContext.recentTurns,
                { turnId: 'flow-2', role: 'player', channel: 'local_chat', text: 'second', createdAt: 2 }
            ],
            version: 0
        };
        const firstTurn = { turnId: 'flow-1', channel: 'local_chat' };
        const secondTurn = { turnId: 'flow-2', channel: 'local_chat' };
        const thirdContext = {
            ...secondContext,
            recentTurns: [...secondContext.recentTurns, { turnId: 'flow-3', role: 'player', channel: 'local_chat', text: 'third', createdAt: 3 }]
        };
        const thirdTurn = { turnId: 'flow-3', channel: 'local_chat' };
        const firstStarted = BotBrain.maybeThink(
            botSession,
            'player_chat',
            { available: true, mode: 'resting', level: 10, name: 'FlowBot' },
            'first',
            { playerSession, conversation: firstContext, conversationTurn: firstTurn, requestId: 'flow-1' }
        );
        assert.strictEqual(firstStarted, true);

        const secondStarted = BotBrain.maybeThink(
            botSession,
            'player_chat',
            { available: true, mode: 'resting', level: 10, name: 'FlowBot' },
            'second',
            { playerSession, conversation: secondContext, conversationTurn: secondTurn, requestId: 'flow-2' }
        );
        assert.strictEqual(secondStarted, true, 'one additional dialogue turn should queue while the first is in flight');
        assert.strictEqual(botSession.pendingBrainTurn.text, 'second');
        const thirdStarted = BotBrain.maybeThink(
            botSession,
            'player_chat',
            { available: true, mode: 'merchant', level: 10, name: 'FlowBot' },
            'third',
            { playerSession, conversation: thirdContext, conversationTurn: thirdTurn, requestId: 'flow-3' }
        );
        assert.strictEqual(thirdStarted, true);
        assert.strictEqual(botSession.pendingBrainTurns.length, 2, 'queued turns should be retained in FIFO order');

        for (let attempt = 0; attempt < 20 && typeof firstRequestRelease !== 'function'; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.strictEqual(typeof firstRequestRelease, 'function', 'the first provider request should start');
        firstRequestRelease();
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.strictEqual(requests.length, 3, 'all queued turns should be submitted after the first turn completes');
        const secondPayload = JSON.parse(requests[1].messages[1].content);
        assert.deepStrictEqual(
            secondPayload.conversation.recentTurns.map((turn) => turn.text),
            ['first', 'second']
        );
        for (const stage of ['hot-bot.dialogue', 'bot.context.assemble', 'openrouter.generation', 'bot.schema.validate', 'bot.tool.execute', 'bot.reply.deliver']) {
            assert.strictEqual(observations.filter((name) => name === stage).length, 3, `${stage} should be emitted once per queued turn`);
        }
    } finally {
        options.default.OpenRouter = originalConfig;
        World.user = originalWorldUser;
        BotBrainContext.compactStatus = originalCompactStatus;
        LangfuseTracing.withObservation = originalWithObservation;
        LangfuseTracing.withRootObservation = originalWithRootObservation;
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.resetTransport();
    }

    console.log('Hot bot conversation flow checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
