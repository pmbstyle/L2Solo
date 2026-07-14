const assert = require('assert');

require('../src/Global');

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');

const pkSession = {
    accountId: 'bot_pk_test',
    plan: 'pk_hunting',
    actor: {
        fetchName: () => 'Dren',
        state: { fetchSeated: () => false }
    }
};

const result = BotAgentTools.execute(pkSession, {
    action: 'follow_player',
    confidence: 0.99,
    reply: 'Coming!',
    targetPlayerName: 'Bow'
}, []);

assert.deepStrictEqual(result, { applied: false, reason: 'pk_hunting_autonomous' });
assert.strictEqual(pkSession.plan, 'pk_hunting', 'chat commands must not redirect a PK from its encounter behavior');

console.log('PK chat autonomy checks passed');
