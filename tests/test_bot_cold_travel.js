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

const midway = BackgroundResolver.resolveSolo({ state: started, spot: null, elapsedMs: 30000 });
assert.strictEqual(midway.patch.activity, 'traveling');
assert.strictEqual(midway.materialize.exp, 0);

const arrivedState = { ...started, stats: { ...started.stats, travel: { ...started.stats.travel, arrivalAt: Date.now() - 1, startedAt: Date.now() - 1000 } } };
const arrived = BackgroundResolver.resolveSolo({ state: arrivedState, spot: null });
assert.strictEqual(arrived.patch.activity, 'shopping');
assert.strictEqual(arrived.events[0].type, 'arrived_town');

console.log('Bot cold travel checks passed');
