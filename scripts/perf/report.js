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

// Where a thread's time goes by part of the server, from the files of its functions (project code
// by folder; node internals, GC and native time apart).
const SUBSYSTEMS = [
    ['perf recorder', /^src\/Perf\//],
    ['hot bot AI', /^src\/GameServer\/Bot\/(AI\/|BotAI\.js|Goals\/|BotManager\.js|BotSession\.js)/],
    ['population, cold, transitions', /^src\/GameServer\/Bot\/Population\//],
    ['economy, trade', /^src\/GameServer\/(Bot\/Economy\/|AfkTrade\/)/],
    ['database', /^src\/(Database|HistoryStore|DatabaseStatements)|^src\/GameServer\/Persistence\//],
    ['network, packets', /^src\/(GameServer\/Network\/|Packet\/|Server\.js)|^src\/GameServer\/Session\.js/],
    ['world, actors, combat', /^src\/GameServer\/(World|Actor|Npc|Combat|Skills|Geodata)\//],
    ['other bot code', /^src\/GameServer\/Bot\//],
    ['other project code', /^(src|scripts)\//],
    ['gc', /^\(garbage collector\)$/],
    ['node internals', /^node:/]
];

function subsystemOf(fn) {
    const source = / (\S+):\d+$/.exec(fn)?.[1] || fn;
    return SUBSYSTEMS.find(([, pattern]) => pattern.test(source))?.[0] || 'native, program';
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
        const { profile } = CpuProfile.parse(fs.readFileSync(file, 'utf8'));
        const a = CpuProfile.analyze(profile, { top: Infinity, since: lastEnd });
        lastEnd = profile.endTime || 0;
        profiled += a.busyMs;
        add(self, a.self);
        add(files, a.files);
    }
    const parts = new Map();
    for (const [fn, ms] of self) parts.set(subsystemOf(fn), (parts.get(subsystemOf(fn)) || 0) + ms);
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
        cpuFiles: top(files, 10, profiled),
        cpuParts: top(parts, SUBSYSTEMS.length + 1, profiled).map(({ fn, ms: total, pct }) => ({ part: fn, ms: total, pct }))
    };
}

// What the hot scenario's player felt (src/Perf/HotCrowd). The limits are the old mixed load
// test's (MixedRuntimeSlo, removed with it), kept as the verdict: a packet waiting 40 ms at p95 is felt.
const PLAYER_LIMITS = { scheduleP95Ms: 40, scheduleP99Ms: 120, scheduleMaxMs: 150, handlerP95Ms: 25, handlerP99Ms: 75 };

function quantiles(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
    return { samples: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1) };
}

function playerSummary(lines) {
    if (!lines.length) return null;
    const schedule = quantiles(lines.flatMap(line => line.scheduleMs || []));
    const handler = quantiles(lines.flatMap(line => line.handlerMs || []));
    if (!schedule || !handler) return null;
    const over = [['schedule p95', schedule.p95Ms, PLAYER_LIMITS.scheduleP95Ms], ['schedule p99', schedule.p99Ms, PLAYER_LIMITS.scheduleP99Ms],
        ['schedule max', schedule.maxMs, PLAYER_LIMITS.scheduleMaxMs], ['handler p95', handler.p95Ms, PLAYER_LIMITS.handlerP95Ms],
        ['handler p99', handler.p99Ms, PLAYER_LIMITS.handlerP99Ms]].filter(([, value, limit]) => value > limit)
        .map(([what, value, limit]) => `${what} ${value} > ${limit} ms`);
    const hot = lines.map(line => line.hot).filter(Number.isFinite);
    const sum = (key) => lines.reduce((total, line) => total + (Number(line[key]) || 0), 0);
    const seconds = sum('seconds'), players = Math.max(1, ...lines.map(line => line.players || 1));
    return { schedule, handler, errors: sum('errors'),
        hotAvg: hot.length ? round(hot.reduce((a, b) => a + b, 0) / hot.length) : 0, hotMax: Math.max(0, ...hot),
        players, moves: sum('moves'),
        // What the server sent each player: the crowd's broadcasts a client has to take.
        packetsPerSecond: seconds ? round(sum('packets') / seconds / players, 1) : 0,
        kbPerSecond: seconds ? round(sum('bytes') / 1024 / seconds / players, 1) : 0,
        limits: PLAYER_LIMITS, over };
}

// cold <-> hot transitions over the window (PopulationMetrics, with developerDiagnostics): how many,
// and how long one took. p95 and max are the worst of the 30 s windows.
function transitionsSummary(lines) {
    const metrics = lines.map(line => line.population?.metrics).filter(Boolean);
    if (!metrics.length) return null;
    const of = (kind) => {
        const windows = metrics.map(m => m.transitions?.[kind]).filter(t => t?.count);
        const count = windows.reduce((sum, t) => sum + t.count, 0);
        return { count, avgMs: count ? round(windows.reduce((sum, t) => sum + t.avgMs * t.count, 0) / count) : 0,
            p95Ms: Math.max(0, ...windows.map(t => t.p95Ms)), maxMs: Math.max(0, ...windows.map(t => t.maxMs)) };
    };
    const delta = (key) => metrics.reduce((sum, m) => sum + (Number(m.delta?.[key]) || 0), 0);
    return { activation: of('activation'), cooldown: of('cooldown'), handoffs: delta('coldOwnerHandoffs') };
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
        player: playerSummary(data.timeline.filter(line => line.type === 'player' && Date.parse(line.t) > start && Date.parse(line.t) <= end)),
        transitions: transitionsSummary(summaries),
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
    if (s.player) {
        const p = s.player, q = (x) => `p50 ${x.p50Ms} / p95 ${x.p95Ms} / p99 ${x.p99Ms} / max ${x.maxMs} ms`;
        console.log(`\nplayer (${p.schedule.samples} probes, hot bots avg ${p.hotAvg} max ${p.hotMax}): ${p.over.length ? `OVER: ${p.over.join(', ')}` : 'within limits'}`);
        console.log(`  waited for the loop: ${q(p.schedule)}`);
        console.log(`  position handler:    ${q(p.handler)}${p.errors ? `, ${p.errors} errors` : ''}`);
        console.log(`  sent to each of ${p.players} player(s): ${p.packetsPerSecond} packets/s, ${p.kbPerSecond} KB/s; ${p.moves} teleport(s)`);
    }
    if (s.transitions) {
        const t = s.transitions, line = (x) => `${x.count} (avg ${x.avgMs} / p95 ${x.p95Ms} / max ${x.maxMs} ms)`;
        console.log(`\ntransitions: cold -> hot ${line(t.activation)}; hot -> cold ${line(t.cooldown)}; handoffs ${t.handoffs}`);
    } else if (s.run.scenario === 'hot') console.log('\ntransitions: none recorded (run with --diagnostics)');
    for (const [label, t] of Object.entries(s.threads)) {
        console.log(`\n${label}: busy ${t.busyPct} %, gc ${t.gcPct} %, long turns ${t.longTurnsPerMin}/min,`
            + ` longest ${t.longestMs} ms (p95 of chunk longest ${t.chunkLongestP95Ms} ms)${t.instances > 1 ? `, ${t.instances} instances` : ''}`);
        if (t.longTurnCode.length) console.log('  long turns held by:');
        for (const row of t.longTurnCode.slice(0, 6)) console.log(`  ${String(row.ms).padStart(8)} ms  ${row.fn}`);
        console.log(`  by part: ${t.cpuParts.map(row => `${row.part} ${row.pct} %`).join(', ')}`);
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
