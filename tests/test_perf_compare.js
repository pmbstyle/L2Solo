'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compare } = require('../scripts/perf/compare');

const summary = (busy, heapEnd, cpuSelf, save = 's1') => ({
    run: { folder: `run-${busy}`, sha: 'abc', dirty: false, scenario: 'cold', save: { id: save, name: 'w' },
        windowMinutes: 10, warmupMinutes: 5, diagnostics: false },
    processCores: 0.5, coldDueMax: 0, recorderMainPct: 0.3,
    threads: { main: { busyPct: busy, gcPct: 1, longTurnsPerMin: 60, longestMs: 300, chunkLongestP95Ms: 250, cpuSelf } },
    memory: { mainHeapUsedMb: { start: 300, end: heapEnd, max: heapEnd }, rssMb: { start: 1000, end: 1000, max: 1000 },
        heaps: {}, growth: {} }
});
const dirs = [];
const folder = (s) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-compare-'));
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(s));
    dirs.push(dir);
    return dir;
};
const log = console.log;
console.log = () => {};
try {
    const a = folder(summary(20, 400, [{ fn: 'price src/a.js:1', pct: 30 }, { fn: 'walk src/b.js:2', pct: 10 }]));
    const b = folder(summary(25, 380, [{ fn: 'price src/a.js:1', pct: 12 }, { fn: 'walk src/b.js:2', pct: 10 }, { fn: 'new src/c.js:3', pct: 5 }]));
    const result = compare(a, b);
    assert.deepEqual(result.differs, []);
    const row = (label) => result.table.find(([name]) => name === label);
    assert.deepEqual(row('main busy %'), ['main busy %', 20, 25]);
    assert.deepEqual(row('main heap end MB'), ['main heap end MB', 400, 380]);
    const other = compare(a, folder(summary(20, 400, [], 's2')));
    assert.deepEqual(other.differs.map(([what]) => what), ['save'], 'another save is not comparable');
} finally {
    console.log = log;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}
console.log('test_perf_compare passed');
