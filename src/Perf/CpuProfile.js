'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

// Reads a V8 CPU profile (.cpuprofile: a call tree, the node of each sample, the time between
// samples). A busy run is a stretch of samples with no "(idle)" between them: the thread did not
// get back to waiting for I/O, so on main it is a turn of the event loop that every player packet
// waited for. Pure; shared by the live recorder and scripts/perf.js.

const ROOT = path.resolve(__dirname, '..', '..');
const IDLE = '(idle)', GC = '(garbage collector)', PROGRAM = '(program)', ROOT_NODE = '(root)';

function sourceOf(url) {
    let file = String(url || '');
    if (file.startsWith('file://')) {
        try { file = fileURLToPath(file); } catch { /* keep the raw url */ }
    }
    if (file.startsWith(ROOT + path.sep)) return path.relative(ROOT, file).split(path.sep).join('/');
    return file;
}

// Project code is what a fix can change: files of this repository outside node_modules.
const isProject = (source) => !!source && !source.startsWith('node:') && !path.isAbsolute(source)
    && !source.includes('node_modules/');

function index(profile) {
    const nodes = new Map(), parent = new Map();
    for (const node of profile.nodes || []) {
        const frame = node.callFrame || {}, source = sourceOf(frame.url);
        const name = frame.functionName || '(anonymous)';
        nodes.set(node.id, { name, source, project: isProject(source),
            key: source ? `${name} ${source}:${(frame.lineNumber ?? -1) + 1}` : name });
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

// Time of each sample: until the next one (the last one: until the profile's end), in ms.
function timings(profile) {
    const samples = profile.samples || [], deltas = profile.timeDeltas || [];
    const at = new Array(samples.length), ms = new Array(samples.length);
    let clock = profile.startTime || 0;
    for (let i = 0; i < samples.length; i++) {
        clock += deltas[i] || 0;
        at[i] = clock;
    }
    for (let i = 0; i < samples.length; i++) {
        const next = i + 1 < samples.length ? at[i + 1] : (profile.endTime || at[i]);
        ms[i] = Math.max(0, next - at[i]) / 1000;
    }
    return { at, ms };
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

// longTurnMs: a busy run at least this long is a long turn. top: rows per list. keep: long turns
// listed with their time (the longest is also attributed). since: samples up to this time (profile
// clock, us) are left out: the part an overlapping chunk shares with the one before it.
function analyze(profile, { longTurnMs = 50, top: count = 8, keep = 20, since = 0 } = {}) {
    const tree = index(profile), samples = profile.samples || [];
    const { at, ms } = timings(profile);
    const self = new Map(), files = new Map(), runs = [];
    let busyMs = 0, idleMs = 0, gcMs = 0, programMs = 0, run = null;
    for (let i = 0; i < samples.length; i++) {
        if (at[i] <= since) continue;
        const node = tree.nodes.get(samples[i]) || { name: '?' };
        if (node.name === IDLE) {
            idleMs += ms[i];
            if (run) runs.push(run);
            run = null;
            continue;
        }
        busyMs += ms[i];
        if (node.name === GC) gcMs += ms[i];
        if (node.name === PROGRAM) programMs += ms[i];
        if (node.name !== ROOT_NODE) add(self, node.key || node.name, ms[i]);
        if (node.project) add(files, node.source, ms[i]);
        if (!run) run = { from: i, to: i, ms: 0, atMs: (at[i] - (profile.startTime || 0)) / 1000 };
        run.to = i;
        run.ms += ms[i];
    }
    if (run) runs.push(run);
    const long = runs.filter(r => r.ms >= longTurnMs);
    const longest = runs.reduce((best, r) => (!best || r.ms > best.ms ? r : best), null);
    const round = (value) => Math.round(value * 10) / 10;
    return {
        durationMs: round(Math.max(0, (profile.endTime || 0) - Math.max(profile.startTime || 0, since)) / 1000),
        busyMs: round(busyMs), idleMs: round(idleMs), gcMs: round(gcMs), programMs: round(programMs),
        runs: runs.length,
        longTurns: long.length,
        longest: longest ? { ms: round(longest.ms), atMs: Math.round(longest.atMs),
            ...attribute(longest, samples, ms, tree, count) } : null,
        long: long.sort((a, b) => b.ms - a.ms).slice(0, keep)
            .map(r => ({ atMs: Math.round(r.atMs), ms: round(r.ms) })),
        self: top(self, count),
        files: top(files, count)
    };
}

module.exports = { analyze, sourceOf };
