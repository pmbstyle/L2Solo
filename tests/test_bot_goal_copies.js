const assert = require('assert');

require('../src/Global');

invoke('GameServer/DataCache').init();

const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const PartyMarketBreak = invoke('GameServer/Bot/Population/PartyMarketBreak');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const RequiredPartyFormation = invoke('GameServer/Bot/Population/RequiredPartyFormation');

// Pins of the goal rules that live in several copies (step 1.4): rest
// thresholds, the inventory cleanup goal, stale shopping and party request
// expiry, limits and objective spot.
const now = 1_750_000_000_000;
const FIGHTER = 0;
const MYSTIC = 10;
const TANK = 5;

function bot(classId, vitals, extra = {}) {
    return {
        characterId: 9100 + classId, name: `Probe${classId}`, phase: 'cold', activity: 'hunting',
        level: 40, levelBand: '38-42', spotId: 'home',
        vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500, ...vitals },
        party: {}, ...extra, stats: { classId, ...(extra.stats || {}) }
    };
}
const ratios = (hp, mp) => ({ hp: hp * 1000, maxHp: 1000, mp: mp * 500, maxMp: 500 });

// Rest: the goal planner's recover goal.
const recover = (state) => NeedsEvaluator.evaluate(state, { now }).some((goal) => goal.type === 'recover');
assert.strictEqual(recover(bot(FIGHTER, ratios(1, 1))), false, 'a fresh fighter has no recover goal');
assert.strictEqual(recover(bot(FIGHTER, ratios(0.34, 1))), true, 'a fighter under 35% HP recovers');
assert.strictEqual(recover(bot(FIGHTER, ratios(0.36, 1))), false);
assert.strictEqual(recover(bot(FIGHTER, ratios(1, 0.1))), false,
    'a fighter at full HP and 10% MP does not hold the recover goal: it does not rest for MP');
assert.strictEqual(recover(bot(MYSTIC, ratios(1, 0.1))), true, 'a mage at 10% MP recovers');
assert.strictEqual(recover(bot(MYSTIC, ratios(1, 0.21))), false);
assert.strictEqual(recover(bot(FIGHTER, ratios(1, 1), { activity: 'resting' })), true,
    'a resting bot keeps its recover goal');

// Rest: the one rule and its thresholds.
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const fighter = bot(FIGHTER, ratios(1, 1));
const mystic = bot(MYSTIC, ratios(1, 1));
assert.strictEqual(RestPolicy.needsRest(fighter, 0.94, 1, { locked: true }), true, 'a locked recovery rests to 95% HP');
assert.strictEqual(RestPolicy.needsRest(fighter, 0.95, 0.1, { locked: true }), false, 'a locked fighter ignores MP');
assert.strictEqual(RestPolicy.needsRest(mystic, 1, 0.94, { locked: true }), true, 'a locked mage rests to 95% MP');
assert.strictEqual(RestPolicy.needsRest(mystic, 1, 0.95, { locked: true }), false);
assert.strictEqual(RestPolicy.needsRest(bot(TANK, ratios(1, 1)), 1, 0.17, { party: true }), true);
assert.strictEqual(RestPolicy.needsRest(bot(TANK, ratios(1, 1)), 1, 0.17), false);

// Rest: the cold solo rule.
const soloRest = (state) => BackgroundResolver.needsRest(state, state.vitals);
assert.strictEqual(soloRest(bot(FIGHTER, ratios(0.34, 1))), true);
assert.strictEqual(soloRest(bot(FIGHTER, ratios(0.35, 1))), false);
assert.strictEqual(soloRest(bot(FIGHTER, ratios(1, 0.05))), false, 'a fighter does not rest for MP');
assert.strictEqual(soloRest(bot(TANK, ratios(1, 0.05))), false, 'a solo tank does not rest for MP');
assert.strictEqual(soloRest(bot(MYSTIC, ratios(1, 0.19))), true);
assert.strictEqual(soloRest(bot(MYSTIC, ratios(1, 0.2))), false);

