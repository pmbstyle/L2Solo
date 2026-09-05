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
assert.ok(conversation.lines.every(line => line.text.length <= 120), 'ambient lines must fit the client');
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

const originalRandom = Math.random;
try {
    Math.random = () => 0;
    const firstTopic = BotConversation.chooseTopic(session('First'), session('Second'));
    const anotherTopic = BotConversation.chooseTopic(
        session('First', { recentConversationTopics: [firstTopic.id] }), session('Second'));
    assert.notStrictEqual(firstTopic.id, anotherTopic.id, 'recent subjects must not repeat with a new partner');

    const topics = new Set();
    for (let n = 0; n < 100; n++) {
        Math.random = () => n / 100;
        const topic = BotConversation.chooseTopic(session('A'), session('B'));
        topics.add(topic.id);
        assert([topic.opener, topic.reply, topic.closer].every(line => line.length <= 120));
        assert(![topic.opener, topic.reply, topic.closer].some(line => /24_14|density/.test(line)));
    }
    assert(topics.size >= 5, 'ordinary resting bots should have several subjects without fabricated events');
    Math.random = () => 0.45;
    const cautious = BotConversation.chooseTopic(session('A'), session('B', { persona: { traits: { caution: 0.9 } } }));
    const bold = BotConversation.chooseTopic(session('A'), session('B', { persona: { traits: { caution: 0.1 } } }));
    assert.strictEqual(cautious.id, 'gear');
    assert.notStrictEqual(cautious.reply, bold.reply, 'personality should affect the actual answer');
    Math.random = () => 0.999;
    const healer = BotConversation.chooseTopic(session('A'), session('B', { role: 'healer' }));
    assert(healer.reply.includes('health'), 'a role-specific reply must still reflect the speaker');
    const lowMana = session('Tired', { actor: { fetchName: () => 'Tired', fetchMaxMp: () => 100, fetchMp: () => 10 } });
    assert.strictEqual(BotConversation.chooseTopic(session('A'), lowMana).id, 'recovery');
    lowMana.actor.fetchMp = () => 100;
    assert.notStrictEqual(BotConversation.chooseTopic(session('A'), lowMana).id, 'recovery',
        'a mana complaint requires actual low mana');
} finally {
    Math.random = originalRandom;
}
assert(BotConversation.canContinue(conversation));
belen.plan = 'hunting';
assert.strictEqual(BotConversation.canContinue(conversation), false, 'leaving rest must interrupt queued dialogue');
belen.plan = 'resting';
belen.actor.state = { fetchDead: () => true };
assert.strictEqual(BotConversation.canStart(aria, belen, startedAt + 999999), false, 'dead actors must not start gossip');

console.log('Bot conversation checks passed');
