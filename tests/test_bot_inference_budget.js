const assert = require('assert');

require('../src/Global');

const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');

function session(id) {
    return { actor: { fetchId: () => id } };
}

const originalConfig = options.default.OpenRouter;
const bot = session(2000201);

try {
    options.default.OpenRouter = {
        ...originalConfig,
        hotBotBudgetEnabled: true,
        hotBotMaxRequestsPerMinute: 2,
        hotBotPromptTokenBudgetPerMinute: 300,
        hotBotCompletionTokenBudgetPerMinute: 100,
        hotBotGlobalMaxInFlight: 8,
        hotBotGlobalMaxRequestsPerMinute: 20,
        hotBotGlobalPromptTokenBudgetPerMinute: 5000,
        hotBotGlobalCompletionTokenBudgetPerMinute: 5000,
        maxTokens: 40
    };
    BotInferenceBudget.reset();

    const first = BotInferenceBudget.reserve(bot, {
        event: 'player_chat',
        estimatedPromptTokens: 40,
        maxCompletionTokens: 40,
        now: 1000
    });
    assert.strictEqual(first.ok, true, 'the first hot decision should reserve within budget');
    BotInferenceBudget.settle(first.reservation, { promptTokens: 20, completionTokens: 10, cost: 0.001 });

    const second = BotInferenceBudget.reserve(bot, {
        event: 'player_chat',
        estimatedPromptTokens: 260,
        maxCompletionTokens: 40,
        now: 2000
    });
    assert.strictEqual(second.ok, true, 'the remaining prompt budget should admit a second decision');
    const mid = BotInferenceBudget.status(bot, 2000);
    assert.strictEqual(mid.requests, 2);
    assert.strictEqual(mid.promptTokens, 280, 'settlement must replace reservation with actual prompt usage');
    assert.strictEqual(mid.completionTokens, 50);
    assert.strictEqual(mid.remainingRequests, 0);

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
        now: 3000
    });
    assert.strictEqual(requestDenied.ok, false);
    assert.strictEqual(requestDenied.reason, 'inference_budget_requests');
    assert(requestDenied.retryAfterMs > 0, 'a budget rejection should tell the caller when to retry');

    BotInferenceBudget.settle(second.reservation, { promptTokens: 10, completionTokens: 5 });
    options.default.OpenRouter.hotBotMaxRequestsPerMinute = 10;
    const promptDenied = BotInferenceBudget.reserve(bot, {
        estimatedPromptTokens: 295,
        maxCompletionTokens: 1,
        now: 4000
    });
    assert.strictEqual(promptDenied.ok, false, 'prompt reservation should be bounded independently');
    assert.strictEqual(promptDenied.reason, 'inference_budget_prompt_tokens');

    const afterWindow = BotInferenceBudget.reserve(bot, {
        estimatedPromptTokens: 100,
        maxCompletionTokens: 20,
        now: 62001
    });
    assert.strictEqual(afterWindow.ok, true, 'entries should expire from the sliding window');

    BotInferenceBudget.reset();
    options.default.OpenRouter.hotBotGlobalMaxInFlight = 1;
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

    options.default.OpenRouter.hotBotGlobalMaxRequestsPerMinute = 1;
    BotInferenceBudget.reset();
    const globalRequest = BotInferenceBudget.reserve(session(2000204), {
        event: 'state_change', estimatedPromptTokens: 10, maxCompletionTokens: 10, now: 2000
    });
    assert.strictEqual(globalRequest.ok, true);
    BotInferenceBudget.settle(globalRequest.reservation, { promptTokens: 5, completionTokens: 5 });
    const globalRequestDenied = BotInferenceBudget.reserve(session(2000205), {
        event: 'state_change', estimatedPromptTokens: 10, maxCompletionTokens: 10, now: 2001
    });
    assert.strictEqual(globalRequestDenied.ok, false);
    assert.strictEqual(globalRequestDenied.reason, 'inference_budget_global_requests');

    options.default.OpenRouter.hotBotBudgetEnabled = false;
    BotInferenceBudget.reset();
    const bypassed = BotInferenceBudget.reserve(bot, { estimatedPromptTokens: 999999, maxCompletionTokens: 999999 });
    assert.strictEqual(bypassed.ok, true);
    assert.strictEqual(bypassed.bypassed, true, 'the explicit server disable should bypass admission without fake usage');

    assert.strictEqual(BotInferenceBudget.reserve({ actor: null }).reason, 'missing_bot');
    console.log('Bot inference budget checks passed');
} finally {
    options.default.OpenRouter = originalConfig;
    BotInferenceBudget.reset();
}
