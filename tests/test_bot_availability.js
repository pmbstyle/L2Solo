const assert = require('assert');

require('../src/Global');

const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');

function actor(id, level, clanId = 0, options = {}) {
    return {
        fetchId: () => id,
        fetchName: () => options.name || `Actor${id}`,
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
const originalPeekSnapshot = BotSocialMemory.peekSnapshot;
const originalRelationship = BotSocialMemory.relationship;

try {
    let memory = { trust: 0, familiarity: 0, recentlyAbandonedAt: null };
    let snapshotReads = 0;
    let previewReads = 0;
    BotSocialMemory.getSnapshot = () => {
        snapshotReads += 1;
        return memory;
    };
    BotSocialMemory.peekSnapshot = () => {
        previewReads += 1;
        return memory;
    };
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
    assert.strictEqual(result.available, false, 'a fixed merchant must remain unavailable even if stale clan data links it to the player');
    assert.strictEqual(result.reason, 'merchant_duty');

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
        stats: {},
        persona: { primaryDrive: 'social', traits: { sociability: 0.80, empathy: 0.80, commitment: 0.70 } }
    };
    result = BotAvailability.evaluateState(lowPlayer, farColdBot);
    assert.strictEqual(result.available, true, 'distance should not block a cold bot that can activate near the player');
    assert.strictEqual(Math.round(result.distance), 100000, 'availability should still expose distance for diagnostics');

    result = BotAvailability.evaluateState(lowPlayer, { ...farColdBot, activity: 'traveling' });
    assert.strictEqual(result.available, false, 'a cold bot that activation rejects in transit must not expose a working invite action');
    assert.strictEqual(result.reason, 'in_transit');
    result = BotAvailability.evaluateState(lowPlayer, { ...farColdBot, activity: 'traveling' }, { forceFriend: true });
    assert.strictEqual(result.available, true, 'a const friend summon must interrupt background travel');
    result = BotAvailability.evaluateState(lowPlayer, { ...farColdBot, activity: 'pk_hunting' });
    assert.strictEqual(result.available, false, 'a cold PK encounter bot must retain its existing activation gate in the catalog');
    assert.strictEqual(result.reason, 'pk_encounter_only');
    result = BotAvailability.evaluateState(lowPlayer, { ...farColdBot, activity: 'pk_hunting' }, { forceFriend: true });
    assert.strictEqual(result.available, true, 'a const friend summon must outrank a background PK hunt');

    const socialBot = session(actor(2000012, 20), {
        persona: { primaryDrive: 'social', traits: { sociability: 0.80, empathy: 0.80, commitment: 0.70 } }
    });
    result = BotAvailability.evaluate(lowPlayer, socialBot);
    assert.strictEqual(result.available, true, 'a social persona should remain available after hard invite checks pass');

    const soloBot = session(actor(2000013, 20), {
        persona: { primaryDrive: 'wealth', traits: { sociability: 0.30, empathy: 0.35, commitment: 0.45 } }
    });
    result = BotAvailability.evaluate(lowPlayer, soloBot);
    assert.strictEqual(result.available, false, 'a reserved persona may decline after all hard checks pass');
    assert.strictEqual(result.reason, 'prefers_solo');
    result = BotAvailability.evaluate(lowPlayer, soloBot, { forceFriend: true });
    assert.strictEqual(result.available, true, 'a const friend invite must override persona solo preference');

    const farLowFriend = session(actor(2000015, 55, 0, { locX: 100000 }), {
        persona: { primaryDrive: 'wealth', traits: { sociability: 0.30, empathy: 0.35, commitment: 0.45 } }
    });
    result = BotAvailability.evaluate(lowPlayer, farLowFriend, { forceFriend: true });
    assert.strictEqual(result.available, true, 'a const friend invite must override level and persona soft gates');

    const farSocialBot = session(actor(2000014, 20, 0, { locX: 100000 }), {
        persona: { primaryDrive: 'social', traits: { sociability: 0.80, empathy: 0.80, commitment: 0.70 } }
    });
    result = BotAvailability.evaluate(lowPlayer, farSocialBot);
    assert.strictEqual(result.available, true, 'distance should not block a hot bot because companion catch-up handles arrival');
    assert.strictEqual(Math.round(result.distance), 100000, 'hot-bot distance should remain available for diagnostics');
    assert.deepStrictEqual(BotAvailability.listForPlayer(lowPlayer, [farSocialBot]).map((entry) => entry.session), [farSocialBot],
        '.botparty candidate discovery should keep an available distant hot bot');

    const ownCompanion = session(actor(2000019, 20), {
        partyCompanion: true,
        followPlayerSession: lowPlayer
    });
    const otherPlayer = session(actor(2000020, 20));
    const otherCompanion = session(actor(2000021, 20), {
        partyCompanion: true,
        followPlayerSession: otherPlayer
    });
    const partyCandidates = BotAvailability.listForPlayer(lowPlayer, [ownCompanion, otherCompanion]);
    assert.deepStrictEqual(partyCandidates.map((entry) => entry.session), [otherCompanion],
        '.botparty should hide companions already attached to the requesting player');
    assert.strictEqual(partyCandidates[0].availability.reason, 'already_grouped',
        'a companion attached to another player should remain visible with its unavailable reason');

    const staticCraftState = {
        characterId: 2000016,
        name: 'PublicCrafter',
        level: 70,
        activity: 'crafting',
        loc: { locX: 0, locY: 0, locZ: 0 },
        vitals: { hp: 100, maxHp: 100 },
        stats: { craftStationId: 'giran_weapons', craftShop: { town: 'Giran' } }
    };
    result = BotAvailability.evaluateState(lowPlayer, staticCraftState, { forceFriend: true });
    assert.strictEqual(result.available, false, 'const friend overrides must never recruit a public craft service');
    assert.strictEqual(result.reason, 'merchant_duty');

    const staticMerchant = session(actor(2000017, 20), { plan: 'merchant' });
    result = BotAvailability.evaluate(lowPlayer, staticMerchant, { forceFriend: true });
    assert.strictEqual(result.available, false, 'const friend overrides must never recruit a fixed merchant');
    assert.strictEqual(result.reason, 'merchant_duty');

    const configuredMerchant = session(actor(2000018, 1, 0, { name: 'Nika' }), {
        plan: 'merchant',
        coldLifeState: { stats: { classId: 53 } }
    });
    result = BotAvailability.evaluate(lowPlayer, configuredMerchant, { forceFriend: true });
    assert.strictEqual(result.reason, 'merchant_duty', 'configured liquidity stores must remain static even with a stale life-state snapshot');
    assert.deepStrictEqual(BotAvailability.listForPlayer(lowPlayer, [configuredMerchant]), [], 'static services must not appear in party candidate lists');

    const dynamicMerchant = session(actor(2000022, 22, 0, { name: 'DynamicSeller' }), {
        plan: 'merchant',
        coldLifeState: { characterId: 2000022, name: 'DynamicSeller', stats: { classId: 54 } }
    });
    const coldAdventure = {
        characterId: 2000023,
        name: 'ColdAdventure',
        level: 24,
        activity: 'hunting',
        loc: { locX: 50000, locY: 0, locZ: 0 },
        vitals: { hp: 100, maxHp: 100 },
        stats: { classId: 8 }
    };
    const duplicateHotState = {
        ...farColdBot,
        characterId: farSocialBot.actor.fetchId(),
        name: farSocialBot.actor.fetchName()
    };
    const ownCompanionState = {
        ...farColdBot,
        characterId: ownCompanion.actor.fetchId(),
        name: ownCompanion.actor.fetchName()
    };
    const snapshotReadsBeforeCatalog = snapshotReads;
    const catalog = BotAvailability.catalogForPlayer(
        lowPlayer,
        [farSocialBot, ownCompanion, dynamicMerchant, configuredMerchant],
        [duplicateHotState, ownCompanionState, coldAdventure, staticCraftState]
    );
    assert.deepStrictEqual(
        catalog.map((candidate) => candidate.name).sort(),
        ['Actor2000014', 'ColdAdventure', 'DynamicSeller'],
        'the global party catalog should merge hot and cold bots, deduplicate snapshots, hide own companions and exclude static services'
    );
    assert.strictEqual(catalog.find((candidate) => candidate.name === 'Actor2000014').phase, 'hot', 'a live session should win over its cold snapshot');
    assert.strictEqual(catalog.find((candidate) => candidate.name === 'ColdAdventure').phase, 'cold', 'background adventurers should remain discoverable');
    assert.strictEqual(snapshotReads, snapshotReadsBeforeCatalog,
        'building catalog metadata must not fan out social-memory reads across the whole population');
    result = BotAvailability.evaluate(lowPlayer, farSocialBot, { loadMemory: false });
    assert.strictEqual(result.available, true);
    assert.strictEqual(snapshotReads, snapshotReadsBeforeCatalog,
        'catalog availability previews must not trigger asynchronous per-bot memory loads');
    assert.strictEqual(previewReads, 1, 'catalog availability should still use an already cached social snapshot when present');
    result = BotAvailability.evaluate(lowPlayer, dynamicMerchant);
    assert.strictEqual(result.reason, 'merchant_duty', 'temporary merchants should stay visible while page-level availability explains why they cannot join yet');

    console.log('Bot availability checks passed');
} finally {
    BotSocialMemory.getSnapshot = originalGetSnapshot;
    BotSocialMemory.peekSnapshot = originalPeekSnapshot;
    BotSocialMemory.relationship = originalRelationship;
}
