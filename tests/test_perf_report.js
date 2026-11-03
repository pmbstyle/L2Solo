'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { summarize } = require('../scripts/perf/report');

const MB = 1048576;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-report-'));
const boot = path.join(dir, '20261103-120000');
fs.mkdirSync(path.join(boot, 'cpu'), { recursive: true });
fs.mkdirSync(path.join(boot, 'heap'));
const write = (file, value) => fs.writeFileSync(path.join(boot, file), typeof value === 'string' ? value : JSON.stringify(value));
const jsonl = (file, rows) => write(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
const url = pathToFileURL(path.join(__dirname, '..', 'src/GameServer/World/World.js')).href;

const start = Date.parse('2026-11-03T12:05:00Z'), end = start + 120000;
const iso = (ms) => new Date(ms).toISOString();
fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sha: 'abc', dirty: false, scenario: 'cold',
    save: { id: 'x', name: 'test world' }, bots: { cold: 2 }, warmupMinutes: 1, windowMinutes: 2,
    windowStart: iso(start), windowEnd: iso(end) }));

// A chunk: `busy` samples of heavy() then idle ones, 1 ms apart, starting at `at` us.
const nodes = [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3] },
    { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 }, children: [] },
    { id: 3, callFrame: { functionName: 'heavy', url, lineNumber: 9 }, children: [] }
];
const chunk = (at, busy, idle) => ({ nodes, samples: [...Array(busy).fill(3), ...Array(idle).fill(2)],
    timeDeltas: Array(busy + idle).fill(1000), startTime: at, endTime: at + (busy + idle) * 1000 });
write('cpu/a.cpuprofile', chunk(0, 40, 60));
// The next chunk starts 10 ms before the last one ended: its first 10 samples (busy) were counted.
write('cpu/b.cpuprofile', chunk(90000, 30, 70));
jsonl('timeline-20261103.jsonl', [
    { type: 'cpu', t: iso(start - 60000), thread: 'main', instance: 0, ms: 60000, busyMs: 60000, gcMs: 0, longestMs: 999, longTurns: 9 },
    { type: 'cpu', t: iso(start + 1000), thread: 'main', instance: 0, ms: 60000, busyMs: 12000, gcMs: 600, longestMs: 80,
        longTurns: 2, profile: 'cpu/a.cpuprofile' },
    { type: 'cpu', t: iso(start + 61000), thread: 'main', instance: 0, ms: 60000, busyMs: 6000, gcMs: 0, longestMs: 120,
        longTurns: 4, profile: 'cpu/b.cpuprofile' },
    // The hot scenario's player: 20 probes, one waited 200 ms for the loop.
    { type: 'player', t: iso(start + 30000), scheduleMs: [...Array(19).fill(2), 200], handlerMs: Array(20).fill(1), errors: 0, hot: 30 },
    { type: 'player', t: iso(end + 30000), scheduleMs: [999], handlerMs: [999], errors: 0, hot: 99 },
    { type: 'summary', t: iso(start + 30000), main: { memory: { heapUsed: 100 * MB, rss: 300 * MB }, processCpuMs: { user: 9000, system: 1000 } },
        coldQueue: { overdue: 1 }, heaps: { main: { usedMb: 100 } }, recorder: { costMs: 60, inspectorMs: 0 } },
    { type: 'summary', t: iso(end), main: { memory: { heapUsed: 120 * MB, rss: 310 * MB }, processCpuMs: { user: 14000, system: 0 } },
        coldQueue: { overdue: 3 }, heaps: { main: { usedMb: 120 } }, recorder: { costMs: 60, inspectorMs: 0 } }
]);
jsonl('spikes-20261103.jsonl', [
    { chunk: iso(start + 61000), thread: 'main', ms: 120, code: [{ fn: 'heavy src/GameServer/World/World.js:10', ms: 120 }] },
    { chunk: iso(start - 60000), thread: 'main', ms: 999, code: [{ fn: 'before src/x.js:1', ms: 999 }] }
]);
const heapProfile = (mb) => ({ head: { callFrame: { functionName: '(root)', url: '' }, selfSize: 0,
    children: [{ callFrame: { functionName: 'keep', url, lineNumber: 4 }, selfSize: mb * MB, children: [] }] } });
write('heap/1.heapprofile', heapProfile(10));
write('heap/2.heapprofile', heapProfile(25));
jsonl('heap.jsonl', [
    { t: iso(start - 5000), thread: 'main', instance: 0, liveMb: 10, profile: 'heap/1.heapprofile' },
    { t: iso(end + 5000), thread: 'main', instance: 0, liveMb: 25, profile: 'heap/2.heapprofile' }
]);

try {
    const s = summarize(dir);
    const main = s.threads.main;
    assert.equal(s.windowMinutes, 2);
    assert.equal(main.minutes, 2, 'the chunk before the window is left out');
    assert.equal(main.busyPct, 15);
    assert.equal(main.gcPct, 0.5);
    assert.equal(main.longTurnsPerMin, 3);
    assert.equal(main.longestMs, 120);
    assert.deepEqual(main.longTurnCode, [{ fn: 'heavy src/GameServer/World/World.js:10', ms: 120 }], 'spikes of the window only');
    assert.deepEqual(main.cpuSelf[0], { fn: 'heavy src/GameServer/World/World.js:10', ms: 60, pct: 100 },
        '40 + 30 busy samples less the 10 the second chunk shares with the first');
    assert.deepEqual(main.cpuFiles[0].fn, 'src/GameServer/World/World.js');
    assert.equal(s.processCores, 0.2, '24 s of process CPU in a 120 s window');
    assert.equal(s.recorderMainPct, 0.1);
    assert.equal(s.coldDueMax, 3);
    assert.deepEqual(s.player.schedule, { samples: 20, p50Ms: 2, p95Ms: 2, p99Ms: 200, maxMs: 200 }, 'probes of the window only');
    assert.equal(s.player.handler.p99Ms, 1);
    assert.equal(s.player.hotAvg, 30);
    assert.deepEqual(s.player.over, ['schedule p99 200 > 120 ms', 'schedule max 200 > 150 ms']);
    assert.deepEqual(s.memory.mainHeapUsedMb, { start: 100, end: 120, max: 120 });
    assert.deepEqual(s.memory.heaps.main, { start: 100, end: 120, max: 120 });
    assert.deepEqual(s.memory.growth.main.self, [{ fn: 'keep src/GameServer/World/World.js:5', mb: 15 }]);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('test_perf_report passed');
