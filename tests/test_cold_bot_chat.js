const assert = require('assert');

require('../src/Global');

const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotRemoteChat = invoke('GameServer/Bot/AI/BotRemoteChat');
const BotAfkTradeChat = invoke('GameServer/Bot/Economy/BotAfkTradeChat');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const BotManager = invoke('GameServer/Bot/BotManager');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const MemoryPolicy = invoke('GameServer/Social/InteractionMemoryPolicy');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
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
    const originalAI = options.default.AI;
    const originalWithObservation = LangfuseTracing.withObservation;
    const originalWithRootObservation = LangfuseTracing.withRootObservation;
    const requests = [];
    const observations = [];
    try {
        // Keep this OpenRouter fixture independent from developer-local [AI].
        options.default.AI = undefined;
        options.default.OpenRouter = {
            ...originalConfig,
            enabled: true,
            apiKey: 'cold-chat-test-key',
            model: 'test/cold-chat',
            strictSchema: false,
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
        // The cold coordinator loads this before dispatching a real bot. This
        // isolated chat fixture supplies a known neutral relationship instead.
        Memory.accept(MemoryPolicy.empty(state.characterId));

        const first = BotRemoteChat.replyForState(playerSession, state, 'hello');
        const second = BotRemoteChat.replyForState(playerSession, state, 'where are you?');
        const results = await Promise.all([first, second]);

        assert.deepStrictEqual(results.map((result) => result.reply), ['reply-1', 'reply-2']);
        assert.deepStrictEqual(results.map((result) => result.delivered), [true, true]);
        assert.deepStrictEqual(results.map((result) => result.ok), [true, true],
            'a delivered model reply must report success like the fallback does');
        assert.strictEqual(deliveredPackets.length, 2, 'cold replies should be delivered inside the traced stage');
        assert.strictEqual(requests.length, 2, 'every cold tell must reach the provider without a cooldown drop');
        assert.deepStrictEqual(
            requests[1].messages.slice(2).map(message => message.content),
            ['hello', 'reply-1', 'where are you?']
        );
        assert.strictEqual(requests[0].session_id, 'cold-bot:9102:player:9101');
        assert.strictEqual(requests[0].provider?.require_parameters, true);

        state.inventory = { 167: { selfId: 167, name: 'Scalpel', amount: 1, equipped: true,
            rank: 'd', slot: 7, kind: 'Weapon.Blunt' } };
        await BotRemoteChat.replyForState(playerSession, state, 'Are you in a clan and what is your gear?');
        const gearContext = JSON.parse(requests.at(-1).messages[1].content).bot;
        assert.strictEqual(gearContext.clan.id, 0);
        assert.strictEqual(gearContext.equipment.rows[0].name, 'Scalpel');
        assert.strictEqual(gearContext.equipment.rows[0].grade, 'd');
        assert(!requests.at(-1).messages[0].content.includes('inventory/skills may be unavailable'));
        await BotRemoteChat.replyForState(playerSession, state, 'Is it D grade?');
        assert.strictEqual(JSON.parse(requests.at(-1).messages[1].content).bot.equipment.rows[0].name, 'Scalpel',
            'real cold requests must refresh authoritative gear on a grade follow-up');

        const originalFindOwnerProjection = AfkTrade.findOwnerProjection;
        const originalShopHandle = BotAfkTradeChat.handle;
        try {
            AfkTrade.findOwnerProjection = (ownerId) => Number(ownerId) === 9103
                ? { session: {}, actor: { fetchPrivateStore: () => ({
                    botOwned: true, storeType: 1, town: 'Giran',
                    items: [{ selfId: 1962, name: 'Karmian Tunic Pattern', count: 2, price: 48750 }]
                }) } } : originalFindOwnerProjection(ownerId);
            BotAfkTradeChat.handle = async (_player, _state, intent) => ({
                handled: true, ok: true, action: intent.action,
                reply: 'Actual listing is 48750 Adena.'
            });
            OpenRouterGateway.setTransport(async (_url, init) => {
                requests.push(JSON.parse(init.body));
                return response({ choices: [{ message: { content: JSON.stringify({
                    action: 'shop_status', reply: 'I changed it to 47000.',
                    reason: 'inspect_listing', confidence: 0.95
                }) } }] });
            });
            const shopState = { ...state, characterId: 9103, name: 'ColdShopBot' };
            Memory.accept(MemoryPolicy.empty(shopState.characterId));
            const shopReply = await BotRemoteChat.replyForState(playerSession, shopState,
                'What can you do about this listing?');
            assert.strictEqual(shopReply.reply, 'Actual listing is 48750 Adena.',
                'shop action must use the server tool result, never the model claim');
            const shopRequest = requests.at(-1);
            assert.strictEqual(JSON.parse(shopRequest.messages[1].content).shop.items[0].selfId, 1962);
            assert(shopRequest.response_format?.json_schema?.schema?.properties?.action?.enum?.includes('shop_offer')
                || JSON.stringify(shopRequest).includes('shop_offer'),
            'shop actions must be available in the cold chat schema');
        } finally {
            AfkTrade.findOwnerProjection = originalFindOwnerProjection;
            BotAfkTradeChat.handle = originalShopHandle;
        }

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
            assert.strictEqual(observations.filter((name) => name === stage).length, 8, `${stage} should be emitted for every cold reply`);
        }
        for (const stage of ['openrouter.generation', 'bot.schema.validate']) {
            assert.strictEqual(observations.filter((name) => name === stage).length, 8, `${stage} should be emitted for every admitted cold request`);
        }
        assert.strictEqual(observations.filter((name) => name === 'bot.tool.come_to_player').length, 1, 'come_to_player should have one tool observation');

        // The real tell path sends ActionFailed when a delivered reply lacks ok.
        const originalFindByName = LifeState.findByName;
        const originalFindSession = BotManager.findSessionByName;
        try {
            BotManager.findSessionByName = () => null;
            LifeState.findByName = async () => state;
            OpenRouterGateway.setTransport(async (_url, init) => {
                requests.push(JSON.parse(init.body));
                return response({ choices: [{ message: { content: JSON.stringify({
                    action: 'say', reply: 'world-reply', reason: 'test_reply', confidence: 0.95
                }) } }] });
            });
            const packetsBefore = deliveredPackets.length;
            const sent = await World.messageBotByName(playerSession, playerSession.actor, 'ColdChatBot', 'hi again');
            assert.strictEqual(sent, true, 'a delivered model reply is a successful tell');
            assert.strictEqual(deliveredPackets.length - packetsBefore, 1, 'the reply text is the only packet, no ActionFailed');
        } finally {
            LifeState.findByName = originalFindByName;
            BotManager.findSessionByName = originalFindSession;
        }

        // The player leaves while the bot is being activated: arrival cannot start.
        const originalActivation = PopulationService.requestActivation;
        const originalPlayerOnline = playerSession.actor.fetchIsOnline;
        const lateSession = { accountId: 'bot_cold_chat', actor: actor(9102, 'ColdChatBot', 180) };
        try {
            BotManager.findSessionByName = (name) => String(name).toLowerCase() === 'coldchatbot' ? lateSession : null;
            PopulationService.requestActivation = async () => {
                playerSession.actor.fetchIsOnline = () => false;
                return { ok: true, reason: 'remote_chat_come' };
            };
            OpenRouterGateway.setTransport(async (_url, init) => {
                requests.push(JSON.parse(init.body));
                return response({ choices: [{ message: { content: JSON.stringify({
                    action: 'come_to_player', reply: 'I am coming over.', reason: 'explicit_request', confidence: 0.98
                }) } }] });
            });
            const lateArrival = await BotRemoteChat.replyForState(playerSession, state, 'come to me again');
            assert.strictEqual(lateArrival.actionResult.ok, false, 'arrival that did not start is not a success');
            assert.strictEqual(lateArrival.action, 'say');
            assert.notStrictEqual(lateSession.chatArrivalActive, true);
        } finally {
            playerSession.actor.fetchIsOnline = originalPlayerOnline;
            PopulationService.requestActivation = originalActivation;
            BotManager.findSessionByName = originalFindSession;
        }
        console.log('Cold bot chat checks passed');
    } finally {
        options.default.OpenRouter = originalConfig;
        options.default.AI = originalAI;
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
