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

console.log('Wealth investment policy checks passed');
