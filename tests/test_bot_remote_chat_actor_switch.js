const assert = require('assert');

require('../src/Global');

// E266: tells sent by one character must not be answered, acted on or stored
// for the character the player selects next on the same connection.
const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotRemoteChat = invoke('GameServer/Bot/AI/BotRemoteChat');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const MemoryPolicy = invoke('GameServer/Social/InteractionMemoryPolicy');
const Social = invoke('GameServer/Bot/AI/BotSocialMemory');
const Takeover = invoke('GameServer/Bot/AI/PlayerPartyTakeover');

function actor(id, name) {
    return {
        fetchId: () => id, fetchName: () => name, fetchLevel: () => 20,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchKarma: () => 0, fetchLocX: () => 100, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchIsOnline: () => true
    };
}

function response(body) {
    return { ok: true, status: 200, json: async () => body };
}

async function until(check) {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
    assert(check(), 'fixture condition was not reached');
}

async function main() {
    process.exitCode = 1;
    const originalConfig = options.default.OpenRouter;
    const originalAI = options.default.AI;
    const originalWithObservation = LangfuseTracing.withObservation;
    const originalWithRootObservation = LangfuseTracing.withRootObservation;
    const originalSocialLoad = Social.load;
    const originalTakeover = Takeover.request;
    try {
        options.default.AI = undefined;
        options.default.OpenRouter = { ...originalConfig, enabled: true, apiKey: 'switch-test-key',
            model: 'test/actor-switch', maxConcurrentRequests: 2, strictSchema: false };
        BotConversationStore.resetMemory();
        LangfuseTracing.withObservation = (name, input, metadata, work) => Promise.resolve(work(null));
        LangfuseTracing.withRootObservation = (name, input, metadata, work) => Promise.resolve(work(null));
        OpenRouterGateway.resetCircuit();
        const requests = [], releases = [];
        OpenRouterGateway.setTransport((_url, init) => {
            const body = JSON.parse(init.body);
            requests.push(body.messages.at(-1).content);
            const answer = response({ choices: [{ message: { content: JSON.stringify({
                action: 'say', reply: `reply-${requests.length}`, reason: 'test_reply', confidence: 0.95
            }) } }] });
            // Only the first request is held; any later one answers at once.
            if (requests.length > 1) return Promise.resolve(answer);
            return new Promise(resolve => releases.push(() => resolve(answer)));
        });

        const packets = [];
        const first = actor(9201, 'FirstCharacter'), second = actor(9203, 'SecondCharacter');
        const playerSession = { accountId: 'player_switch', actor: first,
            dataSendToMe(packet) { packets.push({ actorId: this.actor.fetchId(), packet }); } };
        const state = { characterId: 9202, accountName: 'bot_switch', name: 'SwitchBot', level: 20,
            phase: 'cold', activity: 'hunting', homeRegion: 'Talking Island', currentRegion: 'Talking Island',
            loc: { locX: 1000, locY: 1000, locZ: 0 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
            stats: { generatedIndex: 21 } };
        Memory.accept(MemoryPolicy.empty(state.characterId));

        const one = BotRemoteChat.replyForState(playerSession, state, 'one');
        const two = BotRemoteChat.replyForState(playerSession, state, 'two');
        await until(() => releases.length === 1);
        playerSession.actor = second;
        releases.shift()();
        const results = await Promise.all([one, two]);

        assert.deepStrictEqual(requests, ['one'], 'a tell queued by the previous character never reaches the provider');
        assert.deepStrictEqual(packets, [], 'the previous character reply is not sent to the new character');
        assert.deepStrictEqual(results.map(result => result.reason), ['actor_changed', 'actor_changed']);
        const own = await BotConversationStore.context(9201, 9202);
        assert.deepStrictEqual(own.recentTurns.map(turn => turn.role + ':' + turn.text), ['player:one'],
            'the question stays with the character that asked');
        const replacement = await BotConversationStore.context(9203, 9202);
        assert.deepStrictEqual(replacement.recentTurns, [], 'no answer of the old turn is stored under the new character');

        playerSession.actor = first;
        packets.length = 0;
        let releaseSocial, enteredSocial = false, takeoverCalls = 0;
        Social.load = async () => {
            enteredSocial = true;
            await new Promise(resolve => { releaseSocial = resolve; });
            return { trust: 0, familiarity: 0, groupRuns: 0, tradesCompleted: 0 };
        };
        Takeover.request = async () => { takeoverCalls++; return { ok: true, reply: 'Joined.' }; };
        const joining = BotRemoteChat.replyForState(playerSession, { ...state, party: { partyId: 'background-party' } }, 'Can I join your party?');
        await until(() => enteredSocial && releaseSocial);
        playerSession.actor = second;
        releaseSocial();
        assert.strictEqual((await joining).reason, 'actor_changed');
        assert.strictEqual(takeoverCalls, 0, 'a character switch during social-memory loading must stop the native join action');
        assert.deepStrictEqual(packets, []);
        assert.strictEqual(requests.length, 1, 'a stale social-memory continuation cannot reach inference');
        console.log('Remote chat character switch isolation passed');
        process.exitCode = 0;
    } finally {
        options.default.OpenRouter = originalConfig;
        options.default.AI = originalAI;
        LangfuseTracing.withObservation = originalWithObservation;
        LangfuseTracing.withRootObservation = originalWithRootObservation;
        Social.load = originalSocialLoad;
        Takeover.request = originalTakeover;
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.resetTransport();
        BotConversationStore.resetMemory();
    }
}

main().then(() => process.exit(process.exitCode)).catch((error) => {
    console.error(error);
    process.exit(1);
});
