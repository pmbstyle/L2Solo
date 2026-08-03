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
    const requests = [];
    const botSession = { accountId: 'bot_state_change', actor: actor(2000301, 'StateBot'), plan: 'resting' };
    const playerSession = { accountId: 'player_state_change', actor: actor(2000302, 'NearbyPlayer', 100) };

    try {
        options.default.OpenRouter = {
            ...originalConfig,
            enabled: true,
            apiKey: 'state-change-test-key',
            model: 'test/state-change',
            maxConcurrentRequests: 5
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
        assert.strictEqual(started, false, 'background state changes must stay on the deterministic bot brain');
        assert.strictEqual(requests.length, 0, 'background state changes must not consume provider tokens');

        options.default.OpenRouter.enabled = false;
        assert.strictEqual(
            BotBrain.maybeThink(botSession, 'player_chat', { available: true }, 'disabled probe', { playerSession }),
            false,
            'disabled OpenRouter must keep chat routing inert'
        );
        options.default.OpenRouter.enabled = true;

        // An explicit tell is still an interactive LLM turn while the hot bot
        // is dead or in a transient deterministic plan.
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
        for (let attempt = 0; attempt < 50 && botSession.brainInFlight; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.strictEqual(requests.length, beforeChat + 1);
        const payload = JSON.parse(requests[0].messages[1].content);
        assert.strictEqual(payload.event, 'player_chat');
        let decisionEvent = null;
        for (let attempt = 0; attempt < 50 && !decisionEvent; attempt += 1) {
            const recent = await BotEventJournal.recent({
                botId: botSession.actor.fetchId(),
                playerId: playerSession.actor.fetchId(),
                limit: 10
            });
            decisionEvent = recent.find((entry) => entry.eventType === 'llm_decision') || null;
            if (!decisionEvent) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(decisionEvent, 'interactive decisions should remain visible in the bounded activity journal');
        assert.strictEqual(decisionEvent.meta.event, 'player_chat');
        assert(!JSON.stringify(decisionEvent).includes('Are you alive?'), 'raw prompt text must not enter the journal');
        console.log('Bot brain communication-only routing checks passed');
    } finally {
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
