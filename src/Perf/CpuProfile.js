'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

// Reads a V8 CPU profile (.cpuprofile: a call tree, the node of each sample, the time between
// samples). A busy run is a stretch of samples with no "(idle)" between them: the thread did not
// get back to waiting for I/O, so on main it is a turn of the event loop that every player packet
// waited for. Pure; shared by the live recorder and scripts/perf.js.

const IDLE = '(idle)', GC = '(garbage collector)', PROGRAM = '(program)', ROOT_NODE = '(root)';
// A run recorded from another checkout (a worktree, also one inside this checkout) names its files
// under that checkout's root: a node_modules folder, or else the last top-level code folder in the
// path, marks where the repository's own path starts.
const CHECKOUT_TAIL = /\/(?:src|scripts|tests)\/(?!.*\/(?:src|scripts|tests)\/)/;

function sourceOf(url) {
    let file = String(url || '');
    if (file.startsWith('file://')) {
        try { file = fileURLToPath(file); } catch { /* keep the raw url */ }
    }
    if (!path.isAbsolute(file)) return file;
    file = file.split(path.sep).join('/');
    const modules = file.indexOf('/node_modules/');
    if (modules >= 0) return file.slice(modules + 1);
    const tail = CHECKOUT_TAIL.exec(file);
    return tail ? file.slice(tail.index + 1) : file;
}

// Project code is what a fix can change: files of this repository outside node_modules.
const isProject = (source) => !!source && !source.startsWith('node:') && !path.isAbsolute(source)
    && !source.includes('node_modules/');

// A call frame as the reports name it: "<function> <file>:<line>" (shared with HeapProfile).
function frameOf(callFrame = {}) {
    const source = sourceOf(callFrame.url), name = callFrame.functionName || '(anonymous)';
    return { name, source, project: isProject(source),
        key: source ? `${name} ${source}:${(callFrame.lineNumber ?? -1) + 1}` : name };
}

function index(profile) {
    const nodes = new Map(), parent = new Map();
    for (const node of profile.nodes || []) {
        nodes.set(node.id, frameOf(node.callFrame));
        for (const child of node.children || []) parent.set(child, node.id);
    }
    const stacks = new Map();
    // Project frames from the sample's own frame up to the root, each once (recursion).
    const projectStack = (id) => {
        if (stacks.has(id)) return stacks.get(id);
        const keys = [];
        for (let at = id; at !== undefined; at = parent.get(at)) {
            const node = nodes.get(at);
            if (node?.project && !keys.includes(node.key)) keys.push(node.key);
        }
        stacks.set(id, keys);
        return keys;
    };
    return { nodes, projectStack };
}

// V8 keeps a profile's clock (us) in 32 bits: it wraps every 2^32 us (~71.6 min), so a chunk across
// the wrap ends "before" it starts (seen 2026-11-06: start 4 262 941 468, end 27 992 796). Sample
// times are startTime plus the timeDeltas, summed here without the wrap, so the profile's end and the
// previous chunk's end (`since`) are put on that same clock: the nearest value to the start modulo
// 2^32 (a chunk lasts a minute, far below half the wrap).
const CLOCK_WRAP = 2 ** 32;
const onClockOf = (start, time) => start + ((((time - start) % CLOCK_WRAP) + CLOCK_WRAP * 1.5) % CLOCK_WRAP - CLOCK_WRAP / 2);

// Time of each sample: until the next one (the last one: until the profile's end), in ms.
function timings(profile) {
    const samples = profile.samples || [], deltas = profile.timeDeltas || [];
    const at = new Array(samples.length), ms = new Array(samples.length);
    const start = profile.startTime || 0;
    let clock = start;
    for (let i = 0; i < samples.length; i++) {
        clock += deltas[i] || 0;
        at[i] = clock;
    }
    const end = profile.endTime ? Math.max(clock, onClockOf(start, profile.endTime)) : clock;
    for (let i = 0; i < samples.length; i++) {
        const next = i + 1 < samples.length ? at[i + 1] : end;
        ms[i] = Math.max(0, next - at[i]) / 1000;
    }
    return { at, ms, start, end };
}

function add(map, key, ms) {
    map.set(key, (map.get(key) || 0) + ms);
}

function top(map, count) {
    return [...map].sort((a, b) => b[1] - a[1]).slice(0, count)
        .map(([fn, ms]) => ({ fn, ms: Math.round(ms * 10) / 10 }));
}

function attribute(run, samples, ms, tree, count) {
    const self = new Map(), code = new Map();
    for (let i = run.from; i <= run.to; i++) {
        const node = tree.nodes.get(samples[i]);
        add(self, node?.key || '?', ms[i]);
        for (const key of tree.projectStack(samples[i])) add(code, key, ms[i]);
    }
    return { self: top(self, count), code: top(code, count) };
}

// A chunk whose profiler sampled less than once per STARVED_GAP_MS (a healthy one: every ~1.3 ms) is
// starved: seen on the cold worker (2026-11-04, ~110 samples a minute from the run's third minute
// on, main normal), each sample then weighs ~0.5 s and the whole chunk reads as one busy run. Its
// numbers say nothing about the thread: the recorder and the report leave it out.
const STARVED_GAP_MS = 20;
// A profiler can also starve in stretches while its average stays under STARVED_GAP_MS (2026-11-06,
// the cold worker's first minute: 3788 samples in 61.5 s, 120 gaps over 100 ms holding 19 s, read
// as one 60.6 s busy run). A gap between two samples longer than STARVED_STRETCH_MS (the long-turn
// length: a gap that long hides a turn the report would read as code cost; 2026-11-11, a busy
// laptop starved both threads in gaps of 50-100 ms that were neither counted nor left out) is a
// sample-less stretch: whether the thread went back to wait in it is unknown,
// so its time is neither busy nor idle (counted as unsampledMs) and it ends a busy run, as an idle
// sample does. Healthy threads still show some (2026-11-11: up to 17 a run, none over 70 ms, under
// 1.2 s in all); a starved one showed 272 (20 s), so the count a chunk reports (sampleGaps) tells them apart.
// A chunk with more than STARVED_SHARE of its time in such stretches is starved as a whole.
const STARVED_STRETCH_MS = 50;
const STARVED_SHARE = 0.1;

