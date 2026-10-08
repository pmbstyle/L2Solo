const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
// A fixed test curve isolates context wiring; actual ON grade learning is
// covered by test_n79_learning_startup with the production helper.
const originalInvoke = global.invoke;
const errorCalls = [];
global.invoke = (name) => name === 'GameServer/Bot/Economy/PriceLearning'
    ? { knowledgeEnabled: () => true, errorOf: (understanding, deals, counter) => {
        errorCalls.push({ understanding, deals, counter });
        return (0.03 + 0.17 * (1 - understanding)) * 0.5 ** (deals / 3);
    } }
    : originalInvoke(name);
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
global.invoke = originalInvoke;
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const TendencyRoll = invoke('GameServer/Bot/AI/TendencyRoll');
const { SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');

// Unknown template isolates the five public price sources from craft value.
const ITEM = 999999;
const OTHER = 999998;
const now = 1800000000000;
const original = {
    itemPriceEvidence: MarketCounters.itemPriceEvidence,
    counter: MarketCounters.counter,
    counterOf: MarketCounters.counterOf,
    firstPrice: MarketCounters.firstPrice,
    recipes: C4RecipeItems.loadRecipeItems
};
let recent = [800, 1000, 1200];
let ask = 1100;
let bid = 900;
// Public deal evidence is prepared by MarketCounters; this fixture isolates
// the prior's unchanged weights and personal inputs from that preparation.
MarketCounters.itemPriceEvidence = () => ({
    logMedian: recent.length ? Math.log(recent[Math.floor(recent.length / 2)]) : null,
    deals: recent.length ? 5 : 0
});
MarketCounters.counter = () => ({ index: Math.log(1.2), deals: 5 });
MarketCounters.counterOf = (selfId) => Number(selfId) === OTHER ? 'gear d' : 'material none';
MarketCounters.firstPrice = () => 500;
const ctx = (extra = {}) => ({
    characterId: 43, understanding: 0.5, timestamp: now,
    marketTrades: {}, knowledgeEnabled: true,
    board: { first: (selfId, side) => ({ price: side === SELL ? ask : side === BUY ? bid : 0 }) },
    ...extra
});
const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} vs ${expected}`);
const failures = [];
function contract(name, check) {
    try {
        check();
        console.log(`PASS ${name}`);
    }
    catch (error) {
        failures.push(name);
        console.error(`FAIL ${name}: ${error.message}`);
    }
}

try {
    contract('public source weights and log-normal width stay', () => {
        const prior = PriceBelief.prior(ITEM, ctx({ knowledgeEnabled: false }));
        const weight = 5 + 1 + 1 + 0.5 + 0.3;
        const unbiased = (5 * Math.log(1000) + Math.log(1100) + Math.log(900)
            + 0.5 * Math.log(600) + 0.3 * Math.log(500)) / weight;
        near(prior.K, weight, 'unchanged source weights');
        near(PriceBelief.sigma({ K: prior.K }), 0.6 / Math.sqrt(1 + weight), 'unchanged width');
        near(prior.mu, unbiased, 'exact public centre without personal error');
    });

    contract('personal error is an exact stable fractional multiplier', () => {
        const prior = PriceBelief.prior(ITEM, ctx());
        const fraction = (2 * TendencyRoll.roll('n45e', 43, ITEM) - 1) * PriceBelief.errorOf(0.5, 0);
        const weight = 7.8;
        const unbiased = (5 * Math.log(1000) + Math.log(1100) + Math.log(900)
            + 0.5 * Math.log(600) + 0.3 * Math.log(500)) / weight;
        near(prior.bias, fraction, 'stable pair signed fraction');
        near(Math.exp(prior.mu - unbiased), 1 + fraction, 'price times 1 + fraction');
        const later = PriceBelief.prior(ITEM, ctx({ timestamp: now + 86400000 }));
        near(later.bias, fraction, 'clock never rerolls personal error');
    });

    contract('own counter experience reaches shared helper, unrelated counter does not', () => {
        const novice = PriceBelief.prior(ITEM, ctx());
        const experienced = PriceBelief.prior(ITEM, ctx({ marketTrades: { 'material none': 3 } }));
        near(experienced.bias / novice.bias, 0.5, 'test helper counter experience changes magnitude');
        assert.deepStrictEqual(errorCalls.at(-1), { understanding: 0.5, deals: 3, counter: 'material none' });
        const unrelated = PriceBelief.prior(ITEM, ctx({ marketTrades: { 'gear d': 300 } }));
        near(unrelated.bias, novice.bias, 'other counter deals do not teach this item');
    });

    contract('knowledge disabled keeps public pricing without personal error', () => {
        const calls = errorCalls.length;
        const off = PriceBelief.prior(ITEM, ctx({ knowledgeEnabled: false, marketTrades: { 'material none': 300 } }));
        near(off.bias, 0, 'disabled knowledge has no personal bias');
        recent = [1600, 2000, 2400];
        ask = 2200;
        bid = 1800;
        const moved = PriceBelief.prior(ITEM, ctx({ knowledgeEnabled: false }));
        assert(moved.mu > off.mu, 'disabled knowledge still follows a changed board');
        assert.strictEqual(errorCalls.length, calls, 'disabled knowledge does not request a personal learning curve');
    });

    contract('prepared owner craft value keeps its sixth-source weight; unsupported speculation is unknown', () => {
        C4RecipeItems.loadRecipeItems = () => { throw Error('prior must not scan the recipe catalogue'); };
        PriceBelief.resetCaches();
        assert.strictEqual(PriceBelief.demandValue(ITEM, now), null, 'legacy owner-blind cache is unavailable');
        const prepared = ctx({ knowledgeEnabled: false,
            derivedDemandValue: { known: true, value: 2000, ownerId: 43 } });
        const crafted = PriceBelief.prior(ITEM, prepared);
        near(PriceBelief.demandValue(ITEM, prepared), 2000, 'completed finite owner route supplies its scalar');
        near(crafted.K, 8.1, 'prepared craft adds weight 0.3');
        const unbiased = (5 * Math.log(2000) + Math.log(2200) + Math.log(1800)
            + 0.5 * Math.log(600) + 0.3 * Math.log(500) + 0.3 * Math.log(2000)) / 8.1;
        near(crafted.mu, unbiased, 'supported prepared source retains weighted log centre');
        assert.strictEqual(PriceBelief.demandValue(ITEM, ctx({ derivedDemandValue: 2000 })), null,
            'a bare unqualified value is not a supported owner calculation');
        assert.strictEqual(PriceBelief.demandValue(ITEM, ctx({ derivedDemandValue: { known: true, value: 2000, ownerId: 44 } })), null);
        const unknown = PriceBelief.prior(ITEM, ctx({ knowledgeEnabled: false,
            derivedDemandValue: { known: false, value: 2000 } }));
        near(unknown.K, 7.8, 'unknown preparation contributes no speculative willingness');
    });
}
finally {
    for (const key of ['itemPriceEvidence', 'counter', 'counterOf', 'firstPrice']) MarketCounters[key] = original[key];
    C4RecipeItems.loadRecipeItems = original.recipes;
    PriceBelief.resetCaches();
}
if (failures.length) {
    console.error(`N79 prior contracts: ${failures.length} failed (${failures.join('; ')})`);
    process.exitCode = 1;
}
else console.log('N79 prior contracts passed');
