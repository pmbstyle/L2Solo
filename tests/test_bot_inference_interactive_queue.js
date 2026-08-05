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

        BotInferenceBudget.reset();
        const abandoned = BotInferenceBudget.reserve(session(9403), {
            event: 'state_change',
            estimatedPromptTokens: 20,
            maxCompletionTokens: 20,
            now: 2000
        });
        const afterAbandoned = BotInferenceBudget.reserve(session(9404), {
            event: 'player_chat',
            bypass: true,
            estimatedPromptTokens: 20,
            maxCompletionTokens: 0,
            now: 2001
        });
        assert.strictEqual(afterAbandoned.queued, true);
        BotInferenceBudget.globalStatus(2000 + BotInferenceBudget.RESERVATION_TTL_MS + 1);
        const afterExpiry = await afterAbandoned.ready;
        assert.strictEqual(afterExpiry.ok, true, 'an expired reservation must release the next interactive waiter');
        assert.strictEqual(abandoned.reservation.expired, true);
        assert.strictEqual(BotInferenceBudget.settle(abandoned.reservation), false, 'late settlement must not release the slot twice');
        assert.strictEqual(BotInferenceBudget.globalStatus().inFlight, 1);
        BotInferenceBudget.settle(afterExpiry.reservation, { promptTokens: 20, completionTokens: 20 });

        BotInferenceBudget.reset();
        const blocker = BotInferenceBudget.reserve(session(9500), {
            event: 'state_change',
            estimatedPromptTokens: 20,
            maxCompletionTokens: 20
        });
        const waiters = [];
        for (let index = 0; index < BotInferenceBudget.MAX_GLOBAL_WAITERS; index += 1) {
            const waiting = BotInferenceBudget.reserve(session(9600 + index), {
                event: 'player_chat',
                bypass: true,
                estimatedPromptTokens: 20,
                maxCompletionTokens: 0
            });
            assert.strictEqual(waiting.queued, true);
            waiters.push(waiting);
        }
        const overflow = BotInferenceBudget.reserve(session(9999), {
            event: 'player_chat',
            bypass: true,
            estimatedPromptTokens: 20,
            maxCompletionTokens: 0
        });
        assert.strictEqual(overflow.ok, false, 'the global interactive queue must have a hard bound');
        assert.strictEqual(overflow.reason, 'inference_budget_queue_full');
        BotInferenceBudget.settle(blocker.reservation, { promptTokens: 20, completionTokens: 20 });
        const firstWaiting = await waiters[0].ready;
        assert.strictEqual(firstWaiting.ok, true);
        BotInferenceBudget.settle(firstWaiting.reservation, { promptTokens: 20, completionTokens: 20 });
        BotInferenceBudget.reset();

        const timeoutBlocker = BotInferenceBudget.reserve(session(9700), {
            event: 'state_change',
            estimatedPromptTokens: 20,
            maxCompletionTokens: 20
        });
        const originalSetTimeout = global.setTimeout;
        global.setTimeout = (callback) => {
            const timer = originalSetTimeout(callback, 0);
            timer.unref = () => timer;
            return timer;
        };
        let timedOut;
        try {
            timedOut = BotInferenceBudget.reserve(session(9701), {
                event: 'player_chat',
                bypass: true,
                estimatedPromptTokens: 20,
                maxCompletionTokens: 0
            });
        } finally {
            global.setTimeout = originalSetTimeout;
        }
        const timeoutResult = await timedOut.ready;
        assert.strictEqual(timeoutResult.ok, false, 'a queued waiter must not remain pending forever');
        assert.strictEqual(timeoutResult.reason, 'inference_budget_queue_timeout');
        BotInferenceBudget.settle(timeoutBlocker.reservation, { promptTokens: 20, completionTokens: 20 });
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
