const assert = require('assert');

require('../src/Global');

const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
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
        fetchDestId: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false
    };
}

function response(content, usage) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            choices: [{ message: { content } }],
            usage
        })
    };
}

async function main() {
    const originalConfig = options.default.OpenRouter;
    const originalWorldUser = World.user;
    const originalFetchVisibleUsers = World.fetchVisibleUsers;
    const originalCompactStatus = BotBrainContext.compactStatus;
    const requests = [];

    try {
        options.default.OpenRouter = {
            ...originalConfig,
            enabled: true,
            apiKey: 'hot-schema-repair-test-key',
            model: 'test/hot-schema-repair',
            hotBotBudgetEnabled: false,
            chatCooldownMs: 0
        };

        const playerSession = {
            accountId: 'player_hot_schema_repair',
            actor: actor(9301, 'SchemaPlayer')
        };
        const botSession = {
            accountId: 'bot_hot_schema_repair',
            actor: actor(9302, 'SchemaBot', 100),
            plan: 'merchant'
        };
        World.user = { sessions: [playerSession, botSession] };
        World.fetchVisibleUsers = () => [playerSession];
        BotBrainContext.compactStatus = (_session, status) => status;
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.setTransport(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            if (requests.length === 1) {
                return response('{"action":', { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 });
            }
            return response(JSON.stringify({
                action: 'none',
                reply: 'Recovered response.',
                targetPlayerName: '',
                spotId: '',
                buffType: '',
                reason: 'schema_repair',
                confidence: 0.9
            }), { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 });
        });

        const started = BotBrain.maybeThink(
            botSession,
            'player_chat',
            { available: true, mode: 'merchant', level: 20, name: 'SchemaBot' },
            'Please answer even when the first JSON is truncated.',
            {
                playerSession,
                conversationTurn: { turnId: 'hot-schema-repair-turn', channel: 'client_tell' },
                requestId: 'hot-schema-repair-turn'
            }
        );
        assert.strictEqual(started, true);

        for (let index = 0; index < 40 && requests.length < 2; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        assert.strictEqual(requests.length, 2, 'hot dialogue must repair one malformed structured response');
        assert.strictEqual(requests[0].max_completion_tokens, undefined);
        assert.strictEqual(requests[1].max_completion_tokens, 32768);
        assert.deepStrictEqual(requests[0].reasoning, { effort: 'high', exclude: true });
        assert.strictEqual(botSession.brainInFlight, false, 'repaired turn must settle');
        console.log('Hot bot schema repair checks passed');
    } finally {
        options.default.OpenRouter = originalConfig;
        World.user = originalWorldUser;
        World.fetchVisibleUsers = originalFetchVisibleUsers;
        BotBrainContext.compactStatus = originalCompactStatus;
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.resetTransport();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
