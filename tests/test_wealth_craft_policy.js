const assert = require('assert');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('wealth-craft-policy');
require('../src/Global');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;
isolated.assertConfigured(options.default);
const Policy = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
const Data = invoke('GameServer/DataCache');
const Background = invoke('GameServer/Bot/Population/BackgroundResolver');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const { captureAndRead, expectedSpendable } = require('./helpers/nativeEconomyPolicyAssertions');
const NOW = 1791343645000;

(async () => {
try {
const recipe = {
    type: 'dwarven', recipeId: 41, productId: 1894, productCount: 1,
    successRate: 100, mpCost: 20,
    materials: [{ selfId: 1876, amount: 2 }, { selfId: 1881, amount: 1 }]
};
const state = { adena: 500000, vitals: { mp: 100 } };
// Each missing input is one purchase in the town where it costs the least
// with the trip (ColdMarketService.planPurchase): goods cost and landed cost.
const unitPrice = new Map([[1876, 11000], [1881, 5000]]);
let trip = 0;
const planFor = (selfId, missing) => (unitPrice.has(selfId)
    ? { town: 'Giran', cost: unitPrice.get(selfId) * missing, landed: unitPrice.get(selfId) * missing + trip, units: missing, whole: true }
    : null);
const exit = { type: 'afk', price: 50000, count: 1, trip: 0 };
// ARCH-NOTE: this is a declared unit basket, not the authored recipe41.
// The paid clock is fixed before execution: 100 Adena/second and 1 MP/second.
const paid = Object.freeze({ hourAdena: 360000, mpPerHour: 3600 });
const netProfit = (entry, productPrice, basketCost, saleTrip, clock = paid) =>
    productPrice * entry.productCount * entry.successRate / 100 - basketCost - saleTrip
        - entry.mpCost / clock.mpPerHour * clock.hourAdena;
const labour = recipe.mpCost / paid.mpPerHour * paid.hourAdena;
assert.strictEqual(labour, 2000, 'declared labour: 20MP at 1MP/second, priced at 100 Adena/second');
assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [exit]), null,
    'without a monetary hour and MP clock labour is unknown, not free');
const found = Policy.opportunityFor(state, recipe, planFor, [exit], undefined, paid);
assert(found, 'funded, complete and profitable basket should be selected');
assert.strictEqual(found.basket.cost, 27000);
assert.deepStrictEqual(found.basket.purchases.map((purchase) => [purchase.selfId, purchase.count, purchase.town]),
    [[1876, 2, 'Giran'], [1881, 1, 'Giran']], 'one purchase per input, in its town');
assert.strictEqual(found.expectedProfit, netProfit(recipe, exit.price, 27000, 0));
assert.strictEqual(found.expectedProfit, 21000, 'the original basket also pays its 2000 labour');
// The trips of the purchases and of the sale are costs of the craft (group C item 7).
trip = 2000;
const landed = Policy.opportunityFor(state, recipe, planFor, [{ ...exit, trip: 3000 }], undefined, paid);
assert.strictEqual(landed.basket.cost, 29000, 'one shared town trip buys both materials');
assert.strictEqual(landed.basket.cashCost, 27000, 'the wallet pays the goods');
assert.strictEqual(landed.expectedProfit, netProfit(recipe, 50000, 29000, 3000), 'and the sale trip plus paid labour');
trip = 0;
const partialStock = Policy.opportunityFor(state, recipe, planFor, [exit], (selfId) => (
    selfId === 1876 ? { count: 1, unitValue: 11000 } : null
), paid);
assert(partialStock, 'the crafter can buy only the missing pieces');
assert.strictEqual(partialStock.basket.cashCost, 16000);
assert.strictEqual(partialStock.basket.cost, 27000,
    'owned materials must still count toward economic cost');
assert.deepStrictEqual(partialStock.basket.purchases.map((purchase) => purchase.count), [1, 1]);
assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, count: 0 }], undefined, paid), null,
    'the output needs a buyer for the full craft yield');
const thin = Policy.opportunityFor(state, recipe, planFor, [{ ...exit, price: 30000 }], undefined, paid);
assert(thin, 'the original 30000 price leaves a positive margin after the declared clock');
assert.strictEqual(thin.expectedProfit, netProfit(recipe, 30000, 27000, 0));
assert.strictEqual(thin.expectedProfit, 1000);
const breakEvenPrice = 27000 + labour;
assert.strictEqual(breakEvenPrice, 29000);
assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, price: breakEvenPrice }], undefined, paid), null,
    'exact zero net profit does not spend the materials');
assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, price: breakEvenPrice - 1 }], undefined, paid), null,
    'a negative net profit does not spend the materials');
