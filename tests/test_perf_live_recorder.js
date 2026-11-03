'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
require('../src/Global');
const { LiveRecorder } = require('../src/Perf/LiveRecorder');
const HeapProfile = require('../src/Perf/HeapProfile');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const spikeLines = (boot) => fs.readdirSync(boot).filter(name => /^spikes-\d{8}\.jsonl$/.test(name)).sort()
    .flatMap(name => lines(path.join(boot, name)));
// A worker that blocks its loop 120 ms every 300 ms: long turns the recorder has to find and name.
// A worker that keeps what it allocates: the heap profiles have to show it grow.
const LEAK = 'const kept = []; function leak() { for (let i = 0; i < 200; i++) kept.push({ a: new Array(64).fill(i) }); }'
    + ' setInterval(leak, 20);';
const BUSY = 'function stepBots() { let x = 0; const t = Date.now(); while (Date.now() - t < 120) x += Math.sqrt(x + 1); return x; }'
    + ' setInterval(stepBots, 300);';

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-live-'));
    const recorder = new LiveRecorder();
    const workers = [];
    try {
        assert.equal(new LiveRecorder().start({ live: false, dir }), false, 'off: nothing registered, no folder');
        assert.deepEqual(fs.readdirSync(dir), []);

        assert.equal(recorder.start({ live: true, dir, cpuThreads: 'main,perf-test-busy', cpuChunkSeconds: 1,
            longTurnMs: 50, keepProfileMs: 100, keepProfiles: 2, heapThreads: 'main,perf-test-leak', heapSampleKb: 32,
            keepHeapProfiles: 2 }), true);
        const current = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
        assert.equal(current.pid, process.pid);
        const boot = path.join(dir, current.boot);
        workers.push(new Worker(BUSY, { eval: true, name: 'perf-test-busy' }));
        workers.push(new Worker('setInterval(() => {}, 1000);', { eval: true, name: 'perf-test-quiet' }));
        workers.push(new Worker(LEAK, { eval: true, name: 'perf-test-leak' }));

        // Workers that start together attach to the inspector in any order: each thread must carry
        // its own Worker's name (the inspector's workerId is an attach counter, not the thread id).
        await sleep(300);
        const names = new Map([[workers[0].threadId, 'perf-test-busy'], [workers[1].threadId, 'perf-test-quiet'],
            [workers[2].threadId, 'perf-test-leak']]);
        for (const thread of recorder.threads.all().filter(row => row.worker)) {
            assert.equal(thread.label, names.get(thread.threadId), `thread ${thread.threadId}`);
            assert.equal(thread.worker.threadId, thread.threadId);
        }

        for (let chunk = 0; chunk < 2; chunk++) {
            await sleep(1200);
            await recorder.tick();
        }
        await recorder.writes;
        const day = fs.readdirSync(boot).find(name => name.startsWith('timeline-'));
        const cpu = lines(path.join(boot, day)).filter(line => line.type === 'cpu');
        assert.deepEqual([...new Set(cpu.map(line => line.thread))].sort(), ['main', 'perf-test-busy'],
            'only the threads in cpuThreads are profiled');
        const worker = cpu.filter(line => line.thread === 'perf-test-busy');
        assert.equal(worker.length, 2);
        for (const line of worker) {
            assert.ok(line.longestMs >= 100 && line.longestMs < 400, `worker longest run ${line.longestMs}: ${JSON.stringify(worker)}`);
            assert.ok(line.longTurns >= 2, 'a 120 ms block every 300 ms gives several long turns a chunk');
        }
        const spikes = spikeLines(boot).filter(row => row.thread === 'perf-test-busy');
        assert.equal(spikes.length, 2);
        // The second chunk starts after stepBots is optimized: a restarted profiler would charge its
        // time to the timer (listOnTimeout); overlapping chunks keep the name.
        assert.match(spikes[1].self[0].fn, /^stepBots /, `second chunk names the code: ${JSON.stringify(spikes[1].self)}`);
        assert.ok(spikes.every(row => row.profile && fs.existsSync(path.join(boot, row.profile))), 'long chunks are kept');
        assert.ok(JSON.parse(fs.readFileSync(path.join(boot, spikes[0].profile), 'utf8')).samples.length > 0);

        await recorder.recordSummary('summary', { enabled: false, coldQueue: { overdue: 2 } }, () => ({ worker: { heapAfterGc: 1 } }));
        await recorder.writes;
        const summary = lines(path.join(boot, day)).find(line => line.type === 'summary');
        assert.equal(summary.coldQueue.overdue, 2);
        assert.equal(summary.coordinator.worker.heapAfterGc, 1);
        assert.equal(summary.population, null, 'diagnostics off: no population summary');
        assert.deepEqual(Object.keys(summary.heaps).sort(), ['main', 'perf-test-busy', 'perf-test-leak', 'perf-test-quiet'],
            'heap of every thread, profiled or not');
        assert.ok(summary.main.memory.rss > 0);

        // capture: the next tick saves every profiled thread's chunk, however short, and removes the request.
        fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ kind: 'cpu' }));
        await recorder.tick();
        await recorder.writes;
        assert.equal(fs.existsSync(path.join(dir, 'request.json')), false);
        const forced = spikeLines(boot).filter(row => row.forced);
        assert.deepEqual(forced.map(row => row.thread).sort(), ['main', 'perf-test-busy']);
        assert.equal(fs.readdirSync(path.join(boot, 'cpu')).length, 2, 'keepProfiles caps the raw profiles');

        // capture heap, three times: each heap thread's sampler is read without a reset, so the
        // leaking worker's live memory grows from file to file and the diff names the function.
        for (let dump = 0; dump < 3; dump++) {
            if (dump) await sleep(700);
            fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ kind: 'heap' }));
            await recorder.tick();
            await recorder.writes;
        }
        const heap = lines(path.join(boot, day)).filter(line => line.type === 'heap');
        assert.deepEqual([...new Set(heap.map(line => line.thread))].sort(), ['main', 'perf-test-leak']);
        const leaking = heap.filter(line => line.thread === 'perf-test-leak');
        assert.equal(leaking.length, 3);
        assert.ok(leaking[2].liveMb > leaking[0].liveMb + 2, `live memory grows: ${leaking.map(line => line.liveMb)}`);
        assert.match(leaking[2].self[0].fn, /^leak /);
        const kept = fs.readdirSync(path.join(boot, 'heap')).filter(name => name.includes('perf-test-leak')).sort();
        assert.deepEqual(kept, [path.basename(leaking[0].profile), path.basename(leaking[2].profile)],
            'keepHeapProfiles: the first (baseline) and the newest stay');
        const read = (file) => JSON.parse(fs.readFileSync(path.join(boot, file), 'utf8'));
        const grown = HeapProfile.diff(read(leaking[0].profile), read(leaking[2].profile));
        assert.match(grown.self[0].fn, /^leak /, `the diff names what kept memory: ${JSON.stringify(grown.self)}`);

        // capture snapshot of one worker: a full heap snapshot, streamed by the worker.
        fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ kind: 'snapshot', thread: 'perf-test-leak' }));
        await recorder.tick();
        const snapshot = fs.readdirSync(path.join(boot, 'heap')).find(name => name.endsWith('.heapsnapshot'));
        assert.ok(snapshot && fs.readFileSync(path.join(boot, 'heap', snapshot), 'utf8').startsWith('{"snapshot"'));

        // A restarted worker is a new thread: profiled again under its name.
        await workers[0].terminate();
        workers.push(new Worker(BUSY, { eval: true, name: 'perf-test-busy' }));
        // Its first chunk starts once the thread is up, then needs its second.
        await sleep(1800);
        await recorder.tick();
        await recorder.writes;
        const after = lines(path.join(boot, day)).filter(line => line.type === 'cpu' && line.thread === 'perf-test-busy');
        assert.ok(after.length >= 4, `the new worker has its own chunks (${after.length})`);
    } finally {
        await recorder.stop();
        await Promise.all(workers.map(worker => worker.terminate()));
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('test_perf_live_recorder passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