// Rest: the cold party resolver asks with the party thresholds and the party
// mana roles. The probe evaluates the resolver's own call on chosen vitals.
const partyCalls = [];
const originalNeedsRest = BackgroundResolver.needsRest;
BackgroundResolver.needsRest = (state, vitals, options) => {
    partyCalls.push(options);
    return originalNeedsRest(state, vitals, options);
};
try {
    BackgroundPartyResolver.resolve({
        party: { partyId: 'probe-party', leaderId: 9100, cohesion: 0.7, risk: 0.2, stats: {} },
        members: [bot(FIGHTER, ratios(1, 1), { activity: 'grouped' }), bot(MYSTIC, ratios(1, 1), { activity: 'grouped' })],
        spot: { id: 'execution_ground', name: 'Execution Ground', density: 3, avgLevel: 40,
            rewards: { adenaMin: 10, adenaMax: 20, expMin: 10, expMax: 20 } },
        elapsedMs: 30000,
        timestamp: now,
        rng: () => 0.5
    });
} finally {
    BackgroundResolver.needsRest = originalNeedsRest;
}
assert(partyCalls.length > 0, 'the party resolver decides rest per member');
const partyOptions = partyCalls[0];
const partyRest = (state) => originalNeedsRest(state, state.vitals, partyOptions);
assert.strictEqual(partyRest(bot(FIGHTER, ratios(0.29, 1))), true, 'a party member rests under 30% HP');
assert.strictEqual(partyRest(bot(FIGHTER, ratios(0.31, 1))), false, 'a party member keeps fighting at 31% HP');
assert.strictEqual(partyRest(bot(MYSTIC, ratios(1, 0.17))), true, 'a party mage rests under 18% MP');
assert.strictEqual(partyRest(bot(MYSTIC, ratios(1, 0.19))), false);
assert.strictEqual(partyRest(bot(TANK, ratios(1, 0.17))), true, 'a party tank rests for MP');
assert.strictEqual(partyRest(bot(FIGHTER, ratios(1, 0.05))), false, 'a party fighter does not rest for MP');

// Rest: activation near a player keeps its own rule (step 1.5).
assert.strictEqual(PopulationService.isRestingActivationState(bot(FIGHTER, ratios(1, 0.1))), true,
    'activation recovers any class under 20% MP');
assert.strictEqual(PopulationService.isRestingActivationState(bot(FIGHTER, ratios(0.36, 0.21))), false);

// Inventory cleanup: the goal planner's goal.
const originalNeed = ItemDisposition.inventoryCleanupNeed;
let needCalls = 0;
const capacity = { reason: 'inventory_capacity', slots: 81, limit: 80, npcOnlySlots: 3 };
ItemDisposition.inventoryCleanupNeed = () => { needCalls += 1; return capacity; };
try {
    const cleanup = NeedsEvaluator.evaluate(bot(FIGHTER, ratios(1, 1)), { now })
        .find((goal) => goal.type === 'sell_inventory' && goal.target.cleanupReason);
    assert.deepStrictEqual(cleanup, {
        type: 'sell_inventory',
        priority: 96,
        target: { itemCount: 81, npcOnlySlots: 3, cleanupReason: 'inventory_capacity' },
        plan: { kind: 'market_sell', expectedBenefit: 'market_sale_inventory', risk: 0, cleanupReason: 'inventory_capacity' },
        blockers: [],
        nextReviewAt: now + 10 * 60 * 1000
    });

    // Inventory cleanup: the clan-duty market break takes only a bag over 80.
    const clanParty = { partyId: 'clan-party', stats: { objective: { priority: 'required', clanGoalKey: 'clan:1' } } };
    const member = bot(FIGHTER, ratios(1, 1), { characterId: 42 });
    assert.strictEqual(PartyMarketBreak.allowed(clanParty, member, now), true);
    const breakGoal = PartyMarketBreak.goal(clanParty, member, { type: 'progress_level' }, now);
    assert.deepStrictEqual(breakGoal, {
        type: 'sell_inventory', status: 'active', priority: 96,
        target: { itemCount: 81, npcOnlySlots: 3, cleanupReason: 'inventory_capacity' },
        plan: { kind: 'market_sell', expectedBenefit: 'market_sale_inventory', risk: 0, cleanupReason: 'inventory_capacity' },
        blockers: []
    }, 'the clan break goal is the planner cleanup goal');
    const callsBefore = needCalls;
    const given = PartyMarketBreak.memberNeed(clanParty, member, now);
    assert.strictEqual(PartyMarketBreak.allowed(clanParty, member, now, given), true);
    assert.deepStrictEqual(PartyMarketBreak.goal(clanParty, member, null, now, given), breakGoal);
    PartyMarketBreak.departure(clanParty, member, { stats: {} }, now, given);
    assert.strictEqual(needCalls, callsBefore + 1, 'a passed need walks the bag once');
    assert.strictEqual(PartyMarketBreak.memberNeed({ partyId: 'free', stats: {} }, member, now), null);
    assert.strictEqual(needCalls, callsBefore + 1, 'an ordinary party does not walk the bag');
    const departure = PartyMarketBreak.departure(clanParty, member, { activity: 'traveling', stats: {} }, now);
    assert.deepStrictEqual(departure.stats.partyMarketReturn, {
        partyId: 'clan-party', characterId: 42, until: now + 15 * 60 * 1000,
        objective: { priority: 'required', clanGoalKey: 'clan:1' }, startedAt: now,
        cleanupReason: 'inventory_capacity', slots: 81, limit: 80
    });
    const freeParty = { partyId: 'free', stats: {} };
    const current = { type: 'sell_inventory' };
    assert.strictEqual(PartyMarketBreak.goal(freeParty, member, current, now), current,
        'an ordinary party keeps the member goal');
    ItemDisposition.inventoryCleanupNeed = () => ({ reason: 'npc_only_inventory', slots: 10, limit: 80 });
    assert.strictEqual(PartyMarketBreak.allowed(clanParty, member, now), false);
    assert.strictEqual(PartyMarketBreak.goal(clanParty, member, current, now), null,
        'NPC junk does not break a clan duty');
} finally {
    ItemDisposition.inventoryCleanupNeed = originalNeed;
}
assert(needCalls > 0);

