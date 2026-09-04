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

    const groupedBatches = [];
    const groupedQueue = new ColdCommitQueue({
        now: () => now,
        maxRows: 3,
        prepare: async (entry) => entry.baseState,
        commit: async (entries) => {
            groupedBatches.push(entries.map((entry) => Number(entry.nextState.characterId)));
            return entries.map((entry) => ({ ok: true, characterId: entry.nextState.characterId }));
        }
    });
    const atomicGroup = { id: 'party-queue-group', memberIds: [31, 32, 33] };
    groupedQueue.enqueue(proposal(30, 'P1'));
    [31, 32, 33].forEach((characterId) => groupedQueue.enqueue({
        ...proposal(characterId, 'P1'),
        atomicGroup
    }));
    await groupedQueue.flushDue(true);
    await groupedQueue.flushDue(true);
    assert.deepStrictEqual(groupedBatches[0], [30], 'a full party group must not be split by the preceding batch entries');
    assert.deepStrictEqual(groupedBatches[1].sort((a, b) => a - b), [31, 32, 33],
        'all members of an atomic party commit must be flushed together');

    let allowed = false;
    let admissions = 0;
    const completedLeases = [];
    const earlyQueue = new ColdCommitQueue({
        now: () => now,
        prepare: async (entry) => entry.baseState,
        commit: async (entries) => {
            now += 7;
            return entries.map((entry) => ({ ok: true, characterId: entry.nextState.characterId }));
        },
        admitEarlyFlush: () => { admissions++; return allowed ? { id: 1 } : null; },
        completeEarlyFlush: (lease, duration) => completedLeases.push({ lease, duration })
    });
    earlyQueue.enqueue(proposal(40));
    assert.strictEqual(await earlyQueue.flushDue(), false);
    assert.strictEqual(admissions, 0, 'ordinary work must retain its batching delay');
    earlyQueue.capacityBlocked = true;
    assert.strictEqual(await earlyQueue.flushDue(), false, 'a denied budget cannot flush early');
    allowed = true;
    assert.strictEqual(await earlyQueue.flushDue(), false, 'admission retries must be rate limited');
    now += 100;
    assert.strictEqual(await earlyQueue.flushDue(), true, 'a blocked worker can progress with an admitted budget');
    assert.deepStrictEqual(completedLeases, [{ lease: { id: 1 }, duration: 7 }]);
    assert.strictEqual(earlyQueue.capacityBlocked, false);
    earlyQueue.enqueue(proposal(41, 'P0'));
    allowed = false;
    assert.strictEqual(await earlyQueue.flushDue(), true, 'durability priority must not depend on opportunistic admission');
    assert.strictEqual(admissions, 2);
    allowed = true;
    now += 100;
    for (let id = 50; id < 58; id++) earlyQueue.enqueue(proposal(id));
    earlyQueue.capacityBlocked = true;
    assert.strictEqual(await earlyQueue.flushDue(), true);
    assert.strictEqual(earlyQueue.size(), 6, 'early commits must free a small number of slots per budget');
    await earlyQueue.flushDue(true);
    now += 100;
    [61, 62, 63].forEach(id => earlyQueue.enqueue({ ...proposal(id, 'P1'),
        atomicGroup: { id: 'early-party', memberIds: [61, 62, 63] } }));
    earlyQueue.capacityBlocked = true;
    assert.strictEqual(await earlyQueue.flushDue(), false, 'a party larger than the early budget must wait intact');
    assert.strictEqual(earlyQueue.size(), 3);
    assert.strictEqual(await earlyQueue.flushDue(true), true);

    console.log('Cold commit queue coalescing, durability, backpressure, early budget, and retry checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
