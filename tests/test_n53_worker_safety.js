const assert = require('assert');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const PERIOD = 30 * 60000;
const failures = [];
async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}
function harness(options = {}) {
    let now = 1000000;
    const bornAt = now, messages = [], pages = [];
    const kernel = new ColdSimulationKernel({ now: () => now, resolveSolo: () => ({}),
        emit: (type, payload, msgId) => messages.push({ type, payload, msgId }), ...options });
    kernel.pause();
    const row = id => ({ state: { characterId: id, phase: 'cold', activity: 'hunting', stats: {}, inventory: {},
        timing: { nextResolveAt: now + 10 * PERIOD }, simulation: { ownerId: 'legacy_main', revision: 1 } },
        context: { spot: { id: 'spot' } } });
    const add = id => kernel.upsert(row(id));
    const watch = (visit = () => {}) => {
        if (typeof kernel.states.inspectSafetyPage === 'function') {
            const inspect = kernel.states.inspectSafetyPage.bind(kernel.states);
            kernel.states.inspectSafetyPage = (limit, callback) => {
                const page = []; pages.push(page);
                return inspect(limit, id => { page.push(id); visit(id); callback(id); });
            };
        } else {
            // Observe the actual old iterator for a meaningful full-scan RED.
            const entries = kernel.states.entries.bind(kernel.states);
            kernel.states.entries = function* () {
                const page = []; pages.push(page);
                for (const entry of entries()) { page.push(entry[0]); visit(entry[0]); yield entry; }
            };
        }
    };
    const alarm = () => [...kernel.alarms.values()].filter(entry => entry.alarmKind === 'worker_safety');
    const drop = id => {
        const entry = kernel.heap.values.find(item => item.kind !== 'alarm' && item.characterId === id);
        assert(entry); assert(kernel.heap.remove(entry)); kernel.consumeHeapEntry(entry);
        assert.strictEqual(kernel.scheduleTokens.has(id), false);
    };
    return { kernel, bornAt, messages, pages, row, add, watch, alarm, drop,
        now: () => now, advance: ms => { now += ms; }, tick: () => kernel.tick() };
}
function finish(h) {
    let steps = 0;
    while (h.kernel.safetyStartedAt !== null) {
        assert(++steps <= 100, 'cycle terminates without append-churn extension'); h.tick();
    }
}

