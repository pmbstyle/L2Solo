const assert = require('assert');

require('../src/Global');

const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
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

function response(body) {
    return { ok: true, status: 200, json: async () => body };
}

async function main() {
    const originalConfig = options.default.OpenRouter;
    const originalWorldUser = World.user;
    const originalFetchVisibleUsers = World.fetchVisibleUsers;
    const originalRandom = Math.random;
    const requests = [];
    const botSession = { accountId: 'bot_state_change', actor: actor(2000301, 'StateBot'), plan: 'resting' };
    const playerSession = { accountId: 'player_state_change', actor: actor(2000302, 'NearbyPlayer', 100) };

    try {
        options.default.OpenRouter = {
            ...originalConfig,
            enabled: true,
            apiKey: 'state-change-test-key',
            model: 'test/state-change',
            cooldownMs: 0,
            chatCooldownMs: 0,
            backgroundInferenceEnabled: true,
            hotBotMaxRequestsPerMinute: 5,
            hotBotPromptTokenBudgetPerMinute: 12000,
            hotBotCompletionTokenBudgetPerMinute: 2400
        };
        World.user = { sessions: [playerSession, botSession] };
        World.fetchVisibleUsers = () => [playerSession];
        BotInferenceBudget.reset();
        BotEventJournal.resetMemory();
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.setTransport(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            return response({
                choices: [{ message: { content: JSON.stringify({
                    action: 'none',
                    reply: '',
                    targetPlayerName: '',
                    spotId: '',
                    buffType: '',
                    reason: 'state_change_probe',
                    confidence: 0.9
                }) } }]
            });
        });

        Math.random = () => 0.01;
        const started = BotBrain.maybeThink(botSession, 'state_change', {
            available: true,
            name: 'StateBot',
            mode: 'resting',
            intent: 'recover',
            level: 20,
            vitals: { hpPct: 1, mpPct: 1 },
            blockers: [],
            nearby: {},
            target: null,
            party: null,
            spot: null,
            ambient: { mood: 'sociable', intent: 'seek_company', scene: null },
            trade: null,
            persona: null,
            social: null
        }, 'High-level state changed: test');
        assert.strictEqual(started, true, 'a meaningful state-change event should enter the bounded brain path');

        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.strictEqual(requests.length, 1, 'state-change routing should produce one provider request');
        const payload = JSON.parse(requests[0].messages[1].content);
        assert.strictEqual(payload.event, 'state_change');
        assert.strictEqual(BotInferenceBudget.status(botSession).requests, 1);
        const recent = await BotEventJournal.recent({ botId: botSession.actor.fetchId(), limit: 10 });
        const decisionEvent = recent.find((event) => event.eventType === 'llm_decision');
        assert(decisionEvent, 'provider decisions should be available in the bounded activity journal');
        assert.strictEqual(decisionEvent.meta.event, 'state_change');
        assert.strictEqual(decisionEvent.meta.action, 'none');
        assert(!JSON.stringify(decisionEvent).includes('High-level state changed: test'), 'raw prompt text must not enter the journal');

        options.default.OpenRouter.enabled = false;
        assert.strictEqual(
            BotBrain.maybeThink(botSession, 'state_change', { available: true }, 'disabled probe'),
            false,
            'disabled OpenRouter must keep state-change routing inert'
        );
        options.default.OpenRouter.enabled = true;
        options.default.OpenRouter.backgroundInferenceEnabled = false;
        assert.strictEqual(
            BotBrain.maybeThink(botSession, 'state_change', { available: true }, 'background-disabled probe'),
            false,
            'background inference must be opt-in even when OpenRouter is enabled'
        );

        // An explicit tell is still an interactive LLM turn while the hot bot
        // is dead or in a transient deterministic plan.
        options.default.OpenRouter.backgroundInferenceEnabled = false;
        botSession.plan = 'fleeing';
        botSession.actor.isDead = () => true;
        const beforeChat = requests.length;
        assert.strictEqual(
            BotBrain.maybeThink(botSession, 'player_chat', {
                available: true,
                mode: 'fleeing',
                level: 20,
                vitals: { hpPct: 0, mpPct: 0 }
            },
            'Are you alive?',
            { playerSession }
            ),
            true,
            'player chat must enter the LLM path even for a dead/transient hot bot'
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.strictEqual(requests.length, beforeChat + 1);
        console.log('Bot brain state-change checks passed');
    } finally {
        Math.random = originalRandom;
        options.default.OpenRouter = originalConfig;
        World.user = originalWorldUser;
        World.fetchVisibleUsers = originalFetchVisibleUsers;
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.resetTransport();
        BotInferenceBudget.reset();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
