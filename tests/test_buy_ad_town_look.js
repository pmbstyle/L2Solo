const assert = require('assert');

require('../src/Global');
process.env.L2NODE_PROGRESSION_RATE = 'x10';
invoke('GameServer/DataCache').init();
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const { BUY, SELL } = require('../src/GameServer/AfkTrade/BoardIndex');

// E90: a buy ad nobody answers never moves while no deal happens. A town look
// counts as one pass of the ad, only for a buy line that was not filled.
const line = (storeType, fills = 0) => ({ storeType, fills, selfId: 1463, price: 20,
    pricing: { price: 20, seenCounter: 7, seenItem: 7, rival: 0, worth: 100, seenFills: 0 } });
const belief = { mu: Math.log(20), K: 3 };
const at = Date.now();
const quiet = { timestamp: at };
const seen = { timestamp: at, visit: true };
const count = (observations) => observations.reduce((sum, row) => sum + row[1], 0);

assert.strictEqual(count(PriceBelief.lineObservations(line(BUY), belief, quiet)), 0, 'no deal, no visit: no evidence');
const afterVisit = PriceBelief.lineObservations(line(BUY), belief, seen);
assert.strictEqual(count(afterVisit), 1, 'a visit with nothing sold is one pass');
assert(afterVisit[0][0] > Math.log(20), 'the evidence says the market is above the bid');
assert(PriceBelief.lineObservations(line(BUY, 1), belief, seen).every(row => row[0] <= Math.log(20)),
    'a filled ad gets no pass from the visit');
assert.strictEqual(PriceBelief.lineObservations(line(SELL), belief, seen)
    .reduce((sum, row) => sum + row[1], 0), 0, 'an ask is not changed by a visit');

// A finished market visit stamps the state: the count of the town looks.
const state = { characterId: 1, activity: 'shopping', stats: {}, timing: {}, loc: { x: 0, y: 0, z: 0 } };
const done = GoalExecutor.finishMarketVisit(state, at, { recoverMissingReturn: true });
if (done) {
    assert.strictEqual(done.stats.townLook.n, 1);
    assert.strictEqual(done.stats.townLook.at, at);
    const again = GoalExecutor.finishMarketVisit({ ...done, activity: 'shopping' }, at + 1, { recoverMissingReturn: true });
    if (again) assert.strictEqual(again.stats.townLook.n, 2);
}
assert.strictEqual(GoalExecutor.finishMarketVisit({ ...state, activity: 'hunting' }, at), null);

console.log('buy ad town look passed');
process.exit(0);
