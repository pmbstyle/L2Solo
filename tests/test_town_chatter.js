const assert = require('assert');

require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const TownChatter = invoke('GameServer/Bot/AI/TownChatter');
const Budget = invoke('GameServer/Bot/AI/BotChatterBudget');
Budget.reset();

function actor(id) {
    return { fetchId: () => id };
}

const originalPartySay = BotManager.botPartySay;
const messages = [];

try {
    BotManager.botPartySay = (_session, text) => {
        messages.push(text);
        return true;
    };

    const leader = { actor: actor(1), dataSendToMe() {} };
    const first = { actor: actor(10), partyCompanion: true, followPlayerSession: leader };
    const second = { actor: actor(11), partyCompanion: true, followPlayerSession: leader };
    const variants = ['Checking the shop.', 'Making a quick store run.', 'Sorting out my gear.'];
    const BotAI = { say: (_session, text) => messages.push(text) };

    assert.strictEqual(TownChatter.say(first, BotAI, 'shopping', variants, { now: 100000 }), true);
    assert.strictEqual(TownChatter.say(second, BotAI, 'shopping', variants, { now: 100001 }), false,
        'simultaneous town chatter must respect the shared party cooldown');
    assert.strictEqual(TownChatter.say(second, BotAI, 'shopping', variants, { now: 115001 }), true);
    assert.notStrictEqual(messages[0], messages[1],
        'the next companion allowed to speak must use another town variant');

    const solo = { actor: actor(22) };
    assert.strictEqual(TownChatter.say(solo, BotAI, 'buyer-selected', variants), false,
        'routine navigation should stay silent in public chat');
    assert.strictEqual(TownChatter.say(first, BotAI, 'buyer-selected', variants), false,
        'routine navigation should stay silent in party chat too');
    assert.strictEqual(TownChatter.say(solo, BotAI, 'npc-gear-purchased', variants, { now: 200000 }), true);
    assert.strictEqual(TownChatter.say(solo, BotAI, 'npc-gear-purchased', variants, { now: 200001 }), false,
        'changing wording must not bypass the topic cooldown');
    assert.strictEqual(TownChatter.say(solo, BotAI, 'npc-gear-purchased', variants, { now: 500001 }), true);
    assert.notStrictEqual(messages[2], messages[3], 'later public chatter should use another variant');

    console.log('Hot town chatter variation checks passed');
} finally {
    BotManager.botPartySay = originalPartySay;
    Budget.reset();
}
