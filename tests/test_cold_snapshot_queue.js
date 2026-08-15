const assert = require('assert');
const { ColdSnapshotQueue } = require('../src/GameServer/Bot/Population/ColdSnapshotQueue');

let now = 1000;
const queue = new ColdSnapshotQueue({
    now: () => now,
    pageSize: 48,
    playerPageSize: 32,
    maxDeferralMs: 5000,
    lagThrottleMs: 40,
    lagAbortMs: 120
});

for (let id = 1; id <= 40; id++) {
    assert.strictEqual(queue.mark({ characterId: id, revision: 1 }).ok, true);
}
const first = queue.mark({ characterId: 1, revision: 2 }, { reason: 'resolve' });
assert.strictEqual(first.coalesced, true, 'same character must coalesce to the newest state');
assert.strictEqual(queue.snapshot().dirty, 40);

const playerPlan = queue.takeNormal({ player: true, lagMs: 0 });
assert.strictEqual(playerPlan.entries.length, 32, 'player pressure must use a bounded 32-row page');
assert.strictEqual(playerPlan.pageSize, 32);
assert.strictEqual(playerPlan.entries[0].state.revision, 2, 'coalescing must retain the newest state');

const oldEntry = playerPlan.entries[0];
queue.mark({ characterId: oldEntry.characterId, revision: 3 }, { reason: 'death', critical: true });
assert.strictEqual(queue.complete(oldEntry), false, 'a newer revision must survive completion of an older send');
assert.strictEqual(queue.snapshot().dirty, 40);

const critical = queue.takeCritical(32);
assert.strictEqual(critical.length, 1);
assert.strictEqual(critical[0].state.revision, 3);
assert.strictEqual(queue.restoreCritical(critical[0]), true);
assert.strictEqual(queue.takeCritical(32).length, 1, 'failed P0 delivery must be retryable');

now += 1000;
const deferred = queue.takeNormal({ player: true, lagMs: 121 });
assert.strictEqual(deferred.deferred, true, 'high main-loop lag must defer ordinary snapshots');
now += 5000;
const forced = queue.takeNormal({ player: true, lagMs: 121 });
assert.strictEqual(forced.deferred, false, 'max deferral must preserve cold progress');
assert(forced.entries.length > 0 && forced.entries.length <= 32);

console.log('Cold snapshot dirty coalescing, P0 retry, pressure backoff, and bounded progress checks passed');
