const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotDialogueArbiter = invoke('GameServer/Bot/AI/BotDialogueArbiter');
const PartyLLMRouter = invoke('GameServer/Bot/AI/PartyLLMRouter');
const PartyDialogueState = invoke('GameServer/Bot/AI/PartyDialogueState');
const PartyDialogueRouter = invoke('GameServer/Bot/AI/PartyDialogueRouter');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
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
    const originalStartObservation = LangfuseTracing.startObservation;
    const player = { accountId: 'player_party_route', actor: actor(100, 'Slava', 0) };
    const nice = session(1, 'NiceBot', 5000);
    const mira = session(2, 'Mira', 7000);
    nice.followPlayerSession = player;
    mira.followPlayerSession = player;
    const routed = [];
    let routerCalls = 0;
    const spans = [];
    try {
        PartyDialogueRouter.resetMetrics();
        LangfuseTracing.startObservation = (name) => ({
            end(value, status) { spans.push({ name, value, status }); },
            update() {}
        });
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
        const metrics = PartyDialogueRouter.metrics();
        assert.strictEqual(metrics.messages, 1);
        assert.strictEqual(metrics.routerInvocations, 1);
        assert.strictEqual(metrics.dispatches, 1);
        assert.strictEqual(metrics.multiDispatchViolations, 0);
        assert.deepStrictEqual(
            spans.map((span) => span.name),
            ['party.address.resolve', 'party.dialogue.route', 'party.dispatch']
        );
    } finally {
        PartyDialogueRouter.resetMetrics();
        PartyDialogueState.reset(player);
        BotManager.sessions = originalSessions;
        World.user = originalWorldUser;
        BotBrain.isEnabled = originalEnabled;
        PartyLLMRouter.enabled = originalRouterEnabled;
        PartyLLMRouter.route = originalRouterRoute;
        BotDialogueArbiter.route = originalArbiterRoute;
        LangfuseTracing.startObservation = originalStartObservation;
    }

    console.log('Party chat routing integration checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
