const assert = require('assert');
require('../src/Global');

const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotConversationSummarizer = invoke('GameServer/Bot/AI/BotConversationSummarizer');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');

async function main() {
    BotConversationStore.resetMemory();
    BotConversationSummarizer.reset();
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
                    promises: ['reply truthfully after a validated cast']
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
                text: i % 2 ? `Please help with support request ${i}.` : `I will check request ${i}.`
            });
        }
        const first = await BotConversationSummarizer.summarize({ playerId: 10, botId: 20, threshold: 24 });
        assert.strictEqual(first.ok, true);
        assert.match(first.summary, /Open topics/);
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
        OpenRouterGateway.setTransport(async () => ({ ok: false, status: 503, async json() { return {}; } }));
        const failed = await BotConversationSummarizer.summarize({ playerId: 30, botId: 40, threshold: 24 });
        assert.strictEqual(failed.ok, false);
        const raw = await BotConversationStore.context(30, 40, { limit: 40 });
        assert.strictEqual(raw.summary, null);
        assert.strictEqual(raw.recentTurns.length, 30);
        console.log('Bot conversation summary checks passed');
    } finally {
        OpenRouterGateway.resetTransport();
        OpenRouterGateway.resetCircuit();
        options.default.OpenRouter = {};
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
