const assert = require('assert');
require('../src/Global');

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotToolAudit = invoke('GameServer/Bot/AI/BotToolAudit');

function actor() {
    return {
        fetchId: () => 200,
        fetchName: () => 'RegistryBot',
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => 0,
        isDead: () => false,
        state: {
            fetchSeated: () => false,
            setSeated() {}
        },
        unselect() {}
    };
}

function decision(action, turnId) {
    return {
        action,
        confidence: 0.95,
        reply: '',
        targetPlayerName: '',
        spotId: '',
        buffType: '',
        reason: 'test',
        turnId
    };
}

function context(turnId) {
    return { conversationTurn: { turnId } };
}

function main() {
    BotToolAudit.resetMemory();
    const session = { accountId: 'bot_registry', plan: 'hunting', actor: actor(), dataSendToOthers() {} };
    const first = BotAgentTools.execute(session, decision('stay_here', 'turn-1'), [], context('turn-1'));
    assert.deepStrictEqual(first, { applied: true, reason: 'stay_here' });
    assert.strictEqual(session.botStay, true);

    const replay = BotAgentTools.execute(session, decision('stay_here', 'turn-1'), [], context('turn-1'));
    assert.deepStrictEqual(replay, first, 'the same tool turn must be idempotent');

    const secondMutation = BotAgentTools.execute(session, decision('rest', 'turn-1'), [], context('turn-1'));
    assert.deepStrictEqual(secondMutation, { applied: false, reason: 'one_mutation_per_turn' });

    const softFreshness = BotAgentTools.execute(
        session,
        { ...decision('say', 'turn-2'), reply: 'hello' },
        [],
        { ...context('turn-2'), worldRevision: 'obsolete-before-llm' }
    );
    assert.strictEqual(softFreshness.applied, true, 'low-risk dialogue must not fail on a moved world revision');

    const strictFreshness = BotAgentTools.execute(
        session,
        decision('move_to_spot', 'turn-3'),
        [],
        { ...context('turn-3'), worldRevision: 'obsolete-before-llm' }
    );
    assert.deepStrictEqual(strictFreshness, { applied: false, reason: 'stale_world_state' });

    const audit = BotToolAudit.recent({ botId: 200, limit: 20 });
    assert(audit.some((event) => event.outcome === 'requested'));
    assert(audit.some((event) => event.outcome === 'applied'));
    assert(audit.some((event) => event.reason === 'one_mutation_per_turn'));
    console.log('Bot tool registry checks passed');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
