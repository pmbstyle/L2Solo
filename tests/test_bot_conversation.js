const assert = require('assert');

require('../src/Global');

const BotConversation = invoke('GameServer/Bot/AI/BotConversation');

function session(name, options = {}) {
    return {
        actor: { fetchName: () => name },
        plan: 'resting',
        botStatus: { home: { region: 'Talking Island' }, role: options.role || 'fighter' },
        ...options
    };
}

const aria = session('Aria', { role: 'tank' });
const belen = session('Belen', { role: 'healer' });
const startedAt = 1_000_000;
const conversation = BotConversation.start(aria, belen, startedAt);

assert.ok(conversation, 'nearby resting bots should be able to start a conversation');
assert.strictEqual(conversation.lines.length, 3, 'a conversation should have an opener, response, and close');
assert.ok(conversation.lines[0].text.includes('Talking Island'), 'dialogue should use the bot context');
assert.ok(
    conversation.lines.some((line) => line.text.includes('health')),
    'dialogue should reflect the responder role'
);
assert.strictEqual(aria.inConversation, true);
assert.strictEqual(belen.inConversation, true);
assert.strictEqual(BotConversation.start(aria, belen, startedAt + 1), null, 'active conversations must not overlap');

BotConversation.finish(conversation);
assert.strictEqual(aria.inConversation, false);
assert.strictEqual(belen.inConversation, false);
assert.strictEqual(
    BotConversation.canStart(aria, belen, startedAt + BotConversation.CONVERSATION_COOLDOWN_MS - 1),
    false,
    'the same bots should not immediately restart their dialogue'
);
assert.strictEqual(
    BotConversation.canStart(aria, belen, startedAt + BotConversation.CONVERSATION_COOLDOWN_MS),
    true,
    'conversation cooldown should eventually expire'
);

const companion = session('Companion', { partyCompanion: true });
assert.strictEqual(BotConversation.canStart(companion, belen, startedAt + 999999), false, 'player companions must not gossip autonomously');

console.log('Bot conversation checks passed');
