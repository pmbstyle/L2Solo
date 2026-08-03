const assert = require('assert');

require('../src/Global');

const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotRemoteChat = invoke('GameServer/Bot/AI/BotRemoteChat');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const BotManager = invoke('GameServer/Bot/BotManager');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

function actor(id, name, x = 0) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLevel: () => 20,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
        fetchKarma: () => 0,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true
    };
}

function response(body) {
    return { ok: true, status: 200, json: async () => body };
}

async function main() {
    const originalConfig = options.default.OpenRouter;
    const originalWithObservation = LangfuseTracing.withObservation;
    const originalWithRootObservation = LangfuseTracing.withRootObservation;
    const requests = [];
    const observations = [];
    try {
        options.default.OpenRouter = {
            ...originalConfig,
            enabled: true,
            apiKey: 'cold-chat-test-key',
            model: 'test/cold-chat',
            maxConcurrentRequests: 1
        };
        BotConversationStore.resetMemory();
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
            return response({
                choices: [{ message: { content: JSON.stringify({
                    action: 'say',
                    reply: `reply-${requests.length}`,
                    reason: 'test_reply',
                    confidence: 0.95
                }) } }]
            });
        });

        const deliveredPackets = [];
        const playerSession = {
            accountId: 'player_cold',
            actor: actor(9101, 'ColdPlayer', 100),
            dataSendToMe(packet) { deliveredPackets.push(packet); }
        };
        const state = {
            characterId: 9102,
            accountName: 'bot_cold_chat',
            name: 'ColdChatBot',
            level: 20,
            phase: 'cold',
            activity: 'hunting',
            homeRegion: 'Talking Island',
            currentRegion: 'Talking Island',
            loc: { locX: 1000, locY: 1000, locZ: 0 },
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
            stats: { generatedIndex: 19 }
        };

        const first = BotRemoteChat.replyForState(playerSession, state, 'hello');
        const second = BotRemoteChat.replyForState(playerSession, state, 'where are you?');
        const results = await Promise.all([first, second]);

        assert.deepStrictEqual(results.map((result) => result.reply), ['reply-1', 'reply-2']);
        assert.deepStrictEqual(results.map((result) => result.delivered), [true, true]);
        assert.strictEqual(deliveredPackets.length, 2, 'cold replies should be delivered inside the traced stage');
        assert.strictEqual(requests.length, 2, 'every cold tell must reach the provider without a cooldown drop');
        const secondPayload = JSON.parse(requests[1].messages[1].content);
        assert.deepStrictEqual(
            secondPayload.conversation.recentTurns.map((turn) => turn.text),
            ['hello', 'reply-1', 'where are you?']
        );
        assert.strictEqual(requests[0].session_id, 'cold-bot:9102:player:9101');
        assert.strictEqual(requests[0].provider?.require_parameters, true);

        const originalFindSessionByName = BotManager.findSessionByName;
        const originalRequestActivation = PopulationService.requestActivation;
        const hotSession = { accountId: 'bot_cold_chat', actor: actor(9102, 'ColdChatBot', 180) };
        try {
            BotManager.findSessionByName = (name) => String(name).toLowerCase() === 'coldchatbot' ? hotSession : null;
            PopulationService.requestActivation = async () => ({ ok: true, reason: 'remote_chat_come' });
            OpenRouterGateway.setTransport(async (_url, init) => {
                requests.push(JSON.parse(init.body));
                return response({
                    choices: [{ message: { content: JSON.stringify({
                        action: 'come_to_player',
                        reply: 'I am coming over.',
                        reason: 'explicit_request',
                        confidence: 0.98
                    }) } }]
                });
            });
            const arrival = await BotRemoteChat.replyForState(playerSession, state, 'come to me');
            assert.strictEqual(arrival.action, 'come_to_player');
            assert.strictEqual(arrival.actionResult.ok, true);
            assert.strictEqual(hotSession.chatArrivalActive, true, 'confirmed cold arrival should enter deterministic hold state');
        } finally {
            BotManager.findSessionByName = originalFindSessionByName;
            PopulationService.requestActivation = originalRequestActivation;
        }

        BotInferenceBudget.reset();
        options.default.OpenRouter.maxConcurrentRequests = 1;
        const beforeAdmissionRequests = requests.length;
        let releaseAdmissionRequest;
        OpenRouterGateway.setTransport(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            if (requests.length === beforeAdmissionRequests + 1) {
                await new Promise((resolve) => { releaseAdmissionRequest = resolve; });
            }
            return response({
                choices: [{ message: { content: JSON.stringify({
                    action: 'say', reply: 'admission-reply', reason: 'test_reply', confidence: 0.95
                }) } }]
            });
        });
        const blockedState = { ...state, characterId: 9111, accountName: 'blocked_cold_chat', name: 'BlockedColdChat' };
        const firstAdmission = BotRemoteChat.replyForState(playerSession, blockedState, 'first admission');
        for (let attempt = 0; attempt < 20 && typeof releaseAdmissionRequest !== 'function'; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.strictEqual(typeof releaseAdmissionRequest, 'function', 'the first cold request should occupy the global slot');
        const secondAdmissionPromise = BotRemoteChat.replyForState(
            playerSession,
            { ...state, characterId: 9112, accountName: 'rejected_cold_chat', name: 'RejectedColdChat' },
            'second admission'
        );
        assert.strictEqual(requests.length, beforeAdmissionRequests + 1, 'global admission must queue the second cold request before OpenRouter');
        releaseAdmissionRequest();
        const [firstAdmissionResult, secondAdmission] = await Promise.all([firstAdmission, secondAdmissionPromise]);
        assert.strictEqual(firstAdmissionResult.delivered, true);
        assert.strictEqual(secondAdmission.reason, 'test_reply');
        assert.strictEqual(secondAdmission.delivered, true);
        assert.strictEqual(requests.length, beforeAdmissionRequests + 2, 'queued cold chat must reach OpenRouter after the slot is released');
        for (const stage of ['cold-bot.dialogue', 'bot.context.assemble', 'bot.reply.deliver']) {
            assert.strictEqual(observations.filter((name) => name === stage).length, 5, `${stage} should be emitted for every cold reply`);
        }
        for (const stage of ['openrouter.generation', 'bot.schema.validate']) {
            assert.strictEqual(observations.filter((name) => name === stage).length, 5, `${stage} should be emitted for every admitted cold request`);
        }
        assert.strictEqual(observations.filter((name) => name === 'bot.tool.come_to_player').length, 1, 'come_to_player should have one tool observation');
        console.log('Cold bot chat checks passed');
    } finally {
        options.default.OpenRouter = originalConfig;
        LangfuseTracing.withObservation = originalWithObservation;
        LangfuseTracing.withRootObservation = originalWithRootObservation;
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.resetTransport();
        BotConversationStore.resetMemory();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