assert.strictEqual(Policy.opportunityFor(state, recipe, planFor, [{ ...exit, price: breakEvenPrice + 1 }], undefined, paid).expectedProfit, 1,
    'one Adena above the independent paid break-even is profitable');
const physical = Policy.opportunityFor({ ...state, adena: 100000 }, recipe, planFor, [exit], undefined, paid);
assert(physical, '27000 is physically affordable in the original 100000 wallet; E3 funding is checked separately');
assert.strictEqual(physical.expectedProfit, found.expectedProfit);
assert.strictEqual(Policy.opportunityFor({ ...state, adena: 26999 }, recipe, planFor, [exit], undefined, paid), null,
    'the physical wallet must pay the complete 27000 basket');
assert.strictEqual(Policy.opportunityFor(state, { ...recipe, successRate: 50 }, planFor, [exit], undefined, paid), null,
    'failed crafts must be included in expected profit');
assert.strictEqual(netProfit({ ...recipe, successRate: 50 }, 50000, 27000, 0), -4000,
    '50% yield still pays every input and the same labour');
assert.strictEqual(Policy.opportunityFor(state, recipe, (selfId, missing) => (selfId === 1881 ? null : planFor(selfId, missing)), [exit], undefined, paid), null,
    'every ingredient must be available before the bot starts buying');
assert.strictEqual(Policy.opportunityFor(state, recipe, (selfId, missing) => ({ ...planFor(selfId, missing), whole: false }), [exit], undefined, paid), null,
    'every ingredient must be available in full');
assert.strictEqual(Policy.opportunityFor({ ...state, vitals: { mp: 1 } }, recipe, planFor, [exit], undefined, paid), null,
    'the crafter must have enough MP');

// Separate native funding boundary. The real worker supplies its packet;
// authored Tables/ColdRest supply the hour/MP clock before evaluating margins.
// This tests E3 on the declared unit basket, not native recipe selection or SQL crafting.
Data.init();
const clockState = { characterId: 9105, name: 'NativeCraftFunding', accountName: 'bot_pop_test',
    phase: 'cold', activity: 'hunting', level: 60, exp: Number(Data.experience[59]), adena: 100000,
    updatedAt: NOW, currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 },
    inventory: {}, timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 100, maxMp: 100 },
    persona: { primaryDrive: 'wealth', traits: {} },
    stats: { classId: 57, classProgressionClassId: 57, classProgressionLevel: 60 } };
const mpPerHour = Number(Background.coldRestRegenPerTick(clockState).mp) * 1200;
assert(mpPerHour > 0 && Number.isFinite(mpPerHour), 'authored class and regeneration give a positive MP production clock');
const native = await captureAndRead(clockState, { timestamp: NOW });
const nativeClock = { hourAdena: native.state.stats.money[0], mpPerHour };
const nativeMargin = netProfit(recipe, exit.price, 27000, 0, nativeClock);
const nativeOpportunity = Policy.opportunityFor(native.state, recipe, planFor, [exit], undefined, nativeClock);
if (nativeMargin > 0) {
    assert(nativeOpportunity);
    assert.strictEqual(nativeOpportunity.expectedProfit, nativeMargin, 'native-clock net margin uses the unchanged unit basket');
    const r = nativeMargin / nativeClock.hourAdena / 27000;
    assert.strictEqual(Funding.spendable(native.state, 0, { r }), expectedSpendable(native.state, { r }),
        'the exact gain/cash ratio uses the same genuine native packet');
    if (r < native.state.stats.money[1]) assert.strictEqual(Funding.spendable(native.state, 0, { r }), 0,
        'a gain below the real money floor cannot fund this basket');
    console.log(JSON.stringify({ nativeClock, unitRecipeId: recipe.recipeId, nativeMargin, r,
        allowance: Funding.spendable(native.state, 0, { r }), cash: 27000,
        funded: 27000 <= Funding.spendable(native.state, 0, { r }) }));
} else assert.strictEqual(nativeOpportunity, null, 'a nonpositive native-clock margin is rejected before funding');
// An explicit lower-value gain control uses the real packet floor. It does
// not claim an observed craft/offer and never creates a percentage wallet cap.
const lowGainRatio = native.state.stats.money[1] / 2;
assert.strictEqual(Funding.spendable(native.state, 0, { r: lowGainRatio }), 0,
    'actual E3 refuses a low-value gain even though the original 100000 wallet pays 27000 physically');
assert.deepStrictEqual(Economy.summary().mainColdForState, {}, 'native craft readers do not rebuild on main');
console.log('Wealth craft policy checks passed');
} finally {
    Economy.reset();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
