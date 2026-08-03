const assert = require('assert');

require('../src/Global');

const BotToolRegistry = invoke('GameServer/Bot/AI/BotToolRegistry');
const BotToolAudit = invoke('GameServer/Bot/AI/BotToolAudit');

const bot = {
    accountId: 'bot_pending_audit',
    actor: {
        fetchId: () => 9901,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => 0,
        isDead: () => false,
        backpack: { fetchItems: () => [] }
    },
    plan: 'following',
    partyCompanion: true,
    followPlayerSession: { accountId: 'pending_audit_player', actor: { fetchId: () => 9902 } }
};

BotToolAudit.resetMemory();
BotToolRegistry.register({
    name: 'test_pending_audit',
    kind: 'mutation',
    mutating: true,
    available: () => true,
    execute: () => ({ applied: true, outcome: 'pending', reason: 'awaiting_native_confirmation' })
});

async function main() {
    const result = BotToolRegistry.execute({
        session: bot,
        decision: {
            action: 'test_pending_audit',
            confidence: 0.99,
            turnId: 'pending-audit-turn'
        },
        requestContext: { playerSession: bot.followPlayerSession },
        expectedWorldRevision: BotToolRegistry.worldRevision(bot)
    });
    assert.strictEqual(result.outcome, 'pending');

    await new Promise((resolve) => setImmediate(resolve));
    const events = BotToolAudit.recent({ botId: 9901, limit: 10 });
    assert(events.some((event) => event.toolName === 'test_pending_audit' && event.outcome === 'pending'), 'pending tool result must stay pending in the audit');
    console.log('Pending bot tool audit checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
