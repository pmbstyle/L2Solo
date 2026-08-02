const assert = require('assert');

require('../src/Global');

const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotDialogueArbiter = invoke('GameServer/Bot/AI/BotDialogueArbiter');
const BotContextAssembler = invoke('GameServer/Bot/AI/BotContextAssembler');
const BotAI = invoke('GameServer/Bot/BotAI');
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
        fetchKarma: () => 0,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
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
    const originalWorldNpc = World.npc;
    const originalFetchVisibleUsers = World.fetchVisibleUsers;
    const originalStatus = BotAI.getStatus;
    const originalAssemble = BotContextAssembler.assemble;
    const requests = [];
    let releaseFirst;

    try {
        options.default.OpenRouter = {
            ...originalConfig,
            enabled: true,
            apiKey: 'hot-history-test-key',
            model: 'test/hot-history',
            cooldownMs: 0,
            chatCooldownMs: 0
        };
        BotConversationStore.resetMemory();
        const playerSession = {
            accountId: 'player_history',
            actor: actor(9201, 'HistoryPlayer'),
            dataSendToMe() {}
        };
        const botSession = { accountId: 'bot_history', actor: actor(9202, 'HistoryBot', 100), plan: 'hunting' };
        World.user = { sessions: [playerSession, botSession] };
        World.npc = { spawns: [] };
        World.fetchVisibleUsers = () => [playerSession];
        BotAI.getStatus = () => ({ available: true, name: 'HistoryBot', mode: 'hunting', level: 20 });
        BotContextAssembler.assemble = async () => ({ bot: {}, fragments: [], telemetry: {} });
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.setTransport(async (_url, init) => {
            requests.push(JSON.parse(init.body));
            if (requests.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
            return response({
                choices: [{ message: { content: JSON.stringify({
                    action: 'none',
                    reply: requests.length === 1 ? 'first reply' : 'second reply',
                    reason: 'history_test',
                    confidence: 0.95
                }) } }]
            });
        });

        const first = BotDialogueArbiter.route({ playerSession, botSession, text: 'first message', channel: 'client_tell' });
        for (let i = 0; i < 20 && requests.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const second = BotDialogueArbiter.route({ playerSession, botSession, text: 'second message', channel: 'client_tell' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.strictEqual(requests.length, 1, 'second tell should wait in FIFO while the first provider call is active');
        releaseFirst();
        await Promise.all([first, second]);
        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.strictEqual(requests.length, 2);
        const secondPayload = JSON.parse(requests[1].messages[1].content);
        assert.deepStrictEqual(
            secondPayload.conversation.recentTurns.map((turn) => turn.text),
            ['first message', 'first reply', 'second message']
        );
        console.log('Hot conversation queue history checks passed');
    } finally {
        releaseFirst?.();
        options.default.OpenRouter = originalConfig;
        World.user = originalWorldUser;
        World.npc = originalWorldNpc;
        World.fetchVisibleUsers = originalFetchVisibleUsers;
        BotAI.getStatus = originalStatus;
        BotContextAssembler.assemble = originalAssemble;
        OpenRouterGateway.resetCircuit();
        OpenRouterGateway.resetTransport();
        BotConversationStore.resetMemory();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
