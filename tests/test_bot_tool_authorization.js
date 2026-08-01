const assert = require('assert');
require('../src/Global');

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotToolAudit = invoke('GameServer/Bot/AI/BotToolAudit');

function actor() {
    return {
        fetchId: () => 201,
        fetchName: () => 'GuardedBot',
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => 0,
        isDead: () => false,
        state: { fetchSeated: () => false, setSeated() {} },
        unselect() {}
    };
}

function decision(action, turnId, worldRevision) {
    return {
        action,
        confidence: 0.99,
        reply: '',
        targetPlayerName: '',
        spotId: '',
        buffType: '',
        reason: 'test',
        turnId,
        worldRevision
    };
}

function main() {
    BotToolAudit.resetMemory();
    const pk = { accountId: 'bot_pk_registry', plan: 'pk_hunting', actor: actor() };
    const pkActions = BotAgentTools.toolDescriptions(pk).map((tool) => tool.action);
    assert(!pkActions.includes('follow_player'), 'PK actions must be hidden from model tools');
    assert.deepStrictEqual(
        BotAgentTools.execute(pk, decision('follow_player', 'pk-1'), [], null),
        { applied: false, reason: 'pk_hunting_autonomous' }
    );

    const session = { accountId: 'bot_stale_registry', plan: 'hunting', actor: actor() };
    const revision = BotAgentTools.worldRevision(session);
    session.plan = 'resting';
    const stale = BotAgentTools.execute(
        session,
        decision('stay_here', 'stale-1', revision),
        [],
        { worldRevision: revision, conversationTurn: { turnId: 'stale-1' } }
    );
    assert.deepStrictEqual(stale, { applied: false, reason: 'stale_world_state' });
    assert.strictEqual(session.botStay, undefined, 'stale tool must not mutate session state');

    const unknown = BotAgentTools.execute(session, decision('invented_tool', 'unknown-1'), [], null);
    assert.deepStrictEqual(unknown, { applied: false, reason: 'unknown_tool' });
    console.log('Bot tool authorization checks passed');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
