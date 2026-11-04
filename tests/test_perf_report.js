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
    { type: 'player', t: iso(start + 30000), scheduleMs: [...Array(19).fill(2), 200], handlerMs: Array(20).fill(1), errors: 0, hot: 30,
        players: 2, packets: 1200, bytes: 2 * 30 * 1024 * 10, seconds: 30, moves: 2 },
    { type: 'player', t: iso(end + 30000), scheduleMs: [999], handlerMs: [999], errors: 0, hot: 99 },
    { type: 'summary', t: iso(start + 30000), main: { memory: { heapUsed: 100 * MB, rss: 300 * MB }, processCpuMs: { user: 9000, system: 1000 } },
        vitals: { bots: { hot: 2, cold: 5 }, players: 1, lag: { sustainedMs: 10 }, database: { pending: 3, checkpoint: { last: { at: 1 } },
            maintenance: { refusals: { 'wal_truncate:wal_below_threshold': 2 } } },
            mainHeap: { afterGc: 50 } },
        files: { walMb: 4, worldMb: 20 }, machine: { freeMemMb: 900, majorPageFaults: 2 },
        coordinator: { queue: { depth: 2, bytes: 2048, oldestMs: 100, paused: false, failures: { afterCommitErrors: 0 } },
            failures: { workerFaults: 1, faultBackoff: 1, faultQuarantined: 0, commandDbErrors: 0, swallowed: { 'cold.after_commit': 1 } } },
        population: { metrics: { delta: { coldOwnerHandoffs: 3, activations: 3, cooldowns: 1, activationRefusals: 2 },
            activationRefusalReasons: { no_safe_activation_placement: 2 }, transitions: { activation: { count: 3, avgMs: 100, p95Ms: 180, maxMs: 200 },
            cooldown: { count: 1, avgMs: 40, p95Ms: 40, maxMs: 40 } } } },
        coldQueue: { overdue: 1 }, heaps: { main: { usedMb: 100 } }, recorder: { costMs: 60, inspectorMs: 0 } },
    { type: 'summary', t: iso(end), main: { memory: { heapUsed: 120 * MB, rss: 310 * MB }, processCpuMs: { user: 14000, system: 0 } },
        vitals: { bots: { hot: 4, cold: 3 }, players: 1, lag: { sustainedMs: 30 }, database: { pending: 7, checkpoint: { last: { at: 2 },
            lastResetAttempt: { mode: 'truncate', ok: false, error: 'disk I/O error', at: end - 1000, durationMs: 3.25 },
            lastReset: { mode: 'truncate', ok: true, busy: 0, at: end - 60000, durationMs: 7 } },
            maintenance: { refusals: { 'wal_truncate:wal_below_threshold': 5, 'state_retention:governor_database_queue': 1 } } },
            mainHeap: { afterGc: 55 } },
        files: { walMb: 9, worldMb: 20 }, machine: { freeMemMb: 700, majorPageFaults: 5 },
        coordinator: { queue: { depth: 5, bytes: 4096, oldestMs: 900, paused: true, failures: { afterCommitErrors: 2 } },
            failures: { workerFaults: 4, faultBackoff: 1, faultQuarantined: 1, commandDbErrors: 2, lastFault: { stage: 'solo_project', reason: 'boom' },
                swallowed: { 'cold.after_commit': 3, 'route.search': 2 } } },
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
    assert.equal(s.player.packetsPerSecond, 20, '1200 packets in 30 s to 2 players');
    assert.equal(s.player.kbPerSecond, 10);
    assert.equal(s.player.moves, 2);
    assert.deepEqual(s.transitions, { activation: { count: 3, avgMs: 100, p95Ms: 180, maxMs: 200 },
        cooldown: { count: 1, avgMs: 40, p95Ms: 40, maxMs: 40 }, handoffs: 3,
        refusals: { count: 2, reasons: { no_safe_activation_placement: 2 } } });
    assert.deepEqual(main.cpuParts, [{ part: 'world, actors, combat', ms: 60, pct: 100 }], 'World.js counts as world');
    assert.deepEqual(s.player.over, ['schedule p99 200 > 120 ms', 'schedule max 200 > 150 ms']);
    const c = s.context;
    assert.deepEqual(c.load, { hotAvg: 3, coldAvg: 4, playersMax: 1, lagSustainedMaxMs: 30 });
    assert.equal(c.database.pendingMax, 7);
    assert.deepEqual(c.database.walMb, { start: 4, end: 9, max: 9 });
    assert.equal(c.database.checkpoints, 1, 'the last checkpoint changed once in the window');
    assert.deepEqual(c.database.walTruncate, {
        last: { at: iso(end - 1000), ok: false, busy: 0, durationMs: 3.3, error: 'disk I/O error' },
        lastEmptied: { at: iso(end - 60000), ok: true, busy: 0, durationMs: 7 }
    }, 'the WAL truncate\'s last try, failed ones included, and its last success');
    assert.deepEqual(c.database.maintenanceRefusals, { 'wal_truncate:wal_below_threshold': 3, 'state_retention:governor_database_queue': 1 },
        'maintenance refusals counted in the window, by job and reason');
    assert.deepEqual(c.commitQueue, { depthMax: 5, bytesMaxKb: 4, oldestMaxMs: 900, pausedShare: 0.5 });
    assert.equal(c.failures.workerFaults, 3, 'faults in the window, not since boot');
    assert.equal(c.failures.afterCommitErrors, 2);
    assert.equal(c.failures.lastFault.reason, 'boom');
    assert.equal(c.failures.faultBots, 2, 'bots held off: backing off + quarantined');
    assert.equal(c.failures.commandDbErrors, 2);
    assert.equal(c.failures.swallowed, 4, 'failures the code survived, grown in the window');
    assert.deepEqual(c.failures.swallowedSites, { 'cold.after_commit': 3, 'route.search': 2 }, 'by site, as of the last line');
    assert.deepEqual(c.memory.mainHeapAfterGcMb, { start: 50, end: 55, max: 55 });
    assert.equal(c.memory.freeMemMinMb, 700);
    assert.equal(c.memory.majorPageFaults, 3, 'totals since start: the last line in the window minus the first');
    assert.deepEqual(s.memory.mainHeapUsedMb, { start: 100, end: 120, max: 120 });
    assert.deepEqual(s.memory.heaps.main, { start: 100, end: 120, max: 120 });
    assert.deepEqual(s.memory.growth.main.self, [{ fn: 'keep src/GameServer/World/World.js:5', mb: 15 }]);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('test_perf_report passed');
