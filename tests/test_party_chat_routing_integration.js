const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotDialogueArbiter = invoke('GameServer/Bot/AI/BotDialogueArbiter');
const PartyLLMRouter = invoke('GameServer/Bot/AI/PartyLLMRouter');
const PartyDialogueState = invoke('GameServer/Bot/AI/PartyDialogueState');
const World = invoke('GameServer/World/World');

function actor(id, name, x) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false
    };
}

function session(id, name, x) {
    return { accountId: `bot_${id}`, actor: actor(id, name, x), partyCompanion: true };
}

async function main() {
    const originalSessions = BotManager.sessions;
    const originalWorldUser = World.user;
    const originalEnabled = BotBrain.isEnabled;
    const originalRouterEnabled = PartyLLMRouter.enabled;
    const originalRouterRoute = PartyLLMRouter.route;
    const originalArbiterRoute = BotDialogueArbiter.route;
    const player = { accountId: 'player_party_route', actor: actor(100, 'Slava', 0) };
    const nice = session(1, 'NiceBot', 5000);
    const mira = session(2, 'Mira', 7000);
    nice.followPlayerSession = player;
    mira.followPlayerSession = player;
    const routed = [];
    let routerCalls = 0;
    try {
        BotManager.sessions = [nice, mira];
        World.user = { sessions: [player, nice, mira] };
        BotBrain.isEnabled = () => true;
        PartyLLMRouter.enabled = () => true;
        PartyLLMRouter.route = async (input) => {
            routerCalls += 1;
            assert.strictEqual(input.candidates.length, 2, 'router must receive only the party roster');
            return {
                ok: true,
                route: 'bot',
                candidate: input.candidates[1],
                reason: 'router chose the healer',
                intent: 'support',
                confidence: 0.95
            };
        };
        BotDialogueArbiter.route = async (input) => {
            routed.push(input.botSession.actor.fetchName());
            return { ok: true, started: true };
        };

        const result = await BotManager.handlePlayerSpeak(player, {
            kind: 3,
            text: 'who should handle this?'
        });
        assert.strictEqual(routerCalls, 1, 'one party message must cause at most one router call');
        assert.deepStrictEqual(routed, ['Mira']);
        assert.strictEqual(result.started, true);
    } finally {
        PartyDialogueState.reset(player);
        BotManager.sessions = originalSessions;
        World.user = originalWorldUser;
        BotBrain.isEnabled = originalEnabled;
        PartyLLMRouter.enabled = originalRouterEnabled;
        PartyLLMRouter.route = originalRouterRoute;
        BotDialogueArbiter.route = originalArbiterRoute;
    }

    console.log('Party chat routing integration checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
