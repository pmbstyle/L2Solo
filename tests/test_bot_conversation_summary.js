const assert = require('assert');
require('../src/Global');

const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotConversationSummarizer = invoke('GameServer/Bot/AI/BotConversationSummarizer');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');

async function main() {
    const originalAI = options.default.AI;
    options.default.AI = undefined;
    BotConversationStore.resetMemory();
    BotConversationSummarizer.reset();
    BotInferenceBudget.reset();
    options.default.OpenRouter = {
        enabled: true,
        apiKey: 'test-key',
        model: 'test/summary',
        maxTokens: 220,
        timeoutMs: 500
    };
    OpenRouterGateway.resetCircuit();
    OpenRouterGateway.setTransport(async () => ({
        ok: true,
        status: 200,
        async json() {
            return {
                choices: [{ message: { content: JSON.stringify({
                    summary: 'The player asked for support and prefers concise answers.',
                    openTopics: ['confirm the next support action'],
                    promises: [
                        { turnId: 'turn-4', text: 'reply truthfully after a validated cast' },
                        { turnId: 'turn-5', text: 'do not preserve this plain conversational promise' }
                    ]
                }) } }],
                usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 }
            };
        }
    }));

    try {
        for (let i = 1; i <= 30; i += 1) {
            await BotConversationStore.appendTurn({
                playerId: 10,
                botId: 20,
                turnId: `turn-${i}`,
                role: i % 2 ? 'player' : 'bot',
                channel: 'tell',
                text: i % 2 ? `Please help with support request ${i}.` : `I will check request ${i}.`,
                meta: i === 4
                    ? { action: 'give_resources', serverApplied: true, actionResult: { ok: true, outcome: 'pending' } }
                    : null
            });
        }
        const first = await BotConversationSummarizer.summarize({ playerId: 10, botId: 20, threshold: 24 });
        assert.strictEqual(first.ok, true);
        assert.strictEqual(BotInferenceBudget.status({ actor: { fetchId: () => 20 } }).requests, 1, 'summary inference must consume the bot budget');
        assert.match(first.summary, /Open topics/);
        assert.match(first.summary, /reply truthfully after a validated cast/);
        assert(!first.summary.includes('do not preserve this plain conversational promise'), 'plain model promises must not survive compaction');
        const compacted = await BotConversationStore.context(10, 20, { limit: 20 });
        assert.match(compacted.summary, /concise answers/);
        assert.strictEqual(compacted.recentTurns.length, 8);

        const stale = await BotConversationStore.setSummary({
            playerId: 10,
            botId: 20,
            summary: 'stale overwrite',
            summaryThroughId: first.summaryThroughId,
            expectedVersion: 0
        });
        assert.strictEqual(stale.ok, false);
        assert.strictEqual(stale.reason, 'version_conflict');

        // A reasoning-heavy summary may hit the compact first budget. The
        // gateway must use its schema recovery attempt instead of entering
        // backoff immediately.
        BotConversationStore.resetMemory();
        BotConversationSummarizer.reset();
        OpenRouterGateway.resetCircuit();
        for (let i = 1; i <= 30; i += 1) {
            await BotConversationStore.appendTurn({
                playerId: 50,
                botId: 60,
                turnId: `truncated-${i}`,
                role: i % 2 ? 'player' : 'bot',
                channel: 'tell',
                text: `Summary recovery message ${i}`
            });
        }
        const recoveryBodies = [];
        let recoveryCalls = 0;
        OpenRouterGateway.setTransport(async (_url, init) => {
            recoveryCalls += 1;
            recoveryBodies.push(JSON.parse(init.body));
            if (recoveryCalls === 1) {
                return {
                    ok: true,
                    status: 200,
                    async json() {
                        return {
                            choices: [{ finish_reason: 'length', message: { content: '{"summary":' } }],
                            usage: { prompt_tokens: 80, completion_tokens: 220, total_tokens: 300 }
                        };
                    }
                };
            }
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        choices: [{ message: { content: JSON.stringify({
                            summary: 'Recovered compact summary.',
                            openTopics: [],
                            promises: []
                        }) } }],
                        usage: { prompt_tokens: 90, completion_tokens: 40, total_tokens: 130 }
                    };
                }
            };
        });
        const recovered = await BotConversationSummarizer.summarize({ playerId: 50, botId: 60, threshold: 24 });
        assert.strictEqual(recovered.ok, true, 'summary truncation should be recovered once');
        assert.strictEqual(recoveryCalls, 2);
        assert.strictEqual(recoveryBodies[0].max_completion_tokens, 220);
        assert.strictEqual(recoveryBodies[1].max_completion_tokens, 2048);

        // A provider failure must leave the uncompacted messages usable.
        BotConversationStore.resetMemory();
        OpenRouterGateway.resetCircuit();
        for (let i = 1; i <= 30; i += 1) {
            await BotConversationStore.appendTurn({
                playerId: 30,
                botId: 40,
                turnId: `failed-${i}`,
                role: i % 2 ? 'player' : 'bot',
                channel: 'tell',
                text: `Uncompacted message ${i}`
            });
        }
        let failedRequests = 0;
        OpenRouterGateway.setTransport(async () => {
            failedRequests += 1;
            return { ok: false, status: 503, async json() { return {}; } };
        });
        const failed = await BotConversationSummarizer.summarize({ playerId: 30, botId: 40, threshold: 24 });
        assert.strictEqual(failed.ok, false);
        const backedOff = await BotConversationSummarizer.summarize({ playerId: 30, botId: 40, threshold: 24 });
        assert.strictEqual(backedOff.reason, 'summary_backoff', 'a provider failure must not retry on every chat turn');
        assert.strictEqual(failedRequests, 1, 'summary backoff must suppress duplicate provider calls');
        const raw = await BotConversationStore.context(30, 40, { limit: 40 });
        assert.strictEqual(raw.summary, null);
        assert.strictEqual(raw.recentTurns.length, 30);
        console.log('Bot conversation summary checks passed');
    } finally {
        OpenRouterGateway.resetTransport();
        OpenRouterGateway.resetCircuit();
        BotInferenceBudget.reset();
        options.default.OpenRouter = {};
        options.default.AI = originalAI;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
