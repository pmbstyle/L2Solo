const assert = require('assert');

require('../src/Global');

const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');

const state = {
    characterId: 7,
    name: 'Traveler',
    activity: 'hunting',
    currentRegion: 'Dion',
    loc: { locX: 15631, locY: 142885, locZ: -2704 },
    stats: {},
    vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 }
};
const goal = { type: 'upgrade_gear', plan: { expectedBenefit: 'market_search_for_weapon' } };
const started = GoalExecutor.beginMarketTravel(state, goal, Date.now());
assert.strictEqual(started.activity, 'traveling');
assert.strictEqual(started.stats.travel.townName, 'Giran');

const sellStarted = GoalExecutor.beginMarketTravel({ ...state, activity: 'hunting', stats: {} }, {
    type: 'sell_inventory',
    plan: { expectedBenefit: 'market_sale_inventory' }
}, Date.now());
assert.strictEqual(sellStarted.stats.travel.reason, 'market_sale_inventory');

const midway = BackgroundResolver.resolveSolo({ state: started, spot: null, elapsedMs: 30000 });
assert.strictEqual(midway.patch.activity, 'traveling');
assert.strictEqual(midway.materialize.exp, 0);

const arrivedState = { ...started, stats: { ...started.stats, travel: { ...started.stats.travel, arrivalAt: Date.now() - 1, startedAt: Date.now() - 1000 } } };
const arrived = BackgroundResolver.resolveSolo({ state: arrivedState, spot: null });
assert.strictEqual(arrived.patch.activity, 'shopping');
assert.strictEqual(arrived.events[0].type, 'arrived_town');

const shoppingState = {
    ...arrivedState,
    activity: 'shopping',
    currentRegion: 'Giran',
    loc: { ...started.stats.travel.to },
    stats: { ...started.stats, travel: null }
};
const returning = GoalExecutor.finishMarketVisit(shoppingState, Date.now());
assert.strictEqual(returning.activity, 'traveling');
assert.strictEqual(returning.stats.travel.reason, 'return_after_market');
assert.strictEqual(returning.stats.travel.arrivalActivity, 'hunting');

const returnedState = {
    ...returning,
    stats: {
        ...returning.stats,
        travel: { ...returning.stats.travel, arrivalAt: Date.now() - 1, startedAt: Date.now() - 1000 }
    }
};
const returned = BackgroundResolver.resolveSolo({ state: returnedState, spot: null });
assert.strictEqual(returned.patch.activity, 'hunting');
assert.strictEqual(returned.patch.currentRegion, 'Dion');
assert.strictEqual(returned.patch.stats.marketReturn, null);
assert.strictEqual(returned.events[0].type, 'returned_to_spot');

console.log('Bot cold travel checks passed');
