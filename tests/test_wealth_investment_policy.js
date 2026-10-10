process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // The shared capture helper reads the optional main cold-build counter.
const assert = require('assert');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('wealth-investment-policy');
require('../src/Global');
isolated.assertConfigured(options.default);
const Policy = invoke('GameServer/Bot/Economy/WealthInvestmentPolicy');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const DataCache = invoke('GameServer/DataCache');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const { captureAndRead, expectedSpendable } = require('./helpers/nativeEconomyPolicyAssertions');
const NOW = 1791343645000;

(async () => {
try {
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

// ARCH-NOTE: the direct legacy compatibility policy above keeps its own
// cushion. C1/E3 main goals instead read a real accepted worker decision and
// its funded queue; the removed 81/72 ladder and flat plan reserve are not inputs.
DataCache.init();
const gearState = (level, adena, equipmentPlan) => ({
    characterId: 7, name: 'NativeInvestment', phase: 'cold', activity: 'hunting', level,
    exp: Number(DataCache.experience[level - 1]), adena, updatedAt: NOW, spotId: 'starter',
    currentRegion: 'Gludio', loc: { locX: -14464, locY: 128288, locZ: -3250 }, timing: {}, inventory: {},
    persona: { primaryDrive: 'wealth', traits: {} },
    vitals: { hp: 900, maxHp: 1000, mp: 400, maxMp: 500 }, party: {},
    stats: { classId: 0, deaths: 3, fightsResolved: 10, spotRisk: { spotId: 'starter', deathsAtEntry: 1, fightsAtEntry: 2 },
        build: { grade: level >= 40 ? 'c' : 'd', classId: 0, level },
        equipment: [{ selfId: 1, slot: 7, rank: 'none', name: 'Short Sword' }], equipmentPlan }
});
const needsOptions = { spot: { id: 'starter', risk: 1, route: { id: 'starter_route' } } };
const rich = await captureAndRead(gearState(40, 100000000), { timestamp: NOW, needsOptions });
assert.strictEqual(rich.state.adena, 100000000, 'capturing wishes does not spend the rich wallet');

// Declared own escrow enters the existing native snapshot context; compare
// E3 on its actual returned packet. No physical buy order is created here.
const escrow = 9000;
const held = await captureAndRead(gearState(40, 3000), { timestamp: NOW,
    context: { buyOrderEscrow: escrow }, needsOptions });
assert.strictEqual(Funding.spendable(held.state, escrow, { r: held.state.stats.money[1] }),
    expectedSpendable(held.state, { escrow, r: held.state.stats.money[1] }));
const unheld = await captureAndRead(gearState(40, 3000), { timestamp: NOW, needsOptions });
assert.strictEqual(Funding.spendable(unheld.state, 0, { r: unheld.state.stats.money[1] }),
    expectedSpendable(unheld.state, { r: unheld.state.stats.money[1] }));

const chest = DataCache.items.find((entry) => String(entry.etc?.rank || '').toLowerCase() === 'd'
    && String(entry.template?.kind || '').startsWith('Armor.') && entry.template?.kind !== 'Armor.Jewel'
    && Number(entry.etc?.slot) === 10 && Number(entry.template?.price || 0) > 0);
assert(chest, 'the original market-plan fixture uses an authored D chest');
const plan = { status: 'active', strategy: 'market', target: { selfId: chest.selfId, slot: 10 },
    market: { town: 'Gludio', price: 100000, reserve: 30000, sourceType: 'npc' } };
const planned = await captureAndRead(gearState(20, 125000, plan), { timestamp: NOW, needsOptions });
const allowance = Funding.spendable(planned.state, 0, { itemId: chest.selfId });
let itemRatio = 0;
for (let at = 4; at + 2 < planned.state.stats.money.length; at += 3) {
    if (planned.state.stats.money[at + 2] === chest.selfId) { itemRatio = planned.state.stats.money[at]; break; }
}
assert.strictEqual(allowance, expectedSpendable(planned.state, { r: itemRatio }),
    'the actual queue funds the plan target; the old stored reserve cannot authorize a spend');
assert.deepStrictEqual(planned.state.stats.equipmentPlan, plan, 'reading an accepted decision preserves the original plan');
console.log('Wealth investment policy checks passed');
} finally {
    Economy.reset();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
