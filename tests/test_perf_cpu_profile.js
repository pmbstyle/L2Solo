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
assert.deepEqual(a.owners, [
    { fn: 'heavy src/GameServer/World/World.js:21', ms: 3 },
    { fn: 'tick src/GameServer/Bot/AI/BotAI.js:11', ms: 2 },
    { fn: '(garbage collector)', ms: 1 }
], 'each sample counts for its nearest project frame; one with none (GC) for itself');
assert.equal(CpuProfile.sourceOf(url('src/NodeL2.js')), 'src/NodeL2.js');
assert.equal(CpuProfile.sourceOf('node:internal/timers'), 'node:internal/timers');
// A starved chunk: 3 samples in 60 s (the profiler sampled too rarely), one long "run".
const starved = CpuProfile.analyze({ nodes: profile.nodes, samples: [3, 6, 3], timeDeltas: [1000, 20e6, 20e6],
    startTime: 0, endTime: 60e6 });
assert.equal(starved.samples, 3);
assert.equal(starved.starved, true, 'fewer than one sample per 20 ms');
assert.equal(a.starved, false, 'a short chunk is never starved');
// A run recorded from a worktree names its files under that checkout, wherever it is.
const worktree = '/tmp/x/src/scratchpad/wt-after';
assert.equal(CpuProfile.sourceOf(`file://${worktree}/src/GameServer/Bot/AI/BotAI.js`), 'src/GameServer/Bot/AI/BotAI.js');
assert.equal(CpuProfile.sourceOf(`${worktree}/scripts/perf.js`), 'scripts/perf.js');
assert.equal(CpuProfile.frameOf({ functionName: 'tick', url: `${worktree}/src/NodeL2.js`, lineNumber: 4 }).key, 'tick src/NodeL2.js:5');
assert.equal(CpuProfile.frameOf({ url: `${worktree}/src/NodeL2.js` }).project, true);
assert.equal(CpuProfile.frameOf({ url: `${worktree}/node_modules/better-sqlite3/lib/index.js` }).project, false);
assert.equal(CpuProfile.sourceOf(url('.claude/worktrees/x/src/NodeL2.js')), 'src/NodeL2.js', 'a worktree inside this checkout too');
assert.equal(CpuProfile.sourceOf('/usr/lib/node/x.js'), '/usr/lib/node/x.js', 'a file outside any checkout keeps its path');

// The next chunk overlaps this one up to +3 ms: those samples are left out, so the 5 ms run counts
// once (here: its last 2 ms only).
const tail = CpuProfile.analyze(profile, { longTurnMs: 2, since: profile.startTime + 3000 });
assert.equal(tail.durationMs, 6);
assert.equal(tail.busyMs, 3);
assert.equal(tail.runs, 2);
assert.equal(tail.longest.ms, 2);

// V8's profile clock (us) wraps at 2^32 (~71.6 min): a chunk across the wrap ends "before" it
// starts. The same chunk read across the wrap gives the same numbers, also with an overlap (since)
// on either side of it.
const WRAP = 2 ** 32;
const shifted = (startTime) => ({ ...profile, startTime, endTime: (startTime + 9000) % WRAP });
for (const startTime of [WRAP - 4000, WRAP - 2000]) {
    const wrapped = CpuProfile.analyze(shifted(startTime), { longTurnMs: 3 });
    assert.deepEqual([wrapped.durationMs, wrapped.idleMs, wrapped.long], [9, 3, [{ atMs: 1, ms: 5 }]], 'the last sample lasts until the end');
    const after = CpuProfile.analyze(shifted(startTime), { longTurnMs: 2, since: (startTime + 3000) % WRAP });
    assert.deepEqual([after.durationMs, after.busyMs, after.longest.ms], [6, 3, 2], 'the overlap is left out across the wrap');
}
// The real case (2026-11-06): a starved worker minute across the wrap read as 0 ms long, so it was
// not marked starved and its one 60 s "run" became the report's longest turn.
const starvedWrap = CpuProfile.analyze({ nodes: profile.nodes, samples: [3, 6, 3], timeDeltas: [1000, 20e6, 20e6],
    startTime: WRAP - 30e6, endTime: 30e6 });
assert.equal(starvedWrap.durationMs, 60000);
assert.equal(starvedWrap.starved, true);

