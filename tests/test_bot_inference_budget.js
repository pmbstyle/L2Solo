const assert = require('assert');

require('../src/Global');

const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');

function session(id) {
    return { actor: { fetchId: () => id } };
}

const originalConfig = options.default.OpenRouter;
const originalAI = options.default.AI;
const bot = session(2000201);

try {
    // Keep this OpenRouter budget fixture independent from developer-local [AI].
    options.default.AI = undefined;
    options.default.OpenRouter = {
        ...originalConfig,
        maxConcurrentRequests: 8
    };
    BotInferenceBudget.reset();

    const first = BotInferenceBudget.reserve(bot, {
        event: 'player_chat',
        estimatedPromptTokens: 40,
        maxCompletionTokens: 40,
        maxRequests: 2,
        promptBudget: 300,
        completionBudget: 100,
        now: 1000
    });
    assert.strictEqual(first.ok, true, 'the first hot decision should reserve within budget');
    BotInferenceBudget.settle(first.reservation, { promptTokens: 20, completionTokens: 10, cost: 0.001 });

    const second = BotInferenceBudget.reserve(bot, {
        event: 'player_chat',
        estimatedPromptTokens: 260,
        maxCompletionTokens: 40,
        maxRequests: 2,
        promptBudget: 300,
        completionBudget: 100,
        now: 2000
    });
    assert.strictEqual(second.ok, true, 'the remaining prompt budget should admit a second decision');
    const mid = BotInferenceBudget.status(bot, 2000);
    assert.strictEqual(mid.requests, 2);
    assert.strictEqual(mid.promptTokens, 280, 'settlement must replace reservation with actual prompt usage');
    assert.strictEqual(mid.completionTokens, 50);

    const mandatoryChat = BotInferenceBudget.reserve(bot, {
        event: 'player_chat',
        bypass: true,
        estimatedPromptTokens: 999,
        maxCompletionTokens: 999,
        now: 3000
    });
    assert.strictEqual(mandatoryChat.ok, true, 'explicit player chat must remain admissible over the soft quota');
    assert.strictEqual(mandatoryChat.bypassed, true);
    BotInferenceBudget.settle(mandatoryChat.reservation, { promptTokens: 30, completionTokens: 12 });
    assert.strictEqual(BotInferenceBudget.status(bot, 3000).bypassedRequests, 1);

    const requestDenied = BotInferenceBudget.reserve(bot, {
        estimatedPromptTokens: 1,
        maxCompletionTokens: 1,
        maxRequests: 2,
        promptBudget: 300,
        completionBudget: 100,
        now: 3000
    });
    assert.strictEqual(requestDenied.ok, false);
    assert.strictEqual(requestDenied.reason, 'inference_budget_requests');
    assert(requestDenied.retryAfterMs > 0, 'a budget rejection should tell the caller when to retry');

    BotInferenceBudget.settle(second.reservation, { promptTokens: 10, completionTokens: 5 });
    const promptDenied = BotInferenceBudget.reserve(bot, {
        estimatedPromptTokens: 295,
        maxCompletionTokens: 1,
        maxRequests: 10,
        promptBudget: 300,
        completionBudget: 100,
        now: 4000
    });
    assert.strictEqual(promptDenied.ok, false, 'prompt reservation should be bounded independently');
    assert.strictEqual(promptDenied.reason, 'inference_budget_prompt_tokens');

    const afterWindow = BotInferenceBudget.reserve(bot, {
        estimatedPromptTokens: 100,
        maxCompletionTokens: 20,
        maxRequests: 2,
        promptBudget: 300,
        completionBudget: 100,
        now: 62001
    });
    assert.strictEqual(afterWindow.ok, true, 'entries should expire from the sliding window');

    BotInferenceBudget.reset();
    options.default.OpenRouter.maxConcurrentRequests = 1;
    const globalFirst = BotInferenceBudget.reserve(session(2000202), {
        event: 'state_change', estimatedPromptTokens: 10, maxCompletionTokens: 10, now: 1000
    });
    assert.strictEqual(globalFirst.ok, true);
    assert.strictEqual(BotInferenceBudget.globalStatus(1000).inFlight, 1);
    const globalConcurrent = BotInferenceBudget.reserve(session(2000203), {
        event: 'state_change', estimatedPromptTokens: 10, maxCompletionTokens: 10, now: 1001
    });
    assert.strictEqual(globalConcurrent.ok, false);
    assert.strictEqual(globalConcurrent.reason, 'inference_budget_global_concurrency');
    BotInferenceBudget.settle(globalFirst.reservation, { promptTokens: 5, completionTokens: 5 });
    assert.strictEqual(BotInferenceBudget.globalStatus(1001).inFlight, 0);

    BotInferenceBudget.reset();
    options.default.OpenRouter.maxConcurrentRequests = 8;
    const interactive = BotInferenceBudget.reserve(session(2000206), {
        event: 'player_chat',
        bypass: true,
        estimatedPromptTokens: 9999,
        maxCompletionTokens: 0,
        now: 1500
    });
    assert.strictEqual(interactive.ok, true, 'direct chat must bypass global soft quotas');
    BotInferenceBudget.settle(interactive.reservation, {
        promptTokens: 9999,
        completionTokens: 9999
    });
    assert.strictEqual(BotInferenceBudget.globalStatus(1500).promptTokens, 9999);
    assert.strictEqual(
        BotInferenceBudget.globalStatus(1500).remainingPromptTokens,
        300000,
        'interactive usage is observable but excluded from the global soft quota'
    );
    const normalAfterInteractive = BotInferenceBudget.reserve(session(2000207), {
        event: 'state_change',
        estimatedPromptTokens: 1,
        maxCompletionTokens: 1,
        now: 1501
    });
    assert.strictEqual(normalAfterInteractive.ok, true, 'interactive usage must not starve background admission');
    BotInferenceBudget.settle(normalAfterInteractive.reservation, { promptTokens: 1, completionTokens: 1 });

    BotInferenceBudget.reset();
    for (let index = 0; index < 240; index += 1) {
        const globalRequest = BotInferenceBudget.reserve(session(2100000 + index), {
            event: 'conversation_summary', estimatedPromptTokens: 10, maxCompletionTokens: 10, now: 2000 + index
        });
        assert.strictEqual(globalRequest.ok, true);
        BotInferenceBudget.settle(globalRequest.reservation, { promptTokens: 5, completionTokens: 5 });
    }
    const globalRequestDenied = BotInferenceBudget.reserve(session(2000205), {
        event: 'conversation_summary', estimatedPromptTokens: 10, maxCompletionTokens: 10, now: 2241
    });
    assert.strictEqual(globalRequestDenied.ok, false);
    assert.strictEqual(globalRequestDenied.reason, 'inference_budget_global_requests');

    assert.strictEqual(BotInferenceBudget.reserve({ actor: null }).reason, 'missing_bot');
    console.log('Bot inference budget checks passed');
} finally {
    options.default.OpenRouter = originalConfig;
    options.default.AI = originalAI;
    BotInferenceBudget.reset();
}
