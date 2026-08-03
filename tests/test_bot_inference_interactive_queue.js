const assert = require('assert');

require('../src/Global');

const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');

function session(id) {
    return { actor: { fetchId: () => id } };
}

function tick() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function main() {
    const originalConfig = options.default.OpenRouter;
    try {
        options.default.OpenRouter = {
            ...originalConfig,
            maxConcurrentRequests: 1
        };
        BotInferenceBudget.reset();

        const first = BotInferenceBudget.reserve(session(9401), {
            event: 'state_change',
            estimatedPromptTokens: 20,
            maxCompletionTokens: 20,
            now: 1000
        });
        assert.strictEqual(first.ok, true);

        const queued = BotInferenceBudget.reserve(session(9402), {
            event: 'player_chat',
            bypass: true,
            estimatedPromptTokens: 9000,
            maxCompletionTokens: 0,
            now: 1001
        });
        assert.strictEqual(queued.ok, true, 'interactive admission must queue behind concurrency');
        assert.strictEqual(queued.queued, true);
        assert.strictEqual(BotInferenceBudget.globalStatus(1001).queuedRequests, 1);

        let resolved = false;
        queued.ready.then(() => { resolved = true; });
        await tick();
        assert.strictEqual(resolved, false, 'queued interactive admission must wait for a global slot');

        BotInferenceBudget.settle(first.reservation, { promptTokens: 20, completionTokens: 20 });
        const granted = await queued.ready;
        assert.strictEqual(granted.ok, true);
        assert(granted.reservation, 'queued admission must receive a real reservation');
        assert.strictEqual(BotInferenceBudget.globalStatus(1001).queuedRequests, 0);
        BotInferenceBudget.settle(granted.reservation, { promptTokens: 9000, completionTokens: 9000 });
        assert.strictEqual(BotInferenceBudget.globalStatus(1001).inFlight, 0);
        console.log('Interactive inference queue checks passed');
    } finally {
        options.default.OpenRouter = originalConfig;
        BotInferenceBudget.reset();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
