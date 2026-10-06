const assert = require('assert');
const Registry = require('../src/GameServer/Bot/Population/BackgroundJobRegistry');

let now = 1000000;
const clocks = new Set();
const registry = Registry.create({ now: () => now,
    setInterval: callback => { const clock = { callback, unref() {} }; clocks.add(clock); return clock; },
    clearInterval: clock => clocks.delete(clock) });
registry.start(now);
assert.strictEqual(clocks.size, 1, 'actual existing cooperative clock is running');
console.log('Actual Registry clock positive control: pass');

(async () => {
    try {
        const { LifecycleSafetySweep } = require('../src/GameServer/Bot/Population/LifecycleSafetySweep');
        const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
        assert.strictEqual(typeof Protocol.safetyCheckpoint, 'function');
        const flush = () => new Promise(resolve => setImmediate(resolve));
        const states = new Map();
        const projections = new Map();
        const rows = [];
        for (let characterId = 1; characterId <= 140; characterId++) {
            const state = { characterId, phase: 'cold', activity: 'resting', updatedAt: 100, stats: {}, inventory: {},
                simulation: { ownerId: 'legacy_main', revision: 1, leaseId: null, leaseUntil: 0 },
                timing: { activityStartedAt: 10, nextResolveAt: now + 10000000, lastResolvedAt: 50, lastHotAt: 0 } };
            states.set(characterId, state);
            projections.set(characterId, { state, context: { generated: true } });
            rows.push(Protocol.safetyCheckpoint(state));
        }
        const worker = { worker: {}, epoch: 'sweep-worker', ready: true };
        const pages = [], requests = [], contexts = [], completes = [];
        const excluded = new Set(), missing = new Set(), boardMissing = new Set();
        let allowed = true, running = true, heldReply = null, hold = false, rejectRead = false;
        const metrics = { state: 0, board: 0 };
        const sweep = new LifecycleSafetySweep({ now: () => now, active: () => running,
            readCurrent: async checkpoint => rows.find(row => row.characterId === checkpoint.characterId),
            readPage: async cursor => {
                if (rejectRead) throw new Error('generated-read-fault');
                const highWaterId = cursor.highWaterId ?? rows.at(-1).characterId;
                const page = rows.filter(row => row.characterId > cursor.afterId && row.characterId <= highWaterId).slice(0, 64);
                pages.push(page.map(row => row.characterId));
                const afterId = page.at(-1)?.characterId ?? cursor.afterId;
                const done = page.length < 64 || afterId === highWaterId;
                return { rows: page, cursor: { afterId: done ? highWaterId : afterId, highWaterId }, done };
            },
            cachedState: id => states.get(id),
            cold: { current: () => worker, excluded: id => excluded.has(id), canRepair: () => true, poll() {}, cancel() {},
                projection(id) { contexts.push(id); return { entry: projections.get(id) }; },
                async request(kind, selected, current) {
                    assert.strictEqual(current.worker, worker.worker);
                    requests.push({ kind, selected });
                    if (hold) await new Promise(resolve => { heldReply = resolve; });
                    if (kind === 'presence') return { ok: true, results: selected.map(checkpoint => ({
                        characterId: checkpoint.characterId, checkpoint, workerVersion: 1,
                        normal: { status: missing.has(checkpoint.characterId) ? 'uncovered' : 'covered',
                            reason: missing.has(checkpoint.characterId) ? 'missing_state' : 'scheduled' },
                        board: { status: boardMissing.has(checkpoint.characterId) ? 'uncovered' : 'covered', coverageVersion: 3 }
                    })) };
                    for (const edge of selected) {
                        if (edge.kind === 'state') { missing.delete(edge.checkpoint.characterId); metrics.state++; }
                        else { boardMissing.delete(edge.checkpoint.characterId); metrics.board++; }
                    }
                    return { ok: true, results: selected.map(edge => ({ ...edge, status: 'accepted' })) };
                } },
            admit: () => allowed ? {} : null, complete: lease => completes.push(lease),
            onError: error => assert.strictEqual(error.message, 'generated-read-fault'), retryMs: 1000 });
        assert.strictEqual(sweep.start(registry), true);
        assert.strictEqual(sweep.start(registry), false);
        assert.strictEqual(clocks.size, 1, 'safety creates no clock');
        for (const [id, state] of states) if (id !== 130) Object.defineProperty(state, 'inventory', {
            enumerable: true, configurable: true, get() { throw new Error('healthy page must not classify/serialize inventory'); }
        });
        const tick = async (advance = 0) => { now += advance; registry.tick(now); await flush(); };
        await tick(1800000 - 1);
        assert.deepStrictEqual(pages, []);
        missing.add(130); boardMissing.add(131);
        allowed = false;
        await tick(1);
        assert.deepStrictEqual(pages, []);
        allowed = true;
        for (let pulse = 0; pulse < 20; pulse++) await tick();
        assert.deepStrictEqual(pages.map(page => page.length), [64, 64, 12]);
        assert.deepStrictEqual(contexts, [130, 130, 130], 'only proven missing owner projection plus pre/post native-read checks');
        assert.deepStrictEqual(metrics, { state: 1, board: 1 });
        assert(requests.every(request => request.selected.length <= 64));
        assert.strictEqual(sweep.snapshot().completedCycles, 1);
        assert.strictEqual(clocks.size, 1);
        console.log('bounded healthy pages, existing clock, pressure and sparse repair adapters: pass');

        // A failed read preserves cursor; retry waits for the existing pulse.
        rejectRead = true;
        await tick(1800000);
        assert.strictEqual(sweep.snapshot().cursor.afterId, 0);
        const previousReads = pages.length;
        await tick(); assert.strictEqual(pages.length, previousReads);
        rejectRead = false;
        await tick(1000);
        assert.strictEqual(pages.length, previousReads + 1);
        console.log('native read boundary fault keeps its cursor with pulse-based retry: pass');

        // The retained cache can still show the old tuple when a durable phase
        // change has already happened. The final native read rejects that edge.
        missing.add(3);
        const durable = rows.find(row => row.characterId === 3);
        sweep.readCurrent = async checkpoint => checkpoint.characterId === 3
            ? { ...durable, phase: 'hot', simulationRevision: durable.simulationRevision + 1 }
            : rows.find(row => row.characterId === checkpoint.characterId);
        // This control owns an intentionally uncovered projection; its own bag
        // may be read. Healthy unrelated owners remain trapped above.
        Object.defineProperty(states.get(3), 'inventory', { enumerable: true, configurable: true, value: {} });
        for (let pulse = 0; pulse < 7; pulse++) await tick();
        assert.strictEqual(metrics.state, 1, 'durable-before-cache drift accepts zero new state repairs');
        assert.strictEqual(missing.has(3), true);
        console.log('final authoritative read boundary phase/authority guard: pass');

        // Hot uncovered input pays one targeted final native read. A durable
        // phase change, still absent from cache, prevents queue acceptance.
        sweep.stop();
        const hotState = Object.defineProperties({}, Object.getOwnPropertyDescriptors(states.get(1)));
        hotState.phase = 'hot';
        Object.defineProperty(hotState, 'inventory', { configurable: true,
            get() { throw new Error('hot safety must not classify inventory'); } });
        states.set(1, hotState);
        rows[0] = Protocol.safetyCheckpoint(hotState);
        let hotRepairs = 0, hotReads = 0;
        sweep.hot = { probe: checkpoint => ({ status: 'uncovered', checkpoint }),
            repair: () => { hotRepairs++; } };
        sweep.readCurrent = async checkpoint => {
            if (checkpoint.characterId === 1) {
                hotReads++;
                return { ...checkpoint, phase: 'cold', simulationRevision: checkpoint.simulationRevision + 1 };
            }
            return rows.find(row => row.characterId === checkpoint.characterId);
        };
        sweep.start(registry);
        await tick(1800000);
        for (let pulse = 0; pulse < 24; pulse++) await tick();
        assert.strictEqual(hotRepairs, 0);
        assert.strictEqual(hotReads, 1);
        console.log('hot uncovered final native read rejects durable-before-cache change: pass');

        sweep.stop();
        const subscribe = registry.subscribeTicks;
        registry.subscribeTicks = () => { throw new Error('generated-subscription-fault'); };
        assert.throws(() => sweep.start(registry), /generated-subscription-fault/);
        registry.subscribeTicks = subscribe;
        assert.strictEqual(sweep.running, false, 'failed start is retryable');

        // A late response from a retired generation cannot dispatch repairs.
        sweep.stop(); sweep.start(registry);
        sweep.hot = null;
        hold = true; await tick(1800000);
        for (let pulse = 0; pulse < 4 && !heldReply; pulse++) await tick();
        assert(heldReply);
        const repairsBefore = requests.filter(request => request.kind === 'repair').length;
        assert.strictEqual(sweep.stop(), true);
        heldReply(); await flush();
        assert.strictEqual(requests.filter(request => request.kind === 'repair').length, repairsBefore);
        assert.strictEqual(sweep.snapshot().running, false);
        assert.strictEqual(registry.tickSubscribers.size, 0);
        assert(completes.length > 0);
        console.log('late response/stop disposal and no resurrection: pass');
        console.log('Lifecycle safety continuation adapter tests: PASS');
    } finally {
        registry.stop();
        assert.strictEqual(clocks.size, 0);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
