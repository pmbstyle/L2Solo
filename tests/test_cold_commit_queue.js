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
    assert.strictEqual(await queue.flushDue(), false, 'P2 must wait for a batching deadline or early admission');
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

    function withMemory(id, count, priority, group = null) {
        const entry = proposal(id, priority);
        entry.result.memoryEvents = Array.from({ length: count }, (_, index) => ({
            key: `episode:${id}:${index}`, sourceId: id, targetId: 9999,
            type: 'attacked', at: now
        }));
        if (group) entry.atomicGroup = group;
        return entry;
    }
    for (const priority of ['P0', 'P1', 'P2']) {
        const batches = [], results = [];
        const memoryQueue = new ColdCommitQueue({
            now: () => now,
            prepare: async entry => entry.baseState,
            commit: async entries => {
                const count = entries.reduce((sum, entry) => sum + entry.proposal.result.memoryEvents.length, 0);
                batches.push(entries.map(entry => entry.nextState.characterId));
                if (count > 64) throw new Error('interaction memory: cold transaction event budget exceeded');
                return entries.map(entry => ({ ok: true, characterId: entry.nextState.characterId }));
            },
            onResults: entries => results.push(...entries)
        });
        for (let id = 100; id < 122; id++) memoryQueue.enqueue(withMemory(id, 3, priority));
        await memoryQueue.flushDue(true);
        assert(memoryQueue.size() > 0, 'excess proposals must remain queued');
        while (memoryQueue.size()) await memoryQueue.flushDue(true);
        assert.strictEqual(results.length, 22);
        assert(results.every(result => result.ok), `${priority}: all 22 outcomes must commit`);
        if (priority === 'P2') assert.deepStrictEqual(batches.map(batch => batch.length), [21, 1]);

        batches.length = 0;
        results.length = 0;
        const group = { id: `memory-group-${priority}`, memberIds: [201, 202] };
        memoryQueue.enqueue(withMemory(200, 40, priority));
        memoryQueue.enqueue(withMemory(201, 20, priority, group));
        memoryQueue.enqueue(withMemory(202, 20, priority, group));
        memoryQueue.enqueue(withMemory(203, 24, priority));
        while (memoryQueue.size()) await memoryQueue.flushDue(true);
        assert.deepStrictEqual(batches, [[200], [201, 202, 203]], 'groups stay intact and exactly 64 events fit');
        assert(results.every(result => result.ok));

        batches.length = 0;
        results.length = 0;
        memoryQueue.enqueue(withMemory(200, 1, priority));
        memoryQueue.enqueue(withMemory(201, 33, priority, group));
        memoryQueue.enqueue(withMemory(202, 33, priority, group));
        memoryQueue.enqueue(withMemory(203, 1, priority));
        while (memoryQueue.size()) await memoryQueue.flushDue(true);
        assert.deepStrictEqual(batches, [[200], [201, 202], [203]], 'oversized groups must fail alone, without blocking neighbours');
        assert.deepStrictEqual(results.filter(result => result.ok).map(result => result.characterId), [200, 203]);
        assert.strictEqual(memoryQueue.bytes, 0);
    }

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

    let clock = 1000;
    const measured = new ColdCommitQueue({
        now: () => clock,
        prepare: async entry => { clock += 3; return entry.baseState; },
        commit: async entries => {
            clock += 7;
            return entries.map(entry => ({ ok: true, characterId: entry.nextState.characterId }));
        },
        afterCommit: async () => { clock += 11; }
    });
    measured.enqueue(proposal(70));
    clock = 1499;
    assert.strictEqual(await measured.flushDue(), false);
    clock = 1500;
    assert.strictEqual(await measured.flushDue(), true, 'the P2 fairness deadline must flush at 500 ms, before the 2 second target');
    const timing = measured.snapshot();
    assert.strictEqual(timing.queueP95Ms, 500, 'queue wait ends before preparation begins');
    assert.strictEqual(timing.commitP95Ms, 21, 'legacy commit timing includes preparation, commit callback and after-commit work');
    assert.deepStrictEqual(timing.stages.prepare, { count: 1, p95Ms: 3 });
    assert.deepStrictEqual(timing.stages.commitCall, { count: 1, p95Ms: 7 });
    assert.deepStrictEqual(timing.stages.afterCommit, { count: 1, p95Ms: 11 });
    assert.deepStrictEqual(timing.flushReasons, { p2_overdue: 1 });
    assert.strictEqual(earlyQueue.snapshot().earlyDenied, 1);
    assert.strictEqual(earlyQueue.snapshot().earlyEmpty, 1, 'admission without room for an atomic group must be visible');
    assert.strictEqual(earlyQueue.snapshot().flushReasons.capacity, 2);

    console.log('Cold commit queue coalescing, durability, backpressure, early budget, and retry checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
