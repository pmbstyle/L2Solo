const assert = require('node:assert/strict');
require('../src/Global');
const Hot = invoke('GameServer/Bot/Economy/HotBoardReviewService');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Events = invoke('GameServer/Bot/Economy/BoardReviewEvents');
assert.equal(Hot.probeSafety, undefined);
assert.equal(Hot.repairSafety, undefined);
assert.equal(Hot.counterChanged, undefined);
assert.equal(Metrics.recordHotSafetyTotal, undefined);
const queue = new Events({ board: { ownerLines: () => [] } });
for (const name of ['edgeOf', 'acceptSafetyEdge', 'lastAcceptedEdge', 'coverageVersion', 'resetBoardCoverage']) {
    assert.equal(queue[name], undefined);
}
assert.equal(Metrics.counters.boardReviewWakeups, 0);
console.log('PASS hot counter coverage and its repair path are retired');
