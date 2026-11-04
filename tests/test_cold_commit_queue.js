process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('assert');
require('../src/Global');
const { ColdCommitQueue } = require('../src/GameServer/Bot/Population/ColdCommitQueue');
const FailureLog = invoke('FailureLog');

function proposal(characterId, priority = 'P2', revision = 1) {
    return {
        proposalId: `p-${characterId}-${revision}`,
        characterId,
        priority,
        enqueuedAt: 0,
        revision,
        baseState: { characterId, phase: 'cold', activity: 'hunting' },
        result: { patch: {}, materialize: { exp: 1, sp: 0, adena: 0, items: [] }, events: [] }
    };
}

(async () => {
    const warnings = [];
    const info = console.info, warn = console.warn;
    const site = 'cold.after_commit', counted = () => FailureLog.snapshot()?.[site] || 0, before = counted();
    const swallowed = () => Object.values(Coordinator.failureSnapshot().swallowed).reduce((sum, n) => sum + n, 0);
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const Status = invoke('GameServer/Bot/Population/PopulationStatus');
    const shownBefore = swallowed();
    const capture = original => (...line) => (line.join(' ').includes(site) ? warnings.push(line.join(' ')) : original(...line));
    console.info = capture(info); console.warn = capture(warn);
    for (const single of [false, true]) {
        const acks = [];
        const committedQueue = new ColdCommitQueue({
            prepare: async entry => entry.baseState,
            commit: async entries => entries.map(entry => ({ ok: true, characterId: entry.nextState.characterId })),
            afterCommit: async () => { throw new Error('journal unavailable after durable commit'); },
            onResults: rows => acks.push(...rows)
        });
        committedQueue.enqueue(proposal(900));
        if (single) await committedQueue.flushCharacter(900);
        else await committedQueue.flushDue(true);
        assert.strictEqual(acks.length, 1);
        assert.strictEqual(acks[0].ok, true, 'post-commit failure cannot reject an already durable outcome');
        assert.match(acks[0].afterCommitError, /journal unavailable/);
        assert.strictEqual(committedQueue.snapshot().errors, 1);
    }
    console.info = info; console.warn = warn;
    // The failure the commit survived: the first logged with its stack, the second only counted,
    // both on the status line beside what the cold worker reports from its side.
    assert.strictEqual(warnings.length, before ? 0 : 1, 'a repeated post-commit failure is logged once');
    if (!before) assert.match(warnings[0], /journal unavailable[\s\S]*ColdCommitQueue/);
    assert.strictEqual(counted() - before, 2, 'each post-commit failure is counted');
    assert.strictEqual(swallowed() - shownBefore, 2);
    const line = () => Number(Status.goalText({}, Coordinator.snapshot()).match(/ swallowed=(\d+)\/\d+ /)[1]);
    const shown = line();
    Coordinator.lastWorkerSnapshot = { failures: { swallowed: { 'route.search': 3 } } };
    assert.strictEqual(line() - shown, 3, 'the worker\'s sites are summed on the line with main\'s');
    Coordinator.lastWorkerSnapshot = {};
    // The shared rule: an owner's refusal code is an outcome, a bug's error is a failure even with a
    // code for a message; the backstop's unnamed sites (one per distinct throw) never crowd out a named one.
    assert.strictEqual(FailureLog.refusal(Error('afk_trade_stock_changed')), true);
    for (const bug of [TypeError('invalid_mutation_admission'), Error('board_revision_exhausted'), Error('Cannot read x')]) {
        assert.strictEqual(FailureLog.refusal(bug), false, bug.message);
    }
    console.warn = console.info = () => {};
    for (let i = 0; i < 5; i++) FailureLog.noteUnnamed('unhandled rejection', `row ${i} refused`);
    const letters = i => String.fromCharCode(97 + i % 26) + String.fromCharCode(97 + Math.floor(i / 26));
    for (let i = 0; i < FailureLog.MAX_SITES + 5; i++) FailureLog.noteUnnamed('unhandled rejection', `thrown ${letters(i)}`);
    FailureLog.note('test.named_after_flood', Error('a named site'));
    console.info = info; console.warn = warn;
    const sites = FailureLog.snapshot();
    assert.strictEqual(sites['unhandled rejection: row # refused'], 5, 'ids in a message do not split a site');
    assert.ok(sites['other unnamed sites'] > 0, 'unnamed sites past their cap share one count');
    assert.strictEqual(sites['test.named_after_flood'], 1, 'a flood of unnamed sites leaves room for a named one');
    const rejectedAcks = [];
    const rejectedQueue = new ColdCommitQueue({ prepare: async () => null, commit: async () => [],
        onResults: rows => rejectedAcks.push(...rows) });
    rejectedQueue.enqueue(proposal(901));
    await rejectedQueue.flushCharacter(901);
    assert.strictEqual(rejectedAcks[0].proposal.characterId, 901, 'handoff rejection must acknowledge the staged raid member');
    for (const stage of ['prepare', 'commit']) {
        const acks = [];
        const broken = new ColdCommitQueue({ prepare: async entry => entry.baseState, commit: async () => [],
            [stage]: async () => { throw Error('synthetic handoff failure'); }, onResults: rows => acks.push(...rows) });
        broken.enqueue(proposal(902));
        await assert.rejects(broken.flushCharacter(902), /synthetic handoff failure/);
        assert.strictEqual(acks[0].ok, false);
        assert.strictEqual(acks[0].proposal.characterId, 902, 'handoff errors also release the raid confirmation fence');
    }
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
            return entries.map((entry) => ({ ok: true, characterId: entry.nextState.characterId, revision: entry.revision + 1 }));
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
    assert.strictEqual(paused, 1, 'high water must pause new cold steps');
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
                entries.forEach(entry => assert.deepStrictEqual(entry.atomicGroup, entry.proposal.atomicGroup || null,
                    'the owner must receive the same atomic group that the queue preserved'));
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
