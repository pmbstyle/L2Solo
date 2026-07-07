const assert = require('assert');

require('../src/Global');

const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');

function actor(id, level, clanId = 0, options = {}) {
    return {
        fetchId: () => id,
        fetchName: () => `Actor${id}`,
        fetchLevel: () => level,
        fetchClanId: () => clanId,
        fetchLocX: () => Number(options.locX || 0),
        fetchLocY: () => Number(options.locY || 0),
        fetchLocZ: () => Number(options.locZ || 0),
        isDead: () => !!options.dead
    };
}

function session(fakeActor, extras = {}) {
    return {
        actor: fakeActor,
        accountId: `session_${fakeActor.fetchId()}`,
        ...extras
    };
}

const originalGetSnapshot = BotSocialMemory.getSnapshot;
const originalRelationship = BotSocialMemory.relationship;

try {
    let memory = { trust: 0, familiarity: 0, recentlyAbandonedAt: null };
    BotSocialMemory.getSnapshot = () => memory;
    BotSocialMemory.relationship = () => 'stranger';

    const lowPlayer = session(actor(2000001, 20, 0));
    const highBot = session(actor(2000002, 55, 0));
    let result = BotAvailability.evaluate(lowPlayer, highBot);
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.reason, 'level_gap_too_large', 'large level gap should normally block bot party invite');

    const clanPlayer = session(actor(2000003, 20, 6000001));
    const clanBot = session(actor(2000004, 55, 6000001));
    result = BotAvailability.evaluate(clanPlayer, clanBot);
    assert.strictEqual(result.available, true, 'same-clan hot bot should ignore party invite level gap');
    assert.strictEqual(result.clanmate, true);

    const merchantClanBot = session(actor(2000005, 55, 6000001), { plan: 'merchant' });
    result = BotAvailability.evaluate(clanPlayer, merchantClanBot);
    assert.strictEqual(result.available, true, 'same-clan hot bot should ignore merchant duty refusal');

    const farClanBot = session(actor(2000007, 55, 6000001, { locX: 100000 }));
    result = BotAvailability.evaluate(clanPlayer, farClanBot);
    assert.strictEqual(result.available, true, 'same-clan hot bot should ignore distance refusal');

    const deadClanBot = session(actor(2000008, 55, 6000001, { dead: true }));
    result = BotAvailability.evaluate(clanPlayer, deadClanBot);
    assert.strictEqual(result.available, true, 'same-clan hot bot should ignore dead-state refusal');

    const groupedClanBot = session(actor(2000009, 55, 6000001), {
        partyCompanion: true,
        followPlayerSession: session(actor(2000010, 55))
    });
    result = BotAvailability.evaluate(clanPlayer, groupedClanBot);
    assert.strictEqual(result.available, true, 'same-clan hot bot should ignore already-grouped refusal');

    memory = { trust: -10, familiarity: 0, recentlyAbandonedAt: Date.now() };
    result = BotAvailability.evaluate(clanPlayer, clanBot);
    assert.strictEqual(result.available, true, 'same-clan hot bot should ignore social refusal reasons');
    memory = { trust: 0, familiarity: 0, recentlyAbandonedAt: null };

    result = BotAvailability.evaluateState(clanPlayer, {
        characterId: 2000006,
        name: 'ColdClanBot',
        level: 55,
        activity: 'merchant',
        loc: { locX: 100000, locY: 0, locZ: 0 },
        vitals: { hp: 0 },
        stats: { clanId: 6000001 }
    });
    assert.strictEqual(result.available, true, 'same-clan cold bot state should ignore party invite refusal reasons');

    const farColdBot = {
        characterId: 2000011,
        name: 'FarColdBot',
        level: 20,
        activity: 'hunting',
        loc: { locX: 100000, locY: 0, locZ: 0 },
        vitals: { hp: 100, maxHp: 100 },
        stats: {}
    };
    result = BotAvailability.evaluateState(lowPlayer, farColdBot);
    assert.strictEqual(result.available, false, 'far cold bot should obey the same invite range as a hot bot');
    assert.strictEqual(result.reason, 'too_far');

    console.log('Bot availability checks passed');
} finally {
    BotSocialMemory.getSnapshot = originalGetSnapshot;
    BotSocialMemory.relationship = originalRelationship;
}