// longTurnMs: a busy run at least this long is a long turn. top: rows per list. keep: long turns
// listed with their time (the longest is also attributed). since: samples up to this time (profile
// clock, us) are left out: the part an overlapping chunk shares with the one before it.
function analyze(profile, { longTurnMs = 50, top: count = 8, keep = 20, since = 0 } = {}) {
    const tree = index(profile), samples = profile.samples || [];
    const { at, ms, start, end } = timings(profile);
    const from = since ? onClockOf(start, since) : -Infinity;
    const self = new Map(), files = new Map(), owners = new Map(), runs = [];
    let busyMs = 0, idleMs = 0, gcMs = 0, programMs = 0, unsampledMs = 0, stretches = 0, run = null, counted = 0;
    for (let i = 0; i < samples.length; i++) {
        if (at[i] <= from) continue;
        counted++;
        const node = tree.nodes.get(samples[i]) || { name: '?' };
        const unsampled = ms[i] > STARVED_STRETCH_MS;
        if (unsampled || node.name === IDLE) {
            if (unsampled) {
                unsampledMs += ms[i];
                stretches++;
            } else idleMs += ms[i];
            if (run) runs.push(run);
            run = null;
            continue;
        }
        busyMs += ms[i];
        if (node.name === GC) gcMs += ms[i];
        if (node.name === PROGRAM) programMs += ms[i];
        if (node.name !== ROOT_NODE) add(self, node.key || node.name, ms[i]);
        if (node.project) add(files, node.source, ms[i]);
        // The owner: the nearest project frame on the stack, so SQLite's native run() or a
        // JSON.stringify counts for the code that called it; without one, the frame itself.
        if (node.name !== ROOT_NODE) add(owners, tree.projectStack(samples[i])[0] || node.key || node.name, ms[i]);
        if (!run) run = { from: i, to: i, ms: 0, atMs: (at[i] - start) / 1000 };
        run.to = i;
        run.ms += ms[i];
    }
    if (run) runs.push(run);
    const long = runs.filter(r => r.ms >= longTurnMs);
    const longest = runs.reduce((best, r) => (!best || r.ms > best.ms ? r : best), null);
    const round = (value) => Math.round(value * 10) / 10;
    const durationMs = round(Math.max(0, end - Math.max(start, from)) / 1000);
    return {
        durationMs, samples: counted,
        starved: durationMs >= 1000 && (counted * STARVED_GAP_MS < durationMs || unsampledMs > STARVED_SHARE * durationMs),
        busyMs: round(busyMs), idleMs: round(idleMs), gcMs: round(gcMs), programMs: round(programMs),
        unsampledMs: round(unsampledMs), stretches,
        runs: runs.length,
        longTurns: long.length,
        longest: longest ? { ms: round(longest.ms), atMs: Math.round(longest.atMs),
            ...attribute(longest, samples, ms, tree, count) } : null,
        long: long.sort((a, b) => b.ms - a.ms).slice(0, keep)
            .map(r => ({ atMs: Math.round(r.atMs), ms: round(r.ms) })),
        self: top(self, count),
        files: top(files, count),
        owners: top(owners, count)
    };
}

// Node 24.15 writes the text of v8.startCpuProfile / Worker#startCpuProfile without escaping names:
// V8 names a regexp's code "RegExp: <source>", so a quote or backslash in a pattern breaks the
// JSON (seen on the real server: `"RegExp: \[(\d+)\((\d+)\)\]"`). The name runs up to the tail
// every regexp node has (no line, no script, no url); it is written again escaped. The pattern
// spells its quotes \x22: its own source is in the profile too, and must not hold the text it
// looks for (it did, and cut itself). A path with backslashes (a script on Windows) gets its lone
// backslashes doubled. Returns the text JSON.parse accepts.
const REGEXP_NAME = /\x22functionName\x22:\x22(RegExp: [\s\S]*?)\x22(,\x22lineNumber\x22:-1,\x22columnNumber\x22:-1,\x22scriptId\x22:0,\x22url\x22:\x22\x22)/g;

function repairText(text) {
    try {
        JSON.parse(text);
        return text;
    } catch {
        const names = text.replace(REGEXP_NAME, (match, name, tail) => `"functionName":${JSON.stringify(name)}${tail}`);
        try {
            JSON.parse(names);
            return names;
        } catch {
            return names.replace(/\\([\s\S])/g, (pair, next, at) => (/["\\/bfnrt]/.test(next)
                || (next === 'u' && /^[0-9a-fA-F]{4}$/.test(names.slice(at + 2, at + 6))) ? pair : `\\\\${next}`));
        }
    }
}

// The profile and the text it parsed from (repaired when Node wrote it broken), parsing once when
// the text is valid.
function parse(text) {
    try {
        return { profile: JSON.parse(text), text };
    } catch {
        const repaired = repairText(text);
        return { profile: JSON.parse(repaired), text: repaired };
    }
}

module.exports = { STARVED_STRETCH_MS, analyze, sourceOf, frameOf, repairText, parse };
