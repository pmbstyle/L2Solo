const assert = require('assert');
const { ColdCommitQueue } = require('../src/GameServer/Bot/Population/ColdCommitQueue');

function proposal(characterId, priority = 'P2', revision = 1) {
    return {
        proposalId: `p-${characterId}-${revision}`,
        characterId,
        priority,
        enqueuedAt: 0,
        token: {
            ok: true,
            characterId,
            ownerId: 'cold_simulation_owner',
            revision,
            leaseId: `lease-${characterId}-${revision}`,
            leaseUntil: 30000
        },
        baseState: { characterId, phase: 'cold', activity: 'hunting' },
        result: { patch: {}, materialize: { exp: 1, sp: 0, adena: 0, items: [] }, events: [] }
    };
}

(async () => {
    let now = 1000;
    let commits = 0;
    const resultBatches = [];
    const queue = new ColdCommitQueue({
        now: () => now,
        targetMs: 2000,
        hardMs: 5000,
        maxEntries: 8,
        prepare: async (entry) => ({ ...entry.baseState, activity: entry.result.patch.activity || 'hunting' }),
        commit: async (entries) => {
            commits += 1;
            return entries.map((entry) => ({ ok: true, characterId: entry.nextState.characterId, revision: entry.token.revision + 1 }));
        },
        onResults: (results) => resultBatches.push(results)
    });
    assert.strictEqual(queue.enqueue(proposal(1)).ok, true);
    assert.strictEqual(queue.enqueue({ ...proposal(1), result: { ...proposal(1).result, patch: { activity: 'resting' } } }).ok, true);
    assert.strictEqual(queue.snapshot().coalesced, 1);
    assert.strictEqual(queue.snapshot().depth, 1);
    assert.strictEqual(await queue.flushDue(), false, 'P2 must not flush before its 2 second target');
    now += 2000;
    assert.strictEqual(await queue.flushDue(), true);
    assert.strictEqual(commits, 1);
    assert.strictEqual(resultBatches[0][0].nextState.activity, 'resting', 'latest ordinary snapshot must win coalescing');

    assert.strictEqual(queue.enqueue(proposal(2, 'P2', 1)).ok, true);
    assert.strictEqual(queue.enqueue(proposal(2, 'P2', 2)).reason, 'coalesce_boundary', 'revision boundary must never be coalesced');
    await queue.flushDue(true);

    let paused = 0;
    let resumed = 0;
    const pressureQueue = new ColdCommitQueue({
        now: () => now,
        maxEntries: 4,
        prepare: async (entry) => entry.baseState,
        commit: async (entries) => entries.map((entry) => ({ ok: true, characterId: entry.nextState.characterId })),
        onPause: () => { paused += 1; },
        onResume: () => { resumed += 1; }
    });
    for (let id = 10; id < 14; id++) pressureQueue.enqueue(proposal(id, 'P1'));
    assert.strictEqual(paused, 1, 'high water must pause new cold claims');
    await pressureQueue.flushDue(true);
    await pressureQueue.flushDue(true);
    assert.strictEqual(resumed, 1, 'queue must resume below low water');

    let attempts = 0;
    const retryQueue = new ColdCommitQueue({
        now: () => now,
        prepare: async (entry) => entry.baseState,
        commit: async (entries) => {
            attempts += 1;
            if (attempts < 3) throw new Error('SQLITE_BUSY: database is locked');
            return entries.map((entry) => ({ ok: true, characterId: entry.nextState.characterId }));
        }
    });
    retryQueue.enqueue(proposal(20, 'P0'));
    await retryQueue.flushDue(true);
    assert.strictEqual(attempts, 3);
    assert.strictEqual(retryQueue.snapshot().retries, 2);

    console.log('Cold commit queue coalescing, durability boundary, backpressure, and retry checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
