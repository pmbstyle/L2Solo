const assert = require('assert');

require('../src/Global');

const Policy = invoke('GameServer/Bot/Economy/WealthInvestmentPolicy');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');

const state = {
    persona: { primaryDrive: 'wealth', traits: {} },
    adena: 12000,
    spotId: 'dion_ruins',
    stats: {
        deaths: 3,
        fightsResolved: 10,
        spotRisk: { spotId: 'dion_ruins', deathsAtEntry: 1, fightsAtEntry: 2 }
    }
};

const pressure = Policy.spotDeathPressure(state);
assert.deepStrictEqual(pressure, { spotId: 'dion_ruins', deaths: 2, fights: 8, deathRate: 0.25 });

const investment = Policy.investmentOpportunity(state, 9000);
assert.strictEqual(investment.affordable, true, 'wealth bot with a reserve should invest to stop repeated deaths');
assert.strictEqual(investment.reason, 'reduce_deaths_at_profitable_spot');
assert.strictEqual(Policy.investmentOpportunity({ ...state, adena: 9000 }, 9000).affordable, false, 'the purchase must leave operating capital');
assert.strictEqual(Policy.investmentOpportunity({ ...state, persona: { primaryDrive: 'progression', traits: {} } }, 9000), null, 'other drives retain normal gear priority');
// The bot's own buy order holds part of the money: the investment stays affordable.
assert.strictEqual(Policy.investmentOpportunity({ ...state, adena: 3000 }, 9000).affordable, false);
assert.strictEqual(Policy.investmentOpportunity({ ...state, adena: 3000 }, 9000, 0, 9000).affordable, true,
    'Adena in the bot\'s own buy order counts toward the investment');
// The purchase must also be funded by the shared rule: its reserve is kept.
assert.strictEqual(Policy.investmentOpportunity(state, 9000, 5000).affordable, false,
    'an investment the shared funding check refuses is not affordable');
assert.strictEqual(Policy.spotDeathPressure({ ...state, spotId: 'other_spot' }), null, 'historic deaths cannot bleed into a new spot');

const backoff = SpotRiskPolicy.backoffForStates([state], state.spotId, 1000);
assert.deepStrictEqual(backoff, {
    spotId: 'dion_ruins', deaths: 2, fights: 8, deathRate: 0.25,
    reason: 'death_pressure', startedAt: 1000, until: 1000 + SpotRiskPolicy.BACKOFF_MS
});
const backedOff = SpotRiskPolicy.withBackoff(state, backoff, 1000);
assert(SpotRiskPolicy.excludedSpotIdsForStates([backedOff], 2000).has('dion_ruins'),
    'a dangerous spot must remain excluded after the bot leaves and resets its live baseline');
const relocated = {
    ...backedOff,
    spotId: 'other_spot',
    stats: {
        ...backedOff.stats,
        spotRisk: { spotId: 'other_spot', deathsAtEntry: 3, fightsAtEntry: 10 }
    }
};
assert.strictEqual(SpotRiskPolicy.excludedSpotIdsForStates([relocated], backoff.until + 1).has('dion_ruins'), false,
    'the spot must become eligible again after the bounded cooldown');

// The goal review passes the plan's reserve and the bot's own buy-order
// escrow to the policy.
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const originalProjection = AfkTrade.findOwnerProjection;
const gearGoal = (level, adena, escrow, equipmentPlan) => {
    AfkTrade.findOwnerProjection = () => (escrow ? { shop: { storeType: AfkTrade.BUY, escrowAdena: escrow } } : null);
    return NeedsEvaluator.evaluate({
        characterId: 7, phase: 'cold', level, adena, spotId: 'starter', persona: { primaryDrive: 'wealth', traits: {} },
        vitals: { hp: 900, maxHp: 1000, mp: 400, maxMp: 500 }, party: {},
        stats: { classId: 0, deaths: 3, fightsResolved: 10, spotRisk: { spotId: 'starter', deathsAtEntry: 1, fightsAtEntry: 2 },
            build: { grade: level >= 40 ? 'c' : 'd', classId: 0, level },
            equipment: [{ selfId: 1, slot: 7, rank: 'none', name: 'Short Sword' }], equipmentPlan }
    }, { spot: { id: 'starter', risk: 1, route: { id: 'starter_route' } }, now: 100000 })
        .find((candidate) => candidate.type === 'upgrade_gear');
};
try {
    // A reference-priced need: the cost in the bot's own buy order, the cushion in the wallet.
    const rich = gearGoal(40, 100000000, 0);
    assert.strictEqual(rich.priority, 81, 'fixture: a funded wealth investment');
    const cost = Number(rich.plan.estimatedCost);
    const cushion = Math.ceil(cost * Policy.RESERVE_RATE);
    assert.strictEqual(gearGoal(40, cushion, cost).priority, 81, 'the goal review counts the buy-order escrow for the investment');
    assert.strictEqual(gearGoal(40, cushion, 0).priority, 72, 'without the order the same wallet only saves');
    // An NPC plan whose stored reserve is above the cushion: cost + cushion is not enough.
    const chest = DataCache.items.find((entry) => String(entry.etc?.rank || '').toLowerCase() === 'd'
        && String(entry.template?.kind || '').startsWith('Armor.') && entry.template?.kind !== 'Armor.Jewel'
        && Number(entry.etc?.slot) === 10 && Number(entry.template?.price || 0) > 0);
    const plan = { status: 'active', strategy: 'market', target: { selfId: chest.selfId, slot: 10 },
        market: { town: 'Gludio', price: 100000, reserve: 30000, sourceType: 'npc' } };
    assert.strictEqual(gearGoal(20, 125000, 0, plan).priority, 72,
        'a wallet above the cushion but under the plan\'s reserve is no affordable investment');
} finally {
    AfkTrade.findOwnerProjection = originalProjection;
}

console.log('Wealth investment policy checks passed');
