'use strict';

// The numbers of one window run (scripts/perf/window.js), read only from its folder: CPU of each
// profiled thread (busy, GC, long turns and the code that held them, where the time went), process
// CPU, memory (heap now and what grew between the window's two heap dumps). Writes summary.json,
// the input of compare.

const fs = require('fs');
const path = require('path');
const CpuProfile = require('../../src/Perf/CpuProfile');
const HeapProfile = require('../../src/Perf/HeapProfile');

const MB = 1048576;
const round = (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;

function readLines(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function load(dir) {
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    if (!run.windowStart || !run.windowEnd) throw new Error(`${path.basename(dir)} has no closed window (the run stopped early)`);
    const boot = fs.readdirSync(dir).find(name => /^\d{8}-\d{6}$/.test(name));
    if (!boot) throw new Error(`${path.basename(dir)} has no recorder folder`);
    const bootDir = path.join(dir, boot);
    const day = (kind) => fs.readdirSync(bootDir).filter(name => new RegExp(`^${kind}-\\d{8}\\.jsonl$`).test(name)).sort()
        .flatMap(name => readLines(path.join(bootDir, name)));
    return { run, bootDir, timeline: day('timeline'), spikes: day('spikes'), heap: readLines(path.join(bootDir, 'heap.jsonl')) };
}

function add(map, rows) {
    for (const row of rows) map.set(row.fn, (map.get(row.fn) || 0) + row.ms);
}

const top = (map, count, total) => [...map].sort((a, b) => b[1] - a[1]).slice(0, count)
    .map(([fn, ms]) => ({ fn, ms: round(ms), pct: total > 0 ? round(100 * ms / total, 1) : 0 }));

function p95(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

// One thread over the window: chunks that started in it, their kept profiles added up (each
// without the samples it shares with the chunk before), the code that held its long turns.
function threadSummary(data, label, start, end) {
    const chunks = data.timeline.filter(line => line.type === 'cpu' && line.thread === label)
        .filter(line => Date.parse(line.t) >= start && Date.parse(line.t) + line.ms <= end + 10000)
        .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const ms = chunks.reduce((sum, line) => sum + line.ms, 0);
    const busy = chunks.reduce((sum, line) => sum + line.busyMs, 0), gc = chunks.reduce((sum, line) => sum + line.gcMs, 0);
    const self = new Map(), files = new Map();
    let lastEnd = 0, profiled = 0, instance = null;
    for (const line of chunks) {
        if (line.instance !== instance) lastEnd = 0;
        instance = line.instance;
        const file = line.profile && path.join(data.bootDir, line.profile);
        if (!file || !fs.existsSync(file)) { lastEnd = 0; continue; }
        const profile = JSON.parse(CpuProfile.repairText(fs.readFileSync(file, 'utf8')));
        const a = CpuProfile.analyze(profile, { top: Infinity, since: lastEnd });
        lastEnd = profile.endTime || 0;
        profiled += a.busyMs;
        add(self, a.self);
        add(files, a.files);
    }
    const held = new Map();
    const spikes = data.spikes.filter(row => row.thread === label && Date.parse(row.chunk) >= start && Date.parse(row.chunk) <= end);
    for (const row of spikes) add(held, row.code);
    return {
        minutes: round(ms / 60000, 1),
        busyPct: ms ? round(100 * busy / ms, 1) : 0,
        gcPct: ms ? round(100 * gc / ms, 1) : 0,
        longTurnsPerMin: ms ? round(chunks.reduce((sum, line) => sum + line.longTurns, 0) / (ms / 60000), 1) : 0,
        longestMs: round(Math.max(0, ...chunks.map(line => line.longestMs))),
        chunkLongestP95Ms: round(p95(chunks.map(line => line.longestMs))),
        instances: new Set(chunks.map(line => line.instance)).size,
        longTurnCode: top(held, 10, 0).map(({ fn, ms: total }) => ({ fn, ms: total })),
        cpuSelf: top(self, 15, profiled),
        cpuFiles: top(files, 10, profiled)
    };
}

function range(values) {
    const list = values.filter(Number.isFinite);
    return list.length ? { start: round(list[0]), end: round(list.at(-1)), max: round(Math.max(...list)) } : null;
}

function summarize(dir) {
    const data = load(dir), start = Date.parse(data.run.windowStart), end = Date.parse(data.run.windowEnd);
    const seconds = (end - start) / 1000;
    const labels = [...new Set(data.timeline.filter(line => line.type === 'cpu').map(line => line.thread))];
    const threads = Object.fromEntries(labels.map(label => [label, threadSummary(data, label, start, end)]));
    const summaries = data.timeline.filter(line => line.type === 'summary' && Date.parse(line.t) > start && Date.parse(line.t) <= end);
    const cpuMs = summaries.reduce((sum, line) => sum + (line.main?.processCpuMs?.user || 0) + (line.main?.processCpuMs?.system || 0), 0);
    const recorderMs = summaries.reduce((sum, line) => sum + (line.recorder?.costMs || 0) + (line.recorder?.inspectorMs || 0), 0);
    const heapLabels = [...new Set(summaries.flatMap(line => Object.keys(line.heaps || {})))];
    // The two dumps of each sampled thread at the window's edges (the first and last in it).
    const growth = {};
    const edge = data.heap.filter(line => Date.parse(line.t) >= start - 120000 && Date.parse(line.t) <= end + 120000);
    for (const label of new Set(edge.map(line => line.thread))) {
        const lines = edge.filter(line => line.thread === label);
        const first = lines[0], last = lines.at(-1);
        if (!first || first === last || first.instance !== last.instance) continue;
        const read = (line) => JSON.parse(fs.readFileSync(path.join(data.bootDir, line.profile), 'utf8'));
        growth[label] = HeapProfile.diff(read(first), read(last), { top: 10 });
    }
    return {
        run: { ...data.run, folder: path.basename(dir) },
        windowMinutes: round(seconds / 60, 1),
        processCores: seconds ? round(cpuMs / 1000 / seconds, 2) : 0,
        recorderMainPct: seconds ? round(100 * recorderMs / 1000 / seconds, 2) : 0,
        coldDueMax: Math.max(0, ...summaries.map(line => line.coldQueue?.overdue || 0)),
        threads,
        memory: {
            mainHeapUsedMb: range(summaries.map(line => (line.main?.memory?.heapUsed || NaN) / MB)),
            rssMb: range(summaries.map(line => (line.main?.memory?.rss || NaN) / MB)),
            heaps: Object.fromEntries(heapLabels.map(label => [label, range(summaries.map(line => line.heaps?.[label]?.usedMb ?? NaN))])),
            growth
        }
    };
}

function print(s) {
    const r = s.run;
    console.log(`${r.folder}: ${r.sha}${r.dirty ? ' (uncommitted changes)' : ''}, ${r.scenario}, ${r.save.name}`);
    console.log(`  bots ${JSON.stringify(r.bots)}, ${r.warmupMinutes} min warm-up, window ${s.windowMinutes} min`
        + `; process ${s.processCores} cores, recorder ${s.recorderMainPct} % of main, cold due max ${s.coldDueMax}`);
    for (const [label, t] of Object.entries(s.threads)) {
        console.log(`\n${label}: busy ${t.busyPct} %, gc ${t.gcPct} %, long turns ${t.longTurnsPerMin}/min,`
            + ` longest ${t.longestMs} ms (p95 of chunk longest ${t.chunkLongestP95Ms} ms)${t.instances > 1 ? `, ${t.instances} instances` : ''}`);
        if (t.longTurnCode.length) console.log('  long turns held by:');
        for (const row of t.longTurnCode.slice(0, 6)) console.log(`  ${String(row.ms).padStart(8)} ms  ${row.fn}`);
        console.log('  cpu by function (self, % of profiled busy time):');
        for (const row of t.cpuSelf.slice(0, 10)) console.log(`  ${String(row.pct).padStart(6)} %  ${row.fn}`);
        console.log('  cpu by project file:');
        for (const row of t.cpuFiles.slice(0, 6)) console.log(`  ${String(row.pct).padStart(6)} %  ${row.fn}`);
    }
    const m = s.memory, line = (v) => (v ? `${v.start}->${v.end} MB (max ${v.max})` : '-');
    console.log(`\nmemory: main heap ${line(m.mainHeapUsedMb)}, rss ${line(m.rssMb)}`);
    for (const [label, v] of Object.entries(m.heaps)) console.log(`  ${label}: ${line(v)}`);
    for (const [label, d] of Object.entries(m.growth)) {
        console.log(`  ${label} sampled live ${d.beforeMb}->${d.afterMb} MB; grew under:`);
        for (const row of d.code.slice(0, 5)) console.log(`  ${String(row.mb).padStart(7)} MB  ${row.fn}`);
    }
}

function report(dir) {
    const s = summarize(dir);
    fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(s, null, 2)}\n`);
    print(s);
    return s;
}

module.exports = { report, summarize };