(async () => {
    await check('thirty-minute default/minimum and one attached same-heap alarm', () => {
        const h = harness({ orphanSweepIntervalMs: 1000 });
        assert.strictEqual(h.kernel.orphanSweepIntervalMs, PERIOD);
        assert.strictEqual(h.alarm().length, 1);
        assert.strictEqual(h.alarm()[0].dueAt, h.bornAt + PERIOD);
        assert.strictEqual(h.kernel.heap.peek(), h.alarm()[0]);
        assert.strictEqual(h.kernel.operationalAlarms.size, 1);
        h.add(1); h.watch(); h.tick(); h.advance(PERIOD - 1); h.tick();
        assert.deepStrictEqual(h.pages, [], 'no startup/population safety bootstrap before the deadline');
        assert.strictEqual(h.kernel.lastOrphanSweepAt, 0);
    });

    await check('two hundred healthy rows are inspected in bounded pages exactly once', () => {
        const h = harness(); for (let id = 1; id <= 200; id++) h.add(id);
        h.watch(); h.advance(PERIOD); h.tick();
        assert.strictEqual(h.pages[0].length, 64, 'inspection budget applies to healthy rows, not repairs');
        finish(h);
        assert.deepStrictEqual(h.pages.map(page => page.length), [64, 64, 64, 8]);
        assert.strictEqual(new Set(h.pages.flat()).size, 200);
        assert.strictEqual(h.kernel.stats.orphanRecoveries, 0);
        assert.strictEqual(h.alarm().length, 1);
        assert.strictEqual(h.alarm()[0].dueAt, h.bornAt + 2 * PERIOD);
    });

    await check('exact safety cancellation stays idle until explicit rearm and stale cancel is inert', () => {
        const h = harness(); h.add(1); h.watch();
        const token = h.alarm()[0].alarmToken;
        assert.strictEqual(h.kernel.cancelAlarm('worker_safety', 0, token), true);
        h.advance(2 * PERIOD); h.tick();
        assert.deepStrictEqual(h.pages, []);
        assert.strictEqual(h.kernel.safetyStartedAt, null);
        const replacement = h.kernel.armSafetyCycle(h.now() + PERIOD);
        assert.notStrictEqual(replacement, token);
        assert.strictEqual(h.kernel.cancelAlarm('worker_safety', 0, token), false);
        assert.strictEqual(h.alarm().length, 1);
        h.advance(PERIOD); h.tick();
        assert.deepStrictEqual(h.pages.flat(), [1]);
    });

    await check('healthy pages avoid all-population iterators and classification callbacks', () => {
        const h = harness(); for (let id = 1; id <= 200; id++) h.add(id);
        h.watch();
        for (const name of ['entries', 'values', 'keys', Symbol.iterator]) h.kernel.states[name] = () => {
            throw new Error('all-population iteration forbidden');
        };
        for (let id = 1; id <= 200; id++) Object.defineProperty(h.kernel.states.get(id).state, 'inventory', {
            get() { throw new Error('healthy safety classification forbidden'); }
        });
        h.advance(PERIOD); h.tick(); finish(h);
        assert.strictEqual(h.pages.flat().length, 200);
        assert.strictEqual(h.kernel.stats.orphanRecoveries, 0);
    });

    await check('retained membership survives refresh/remove/reinsert/append churn', () => {
        const h = harness(); for (let id = 1; id <= 200; id++) h.add(id);
        const tail = h.kernel.states.safetyNodes.get(200), sequence = tail.sequence;
        for (let count = 0; count < 100; count++) h.add(200);
        assert.strictEqual(h.kernel.states.safetyNodes.get(200), tail);
        assert.strictEqual(tail.sequence, sequence);
        h.watch(); h.advance(PERIOD); h.tick();
        h.kernel.remove(64); h.kernel.remove(65); h.kernel.remove(200);
        h.kernel.remove(150); h.add(150);
        for (let id = 1001; id <= 1200; id++) h.add(id);
        while (h.kernel.safetyStartedAt !== null) {
            h.add(199); h.add(2001); h.kernel.remove(2001); h.tick();
        }
        const seen = h.pages.flat();
        assert.strictEqual(new Set(seen).size, seen.length);
        for (let id = 1; id <= 200; id++) if (![64, 65, 150, 200].includes(id)) assert(seen.includes(id), `retained ${id}`);
        assert(!seen.includes(150)); assert(!seen.some(id => id >= 1001));
        assert(h.pages.every(page => page.length <= 64));
        assert.strictEqual(h.kernel.states.safetyNodes.size, h.kernel.states.size);
        h.advance(PERIOD); h.tick(); finish(h);
        assert(h.pages.flat().includes(150)); assert(h.pages.flat().includes(1001));
    });

    await check('delete-current/next/tail and all-delete cannot strand or resurrect cursor', () => {
        const h = harness({ orphanRecoveryLimit: 2 }); for (let id = 1; id <= 8; id++) h.add(id);
        h.watch(id => { if (id === 1) { h.kernel.remove(1); h.kernel.remove(2); h.kernel.remove(8); } });
        h.advance(PERIOD); h.tick(); finish(h);
        assert.deepStrictEqual(h.pages.flat(), [1, 3, 4, 5, 6, 7]);
        assert.strictEqual(h.kernel.states.safetyNodes.size, 5);
        const empty = harness({ orphanRecoveryLimit: 2 }); for (let id = 1; id <= 8; id++) empty.add(id);
        empty.watch(id => { if (id === 1) for (let removed = 1; removed <= 8; removed++) empty.kernel.remove(removed); });
        empty.advance(PERIOD); empty.tick();
        assert.deepStrictEqual(empty.pages.flat(), [1]);
        assert.strictEqual(empty.kernel.safetyStartedAt, null);
        assert.strictEqual(empty.kernel.states.safetyCursor, null);
        empty.add(99); empty.advance(PERIOD); empty.tick();
        assert(empty.pages.flat().includes(99));
    });

    await check('actual dropped scheduler edge is repaired once and a repeated cycle adds zero', () => {
        const h = harness(); for (let id = 1; id <= 200; id++) h.add(id);
        h.drop(190); h.watch(); h.advance(PERIOD); h.tick(); finish(h);
        assert.strictEqual(h.kernel.scheduleTokens.has(190), true);
        assert.strictEqual(h.kernel.stats.orphanRecoveries, 1);
        h.advance(PERIOD); h.tick(); finish(h);
        assert.strictEqual(h.kernel.stats.orphanRecoveries, 1);
        assert.strictEqual(h.messages.some(message => message.type === 'claim_request'), false);
    });

    await check('full-capacity pending claim and pause retain coverage while an uncovered row repairs', () => {
        const h = harness({ maxInFlight: 1, orphanRecoveryLimit: 2 });
        for (let id = 1; id <= 4; id++) h.add(id);
        h.advance(PERIOD - 1000); h.kernel.resume();
        h.kernel.upsert({ ...h.row(1), state: { ...h.row(1).state, timing: { nextResolveAt: h.now() } } });
        h.tick(); assert.strictEqual(h.kernel.claiming.size, 1);
        h.kernel.pause(); h.drop(2); h.watch(); h.advance(1000); h.tick();
        assert.strictEqual(h.kernel.claiming.has(1), true);
        assert.strictEqual(h.kernel.stats.orphanRecoveries, 1);
        assert.strictEqual(h.kernel.scheduleTokens.has(2), true);
        assert.strictEqual(h.kernel.paused, true);
        h.kernel.resume(); h.tick(); finish(h);
        assert.deepStrictEqual(h.pages.flat(), [1, 2, 3, 4]);
        assert.strictEqual(h.messages.filter(message => message.type === 'claim_request').length, 1);
        assert.strictEqual(h.kernel.stats.orphanRecoveries, 1);
    });

    await check('cadence is start-to-start without overlapping cycles or a delayed catchup burst', () => {
        const h = harness({ orphanRecoveryLimit: 1 }); for (let id = 1; id <= 3; id++) h.add(id);
        h.watch(); const firstToken = h.alarm()[0].alarmToken;
        h.advance(PERIOD); h.tick();
        assert.strictEqual(h.kernel.lastOrphanSweepAt, h.bornAt + PERIOD);
        assert.strictEqual(h.alarm().length, 0);
        h.advance(3 * PERIOD); h.tick(); h.tick();
        assert.strictEqual(h.kernel.lastOrphanSweepAt, h.bornAt + PERIOD);
        assert.strictEqual(h.alarm().length, 1);
        assert.strictEqual(h.alarm()[0].dueAt, h.bornAt + 2 * PERIOD);
        assert.strictEqual(h.kernel.cancelAlarm('worker_safety', 0, firstToken), false);
        h.tick();
        assert.strictEqual(h.kernel.lastOrphanSweepAt, h.now());
        assert.deepStrictEqual(h.pages.map(page => page.length), [1, 1, 1, 1]);
        finish(h);
        assert.strictEqual(h.alarm().length, 1);
        assert.strictEqual(h.alarm()[0].dueAt, h.now() + PERIOD);
        const count = h.pages.length; h.tick(); assert.strictEqual(h.pages.length, count);
    });

    await check('clear/shutdown/reset cancel old cursor and keep new epoch membership authoritative', async () => {
        const h = harness({ orphanRecoveryLimit: 2 }); for (let id = 1; id <= 8; id++) h.add(id);
        h.watch(); h.advance(PERIOD); h.tick();
        h.kernel.states.clear(); h.add(99); h.tick();
        assert.deepStrictEqual(h.pages.flat(), [1, 2]);
        assert.strictEqual(h.kernel.states.safetyNodes.size, 1);
        assert.strictEqual(h.kernel.safetyStartedAt, null);
        h.advance(PERIOD); h.tick(); assert(h.pages.flat().includes(99));
        for (let id = 100; id <= 108; id++) h.add(id);
        h.advance(PERIOD); h.tick(); assert.notStrictEqual(h.kernel.safetyStartedAt, null);
        await h.kernel.shutdown(); const pages = h.pages.length;
        h.advance(10 * PERIOD); h.tick();
        assert.strictEqual(h.pages.length, pages);
        assert.strictEqual(h.kernel.safetyStartedAt, null);
        assert.strictEqual(h.kernel.states.safetyCursor, null);
        assert.strictEqual(h.kernel.alarms.size, 0);
        const fresh = harness(); assert.strictEqual(fresh.kernel.states.size, 0);
        assert.strictEqual(fresh.kernel.states.safetyNodes.size, 0);
        assert.strictEqual(fresh.kernel.states.safetyCursor, null);
        assert.strictEqual(fresh.alarm().length, 1);
        assert.strictEqual(fresh.alarm()[0].dueAt, fresh.bornAt + PERIOD);
    });
    if (failures.length) throw new Error(`worker safety contracts failed: ${failures.join(', ')}`);
    console.log('N53 attached thirty-minute worker safety paging: focused contracts passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
