const assert = require('assert');

require('../src/Global');

const Policy = invoke('GameServer/Bot/Economy/WealthInvestmentPolicy');

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

console.log('Wealth investment policy checks passed');
