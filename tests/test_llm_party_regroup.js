const assert = require('assert');

require('../src/Global');

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotManager = invoke('GameServer/Bot/BotManager');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

function actor(id, x, y) {
    return {
        fetchId: () => id,
        fetchName: () => `Bot${id}`,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        unselect() {},
        attack: { abortCast() {}, clearTimers() {} },
        state: { setHits() {}, setCasts() {} },
        automation: { abortAll() {} }
    };
}

async function main() {
    const originalSessions = BotManager.sessions;
    const leader = { accountId: 'player', actor: actor(100, 0, 0) };
    const first = { accountId: 'bot_1', actor: actor(1, 600, 0), partyCompanion: true, followPlayerSession: leader };
    const second = { accountId: 'bot_2', actor: actor(2, -600, 0), partyCompanion: true, followPlayerSession: leader };
    BotManager.sessions = [first, second];
    try {
        leader.partyCompanionSettings = { pullMode: 'bot', pullerId: 1 };
        leader.partyPullState = { phase: 'approach', targetId: 77 };
        const result = BotAgentTools.execute(first, {
            action: 'regroup_party',
            regroupRadius: 50,
            reason: 'leader requested compact formation',
            confidence: 1
        }, [], {
            playerSession: leader,
            requestId: 'regroup-1',
            preparedWorldRevision: BotAgentTools.worldRevision(first)
        });
        assert.strictEqual(result.applied, true);
        assert.strictEqual(result.affected, 2);
        assert.deepStrictEqual(leader.partyPullState, {}, 'the current pull should be cancelled');
        assert.strictEqual(leader.partyCompanionSettings.pullMode, 'bot', 'configured pull policy must survive regroup');
        assert.strictEqual(PartyCompanionService.regroupActive(leader), true);
        const firstTarget = PartyCompanionService.formationTargetFor(first);
        const secondTarget = PartyCompanionService.formationTargetFor(second);
        assert.strictEqual(firstTarget.regroup, true);
        assert.notDeepStrictEqual(firstTarget, secondTarget, 'companions need distinct compact slots');
        assert(Math.hypot(firstTarget.locX, firstTarget.locY) <= 51);
        assert(Math.hypot(secondTarget.locX, secondTarget.locY) <= 51);
    } finally {
        BotManager.sessions = originalSessions;
    }
    console.log('LLM party regroup checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