// A profiler that starves in stretches while its average gap stays under 20 ms: a gap over 100 ms
// has no samples, so it is neither busy nor idle and ends a busy run (it held a 60 s fake turn).
// 3000 busy samples 1 ms apart, one 200 ms gap after the 1500th: 6 % of the chunk, still usable.
const busyChunk = (gaps) => {
    const timeDeltas = Array(3000).fill(1000);
    timeDeltas[0] = 0;
    for (const at of gaps) timeDeltas[at] = 200000;
    const length = timeDeltas.reduce((sum, delta) => sum + delta, 0) + 1000;
    return { nodes: profile.nodes, samples: Array(3000).fill(3), timeDeltas, startTime: 0, endTime: length };
};
const stretch = CpuProfile.analyze(busyChunk([1500]), { longTurnMs: 1000 });
assert.equal(stretch.durationMs, 3199);
assert.equal(stretch.starved, false, '6 % of the chunk without samples');
assert.deepEqual([stretch.unsampledMs, stretch.stretches, stretch.busyMs], [200, 1, 2999]);
assert.deepEqual(stretch.long, [{ atMs: 1699, ms: 1500 }, { atMs: 0, ms: 1499 }], 'two runs, not one of 3199 ms');
// Partial starvation (2026-11-11): 60 ms gaps are under the old 100 ms limit, so they were neither
// counted nor left out. Each is now a stretch: out of busy time, counted, and it ends the run.
const partialChunk = busyChunk([500, 1500, 2500]);
for (const at of [500, 1500, 2500]) partialChunk.timeDeltas[at] = 60000;
partialChunk.endTime = partialChunk.timeDeltas.reduce((sum, delta) => sum + delta, 0) + 1000;
const partial = CpuProfile.analyze(partialChunk, { longTurnMs: 1000 });
assert.deepEqual([partial.stretches, partial.unsampledMs, partial.starved], [3, 180, false], 'three gaps over 50 ms counted');
assert.equal(partial.runs, 4, 'each gap ends the busy run');
// Five such gaps: 1 s of 4 s (25 %) without samples starve the whole chunk, though its 3000 samples
// average one per 1.3 ms.
const stretches = CpuProfile.analyze(busyChunk([500, 1000, 1500, 2000, 2500]));
assert.equal(stretches.starved, true, 'more than 10 % of the chunk without samples');
assert.equal(stretches.unsampledMs, 1000);

// Node writes regexp code names unescaped ("RegExp: <source>"): a quote or backslash in a pattern
// breaks the profile's JSON until it is repaired.
const v8 = require('v8');
const broken = '{"nodes":[{"callFrame":{"functionName":"RegExp: "a"\\d","lineNumber":-1,"columnNumber":-1,"scriptId":0,"url":""}}]}';
assert.equal(JSON.parse(CpuProfile.repairText(broken)).nodes[0].callFrame.functionName, 'RegExp: "a"\\d');
// Node 22 has no v8.startCpuProfile (the server then runs without the live recorder): the
// live profile check runs only where the profiler exists.
if (typeof v8.startCpuProfile !== 'function') {
    console.log(`test_perf_cpu_profile: live profile check skipped, Node ${process.version} has no v8.startCpuProfile`);
} else {
    const handle = v8.startCpuProfile();
    const patterns = [/"(\w+)"\[x\]/g, /\[(\d+)\((\d+)\)\]/, /\\u12\d/];
    for (const end = Date.now() + 300; Date.now() < end;) {
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            pattern.test('"abc"[x] [1(2)] \\u123');
        }
    }
    // repairText's own pattern runs under the profiler as well (on the live server it repairs the
    // chunk before): its name must not cut itself.
    for (const end = Date.now() + 300; Date.now() < end;) CpuProfile.repairText(broken);
    const raw = handle.stop();
    assert.throws(() => JSON.parse(raw), SyntaxError, 'Node 24.15 still writes these names unescaped');
    const repaired = JSON.parse(CpuProfile.repairText(raw));
    const names = repaired.nodes.map(node => node.callFrame.functionName);
    for (const pattern of patterns) assert.ok(names.includes(`RegExp: ${pattern.source}`), `kept ${pattern.source}`);
}
const windows = '{"nodes":[{"id":1,"callFrame":{"functionName":"tick","url":"C:\\Users\\l2\\src\\BotAI.js","lineNumber":1}}]}';
assert.equal(JSON.parse(CpuProfile.repairText(windows)).nodes[0].callFrame.url, 'C:\\Users\\l2\\src\\BotAI.js');
assert.equal(CpuProfile.repairText('{"a":"\\n"}'), '{"a":"\\n"}', 'valid text is left as it is');

const empty = CpuProfile.analyze({ nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 0 });
assert.equal(empty.longest, null);
assert.equal(empty.runs, 0);

console.log('test_perf_cpu_profile passed');