// Stale shopping: the worker sends a stale town shopper back to hunting.
const spot = { id: 'home', name: 'Home', center: { locX: 10, locY: 20, locZ: 30 }, density: 1, avgLevel: 40 };
const shopper = (stats = {}, region = 'Gludio') => bot(FIGHTER, ratios(1, 1), {
    activity: 'shopping', currentRegion: region, homeRegion: 'Gludio', stats
});
const shopping = (state) => BackgroundResolver.resolveSolo({ state, spot, timestamp: now }).debug?.activity;
assert.strictEqual(shopping(shopper()), 'shopping_recovered');
assert.strictEqual(shopping(shopper({ marketReturn: { spotId: 'home' } })), 'shopping');
assert.strictEqual(shopping(shopper({}, 'Giran')), 'shopping');
assert.strictEqual(shopping(shopper({ supplyErrand: { itemId: 57 } })), 'supply_errand');

// Party request expiry on the main thread.
const request = (priority, age, extra = {}) => ({
    ...bot(FIGHTER, ratios(1, 1)),
    stats: { partyRequest: { status: 'open', priority, requestedAt: now - age, attempts: 2, objectiveKey: 'k', reviewAt: 5, ...extra } }
});
const fresh = request('required', 15 * 60 * 1000 - 1);
assert.strictEqual(PopulationService.expirePartyRequestForState(fresh, now), fresh);
assert.deepStrictEqual(PopulationService.expirePartyRequestForState(request('required', 15 * 60 * 1000), now).stats.partyRequest, {
    status: 'deferred', priority: 'required', requestedAt: now - 15 * 60 * 1000, attempts: 3, objectiveKey: 'k', reviewAt: 5,
    deferredUntil: now + 5 * 60 * 1000, expiredAt: now
});
const preferredFresh = request('preferred', 5 * 60 * 1000 - 1);
assert.strictEqual(PopulationService.expirePartyRequestForState(preferredFresh, now), preferredFresh);
assert.strictEqual(PopulationService.expirePartyRequestForState(request('preferred', 5 * 60 * 1000), now)
    .stats.partyRequest.status, 'deferred');
const deferred = request('required', 99 * 60 * 1000, { status: 'deferred' });
assert.strictEqual(PopulationService.expirePartyRequestForState(deferred, now), deferred);

// Party size limits: the main thread and the worker's formation proposal.
assert.deepStrictEqual(PopulationService.partyLimitsForObjective(null), { maxSize: 5, minSize: 2, levelRange: undefined });
assert.deepStrictEqual(PopulationService.partyLimitsForObjective({
    clanOperation: 'equipment', clanId: 3, maxPartySize: 12, minPartySize: 1, levelRange: 2
}), { maxSize: 9, minSize: 2, levelRange: 4 });
assert.deepStrictEqual(PopulationService.partyLimitsForObjective({
    clanOperation: 'equipment', clanId: 3, maxPartySize: 4, minPartySize: 3
}), { maxSize: 4, minSize: 3, levelRange: 99 });

// Objective spot in the worker's formation proposal.
const planned = (status) => bot(FIGHTER, ratios(1, 1), {
    spotId: 'current', stats: { equipmentPlan: { status, next: { spotId: 'plan-spot' } } }
});
assert.strictEqual(RequiredPartyFormation.spotFor(planned('active')), 'plan-spot');
assert.strictEqual(RequiredPartyFormation.spotFor(planned('complete')), 'current');
assert.strictEqual(RequiredPartyFormation.spotFor(planned('active'), { spotId: 'objective-spot' }), 'objective-spot');
assert.strictEqual(RequiredPartyFormation.spotFor(bot(FIGHTER, ratios(1, 1), { spotId: null })), '');

console.log('Bot goal copy checks passed');
