'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const CpuProfile = require('../src/Perf/CpuProfile');

const root = path.resolve(__dirname, '..');
const url = (file) => pathToFileURL(path.join(root, file)).href;
const frame = (functionName, file = '', lineNumber = -1) => ({ functionName, url: file ? url(file) : '', lineNumber });

// root ─┬ (idle)
//       ├ tick BotAI.js:11 ── heavy World.js:21
//       ├ (garbage collector)
//       └ listOnTimeout node:internal/timers ── tick BotAI.js:11 (the same function, another node)
const profile = {
    nodes: [
        { id: 1, callFrame: frame('(root)'), children: [2, 3, 4, 5] },
        { id: 2, callFrame: frame('(idle)'), children: [] },
        { id: 3, callFrame: frame('tick', 'src/GameServer/Bot/AI/BotAI.js', 10), children: [6] },
        { id: 4, callFrame: frame('(garbage collector)'), children: [] },
        { id: 5, callFrame: { functionName: 'listOnTimeout', url: 'node:internal/timers', lineNumber: 580 }, children: [7] },
        { id: 6, callFrame: frame('heavy', 'src/GameServer/World/World.js', 20), children: [] },
        { id: 7, callFrame: frame('tick', 'src/GameServer/Bot/AI/BotAI.js', 10), children: [] }
    ],
    // 1 ms between samples; the last one lasts until endTime.
    samples: [2, 3, 6, 6, 6, 4, 2, 7, 2],
    timeDeltas: [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
    startTime: 1000000,
    endTime: 1000000 + 9000
};

const a = CpuProfile.analyze(profile, { longTurnMs: 3 });
assert.equal(a.durationMs, 9);
assert.equal(a.busyMs, 6, 'every sample but (idle) is busy');
assert.equal(a.idleMs, 3);
assert.equal(a.gcMs, 1);
assert.equal(a.runs, 2, 'idle samples split the busy runs');
assert.equal(a.longTurns, 1, 'only the 5 ms run reaches 3 ms');
assert.deepEqual(a.long, [{ atMs: 1, ms: 5 }]);
assert.equal(a.longest.ms, 5);
assert.equal(a.longest.atMs, 1, 'the run starts at the second sample');
assert.deepEqual(a.longest.code, [
    { fn: 'tick src/GameServer/Bot/AI/BotAI.js:11', ms: 4 },
    { fn: 'heavy src/GameServer/World/World.js:21', ms: 3 }
], 'project frames hold the run including their callees; GC and node internals are not project code');
assert.equal(a.longest.self[0].fn, 'heavy src/GameServer/World/World.js:21');
assert.ok(a.longest.self.some(row => row.fn === '(garbage collector)'), 'self time keeps GC and native frames');
assert.deepEqual(a.files.map(row => row.fn), ['src/GameServer/World/World.js', 'src/GameServer/Bot/AI/BotAI.js']);
assert.equal(CpuProfile.sourceOf(url('src/NodeL2.js')), 'src/NodeL2.js');
assert.equal(CpuProfile.sourceOf('node:internal/timers'), 'node:internal/timers');

// The next chunk overlaps this one up to +3 ms: those samples are left out, so the 5 ms run counts
// once (here: its last 2 ms only).
const tail = CpuProfile.analyze(profile, { longTurnMs: 2, since: profile.startTime + 3000 });
assert.equal(tail.durationMs, 6);
assert.equal(tail.busyMs, 3);
assert.equal(tail.runs, 2);
assert.equal(tail.longest.ms, 2);

const empty = CpuProfile.analyze({ nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 0 });
assert.equal(empty.longest, null);
assert.equal(empty.runs, 0);

console.log('test_perf_cpu_profile passed');
