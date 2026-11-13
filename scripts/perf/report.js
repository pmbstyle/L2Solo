'use strict';

// The numbers of one window run (scripts/perf/window.js), read only from its folder: CPU of each
// profiled thread (busy, GC, long turns and the code that held them, where the time went), process
// CPU, memory (heap now and what grew between the window's two heap dumps). Writes summary.json,
// the input of compare.

const fs = require('fs');
const path = require('path');
const CpuProfile = require('../../src/Perf/CpuProfile');
const HeapProfile = require('../../src/Perf/HeapProfile');
const StepLateness = require('../../src/GameServer/Bot/Population/StepLateness');

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
    ['bot AI, goals', /^src\/GameServer\/Bot\/(AI\/|BotAI\.js|Goals\/|BotManager\.js|BotSession\.js)/],
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


// One thread over the window: chunks that started in it, their kept profiles added up (each
// without the samples it shares with the chunk before), the code that held its long turns.
function threadSummary(data, label, start, end) {
    const window = data.timeline.filter(line => line.type === 'cpu' && line.thread === label)
        .filter(line => Date.parse(line.t) >= start && Date.parse(line.t) + line.ms <= end + 10000)
        .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const self = new Map(), files = new Map(), owners = new Map(), starved = new Set();
    let lastEnd = 0, profiled = 0, instance = null;
    for (const line of window) {
        if (line.instance !== instance) lastEnd = 0;
        instance = line.instance;
        if (line.starved) starved.add(line);
        const file = line.profile && path.join(data.bootDir, line.profile);
        // A chunk without its file still ends where the next one's overlap begins.
        if (!file || !fs.existsSync(file)) { lastEnd = line.endTime || 0; continue; }
        const { profile } = CpuProfile.parse(fs.readFileSync(file, 'utf8'));
        const a = CpuProfile.analyze(profile, { top: Infinity, since: lastEnd });
        lastEnd = profile.endTime || line.endTime || 0;
        // A run recorded before the recorder marked them: its starved chunks were kept as spikes.
        if (a.starved) starved.add(line);
        if (starved.has(line)) continue;
        profiled += a.busyMs;
        add(self, a.self);
        add(files, a.files);
        add(owners, a.owners);
    }
    // A starved chunk (CpuProfile) says nothing of the thread: left out, and counted. A usable one's
    // stretches without samples are in neither its busy nor its idle time: left out of its length.
    const chunks = window.filter(line => !starved.has(line));
    const unsampled = chunks.reduce((sum, line) => sum + (line.unsampledMs || 0), 0);
    const gaps = chunks.reduce((sum, line) => sum + (line.sampleGaps || 0), 0);
    const ms = chunks.reduce((sum, line) => sum + line.ms, 0) - unsampled;
    const busy = chunks.reduce((sum, line) => sum + line.busyMs, 0), gc = chunks.reduce((sum, line) => sum + line.gcMs, 0);
    // By part of the server, each sample charged to its owner (native time to the project code that
    // called it: SQLite counts as database, not as native).
    const parts = new Map();
    for (const [fn, ms] of owners) parts.set(subsystemOf(fn), (parts.get(subsystemOf(fn)) || 0) + ms);
    const held = new Map();
    const starvedAt = new Set([...starved].map(line => line.t));
    const spikes = data.spikes.filter(row => row.thread === label && Date.parse(row.chunk) >= start && Date.parse(row.chunk) <= end
        && !starvedAt.has(row.chunk));
    for (const row of spikes) add(held, row.code);
    return {
        minutes: round(ms / 60000, 1),
        // No usable chunk (every one starved): no numbers, so compare shows none instead of a 0.
        busyPct: ms ? round(100 * busy / ms, 1) : null,
        gcPct: ms ? round(100 * gc / ms, 1) : null,
        longTurnsPerMin: ms ? round(chunks.reduce((sum, line) => sum + line.longTurns, 0) / (ms / 60000), 1) : null,
        longestMs: chunks.length ? round(Math.max(0, ...chunks.map(line => line.longestMs))) : null,
        chunkLongestP95Ms: chunks.length ? round(quantiles(chunks.map(line => line.longestMs))?.p95Ms || 0) : null,
        instances: new Set(chunks.map(line => line.instance)).size,
        starvedChunks: starved.size,
        unsampledSec: round(unsampled / 1000, 1), sampleGaps: chunks.some(line => line.sampleGaps !== undefined) ? gaps : null,
        longTurnCode: top(held, 10, 0).map(({ fn, ms: total }) => ({ fn, ms: total })),
        cpuSelf: top(self, 60, profiled),
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
        players, wanted: Math.max(players, ...lines.map(line => line.wanted || 0)), moves: sum('moves'),
        failedMoves: sum('failedMoves'), deaths: sum('deaths'),
        // What the server sent each player: the crowd's broadcasts a client has to take.
        packetsPerSecond: seconds ? round(sum('packets') / seconds / players, 1) : 0,
        kbPerSecond: seconds ? round(sum('bytes') / 1024 / seconds / players, 1) : 0,
        limits: PLAYER_LIMITS, over };
}

// cold <-> hot transitions over the window (PopulationMetrics, with developerDiagnostics): how many
// (the counters, uncapped) and how long one took (the timed samples, at most 200 per 30 s window, so
// avg is of those; p95 and max are the worst of the 30 s windows).
// How late the worker's steps committed past their due (StepLateness), over the health lines'
// windows: boot (before the perf window) and steady (inside it); drainedS: from the first line to
// the first one whose window's latest step was at most 1 s late (the boot backlog gone).
function workerDueSummary(lines, start, end) {
    const part = list => {
        const counts = StepLateness.empty();
        let maxMs = 0, maxBot = null;
        for (const line of list) {
            const window = line.coordinator?.stepLate;
            if (!window) continue;
            StepLateness.add(counts, window.counts);
            if (Number(window.maxMs) > maxMs) [maxMs, maxBot] = [Number(window.maxMs), window.maxBot || null];
        }
        return { ...StepLateness.summary(counts, maxMs), maxBot };
    };
    const windows = lines.filter(line => line.coordinator?.stepLate?.steps > 0);
    const drained = windows.find(line => line.coordinator.stepLate.maxMs <= 1000);
    return {
        boot: part(lines.filter(line => Date.parse(line.t) <= start)),
        steady: part(lines.filter(line => Date.parse(line.t) > start && Date.parse(line.t) <= end)),
        drainedS: drained && lines.length ? Math.round((Date.parse(drained.t) - Date.parse(lines[0].t)) / 1000) : null
    };
}

function transitionsSummary(lines) {
    const metrics = lines.map(line => line.population?.metrics).filter(Boolean);
    if (!metrics.length) return null;
    const delta = (key) => metrics.reduce((sum, m) => sum + (Number(m.delta?.[key]) || 0), 0);
    const of = (kind, counter) => {
        const windows = metrics.map(m => m.transitions?.[kind]).filter(t => t?.count);
        const timed = windows.reduce((sum, t) => sum + t.count, 0);
        return { count: delta(counter), avgMs: timed ? round(windows.reduce((sum, t) => sum + t.avgMs * t.count, 0) / timed) : 0,
            p95Ms: Math.max(0, ...windows.map(t => t.p95Ms)), maxMs: Math.max(0, ...windows.map(t => t.maxMs)) };
    };
    // Refused activations by reason (HotActivation), summed over the windows.
    const refusalReasons = {};
    metrics.forEach(m => Object.entries(m.activationRefusalReasons || {}).forEach(([reason, count]) => {
        refusalReasons[reason] = (refusalReasons[reason] || 0) + (Number(count) || 0);
    }));
    return { activation: of('activation', 'activations'), cooldown: of('cooldown', 'cooldowns'), handoffs: delta('coldOwnerHandoffs'),
        refusals: { count: delta('activationRefusals'), reasons: refusalReasons } };
}

// The live server's context over the window (PopulationStatus.vitals, the recorder's files and
// machine readings): load, the database and its WAL, the commit queue, failures and repairs.
function contextSummary(summaries, timeline, start, end) {
    // Counters that only grow are taken from the last line before the window to the last one in it.
    const before = timeline.filter(line => line.type === 'summary' && Date.parse(line.t) <= start).at(-1);
    const grown = (read) => {
        const inside = summaries.map(read).filter(Number.isFinite);
        if (!inside.length) return 0;
        const base = before ? read(before) : NaN;
        return inside.at(-1) - (Number.isFinite(base) ? base : inside[0]);
    };
    const vitals = summaries.map(line => line.vitals).filter(Boolean);
    const values = (read) => summaries.map(read).filter(Number.isFinite);
    const avg = (list) => (list.length ? round(list.reduce((a, b) => a + b, 0) / list.length, 1) : null);
    const max = (list) => (list.length ? Math.max(...list) : null);
    const min = (list) => (list.length ? Math.min(...list) : null);
    const queue = summaries.map(line => line.coordinator?.queue).filter(Boolean);
    const failures = summaries.map(line => line.coordinator?.failures).filter(Boolean);
    // Database operations by time spent (cumulative counters, diagnostics on): the window's share.
    const ops = vitals.map(v => v.database?.operations).filter(Boolean);
    const operations = ops.length > 1 ? Object.entries(ops.at(-1)).map(([name, after]) => {
        const before = ops[0][name] || {};
        return { op: name, count: (after.count || 0) - (before.count || 0), runMs: Math.round((after.runMs || 0) - (before.runMs || 0)),
            waitMs: Math.round((after.waitMs || 0) - (before.waitMs || 0)) };
    }).filter(row => row.count > 0).sort((a, b) => b.runMs - a.runMs).slice(0, 8) : [];
    const checkpoints = new Set(vitals.map(v => v.database?.checkpoint?.last && JSON.stringify(v.database.checkpoint.last)).filter(Boolean));
    // The WAL truncate's last try and last success (time, ok, busy, duration) as of the last line, and the
    // maintenance refusals (state retention, WAL truncate: job:reason) counted in the window.
    const reset = (entry) => (entry ? { at: entry.at ? new Date(entry.at).toISOString() : null, ok: !!entry.ok, busy: entry.busy || 0,
        durationMs: entry.durationMs != null ? round(entry.durationMs, 1) : null, ...(entry.error ? { error: entry.error } : {}) } : null);
    const lastCheckpoint = vitals.at(-1)?.database?.checkpoint || {};
    const refusalsAt = (line) => line?.vitals?.database?.maintenance?.refusals || null;
    const refusalsBase = refusalsAt(before) || refusalsAt(summaries.find(refusalsAt)) || {};
    const refusals = Object.fromEntries(Object.entries(refusalsAt(summaries.findLast(refusalsAt)) || {})
        .map(([key, count]) => [key, count - (refusalsBase[key] || 0)]).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]));
    // DB jobs that ran past the queue's drain slice alone: op -> count in the window, max ms since start.
    const overAt = (line) => line?.vitals?.database?.overBudgetJobs || null;
    const overBase = overAt(before) || overAt(summaries.find(overAt)) || {};
    const overBudgetJobs = Object.entries(overAt(summaries.findLast(overAt)) || {})
        .map(([op, after]) => ({ op, count: after.count - (overBase[op]?.count || 0), maxMs: after.maxMs }))
        .filter(row => row.count > 0).sort((a, b) => b.count - a.count);
    // A restart is a start of a thread whose same name exited before (a shutdown's exits are not).
    const exited = new Set(), restarts = [];
    for (const mark of timeline.filter(line => line.type === 'thread' && Date.parse(line.t) <= end)) {
        if (mark.event === 'exit') exited.add(mark.thread);
        else if (exited.has(mark.thread)) {
            exited.delete(mark.thread);
            if (Date.parse(mark.t) >= start) restarts.push(mark.thread);
        }
    }
    if (!vitals.length && !queue.length) return null;
    return {
        load: { hotAvg: avg(values(line => line.vitals?.bots?.hot)), coldAvg: avg(values(line => line.vitals?.bots?.cold)),
            playersMax: max(values(line => line.vitals?.players)), lagSustainedMaxMs: max(values(line => line.vitals?.lag?.sustainedMs)) },
        database: { pendingMax: max(values(line => line.vitals?.database?.pending)), maxPending: max(values(line => line.vitals?.database?.maxPending)),
            walMb: range(values(line => line.files?.walMb)), worldMb: range(values(line => line.files?.worldMb)),
            historyWalMb: range(values(line => line.files?.historyWalMb)), checkpoints: Math.max(0, checkpoints.size - 1), operations,
            walTruncate: { last: reset(lastCheckpoint.lastResetAttempt), lastEmptied: reset(lastCheckpoint.lastReset) }, maintenanceRefusals: refusals, overBudgetJobs },
        commitQueue: { depthMax: max(queue.map(q => q.depth)), bytesMaxKb: max(queue.map(q => Math.round((q.bytes || 0) / 1024))),
            oldestMaxMs: max(queue.map(q => q.oldestMs)), pausedShare: queue.length ? round(queue.filter(q => q.paused).length / queue.length, 2) : 0 },
        failures: { workerFaults: grown(line => line.coordinator?.failures?.workerFaults), faultBots: max(failures.map(f => (f.faultBackoff || 0) + (f.faultQuarantined || 0))),
            quarantinedMax: max(failures.map(f => f.faultQuarantined || 0)), commandDbErrors: grown(line => line.coordinator?.failures?.commandDbErrors),
            lastFault: failures.at(-1)?.lastFault || null, afterCommitErrors: grown(line => line.coordinator?.queue?.failures?.afterCommitErrors),
            // Failures the code survived (FailureLog by site, main + worker): grown in the window, and the sites.
            swallowed: grown(line => (line.coordinator?.failures?.swallowed ? swallowedTotal(line.coordinator.failures.swallowed) : NaN)),
            swallowedSites: failures.at(-1)?.swallowed || null,
            safetyRepairs: vitals.at(-1)?.safetyRepairs || null, pathQueueMax: max(values(line => line.vitals?.pathWorkers?.queue)),
            restarts },
        memory: { mainHeapAfterGcMb: range(values(line => line.vitals?.mainHeap?.afterGc)),
            mainGc: gcPauses(summaries.map(line => ({ t: Date.parse(line.t), gc: line.main?.gc })), before && { t: Date.parse(before.t), gc: before.main?.gc }),
            geodataMb: range(values(line => Math.round((line.vitals?.geodata?.loadedBytes || 0) / MB) || NaN)),
            freeMemMinMb: min(values(line => line.machine?.freeMemMb)),
            majorPageFaults: grown(line => line.machine?.majorPageFaults) }
    };
}

// GC pauses by kind over the window from records { t, gc } in time order (main: its summary lines; the worker:
// its turn windows), gc = { kind: { count, ms, maxMs } } with count and ms cumulative and maxMs the longest
// since the record before: count and ms from the record before the window (else its first) to its last, per
// minute of that span, and the longest in the window; null without two records.
function gcPauses(records, before) {
    const list = records.filter(record => record.gc);
    const last = list.at(-1), base = before?.gc ? before : list[0];
    const minutes = last ? (last.t - base.t) / 60000 : 0;
    if (!(minutes > 0)) return null;
    return Object.fromEntries(Object.entries(last.gc).map(([kind, after]) => {
        const from = base.gc[kind] || {};
        return [kind, { perMin: round((after.count - (from.count || 0)) / minutes, 1),
            msPerMin: round((after.ms - (from.ms || 0)) / minutes, 1),
            maxMs: Math.max(0, ...list.filter(record => record !== base).map(record => record.gc[kind]?.maxMs || 0)) }];
    }));
}

// Turn length per thread over the window: event-loop delay at 5 ms (a turn is one task, not tasks back to back),
// main's per summary line (PopulationMetrics), the worker's per its own 30 s window (each read once, by its end)
// with its GC pauses by kind. p99Ms is the worst window's p99, p99MedianMs the median window's, maxMs the longest
// turn; null for a thread without a window (diagnostics off, a run recorded before these were).
function turnsSummary(timeline, start, end) {
    const inside = (t) => t > start && t <= end;
    const summaries = timeline.filter(line => line.type === 'summary');
    const main = summaries.filter(line => inside(Date.parse(line.t)) && line.population?.metrics?.eventLoop?.delay?.samples > 0)
        .map(line => line.population.metrics.eventLoop.delay);
    const seen = new Set(), worker = [];
    let workerBefore = null;
    for (const line of summaries) {
        const turn = line.coordinator?.worker?.turn;
        if (!turn || seen.has(turn.at)) continue;
        seen.add(turn.at);
        if (turn.at <= start) workerBefore = { t: turn.at, gc: turn.gc };
        else if (turn.at <= end) worker.push(turn);
    }
    const of = (windows) => {
        if (!windows.length) return null;
        const p99 = windows.map(window => window.p99Ms).sort((a, b) => a - b);
        return { windows: windows.length, p99Ms: p99.at(-1), p99MedianMs: p99[Math.floor((p99.length - 1) / 2)],
            maxMs: Math.max(...windows.map(window => window.maxMs)) };
    };
    const workerTurns = of(worker);
    if (workerTurns) workerTurns.gc = gcPauses(worker.map(turn => ({ t: turn.at, gc: turn.gc })), workerBefore);
    return { main: of(main), worker: workerTurns };
}

function swallowedTotal(sites) {
    return Object.values(sites).reduce((sum, count) => sum + (Number(count) || 0), 0);
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
        workerDue: workerDueSummary(data.timeline.filter(line => line.type === 'summary'), start, end),
        turns: turnsSummary(data.timeline, start, end),
        player: playerSummary(data.timeline.filter(line => line.type === 'player' && Date.parse(line.t) > start && Date.parse(line.t) <= end)),
        transitions: transitionsSummary(summaries),
        e2e: data.timeline.some(line => line.type === 'e2e' || line.type === 'e2e-done') ? {
            steps: data.timeline.filter(line => line.type === 'e2e').map(({ step, ok, ms, error, packets }) => ({ step, ok, ms, error, packets })),
            done: data.timeline.find(line => line.type === 'e2e-done') || null } : null,
        context: contextSummary(summaries, data.timeline, start, end),
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
    if (s.workerDue) {
        const due = (x) => `p50 ${x.p50Ms} / p99 ${x.p99Ms} / max ${x.maxMs} ms${x.maxBot ? ` (bot ${x.maxBot.characterId}`
            + `${x.maxBot.eventWaitMs ? `, ${x.maxBot.eventWaitMs} ms event wait off` : ''})` : ''} over ${x.steps} steps`;
        console.log(`  worker due (commit past due): steady ${due(s.workerDue.steady)}; boot ${due(s.workerDue.boot)}`
            + `, drained ${s.workerDue.drainedS ?? '-'} s`);
    }
    const turn = (x) => (x ? `p99 ${x.p99Ms} (median window ${x.p99MedianMs}) / max ${x.maxMs} ms over ${x.windows} windows` : '-');
    console.log(`  turns (loop delay): main ${turn(s.turns.main)}; worker ${turn(s.turns.worker)}`);
    const pauses = (gc) => Object.entries(gc).map(([kind, p]) => `${kind} ${p.perMin} (${p.msPerMin} ms, longest ${p.maxMs} ms)`).join(', ');
    if (s.turns.worker?.gc) console.log(`  worker GC pauses per minute: ${pauses(s.turns.worker.gc)}`);
    if (s.e2e) {
        const failed = s.e2e.steps.filter(row => !row.ok).length;
        console.log(`\ne2e ${s.run.script || ''}: ${s.e2e.steps.length} step(s), ${failed} failed${s.e2e.done ? '' : ', NOT FINISHED in the window'}`);
        for (const row of s.e2e.steps) {
            console.log(`  ${row.ok ? 'ok  ' : 'FAIL'} ${String(row.ms ?? '-').padStart(6)} ms  ${row.step}${row.ok ? '' : `: ${row.error}`}`);
            if (!row.ok && row.packets?.length) console.log(`        server sent: ${row.packets.join(', ')}`);
        }
    }
    if (s.player) {
        const p = s.player, q = (x) => `p50 ${x.p50Ms} / p95 ${x.p95Ms} / p99 ${x.p99Ms} / max ${x.maxMs} ms`;
        console.log(`\nplayer (${p.schedule.samples} probes, hot bots avg ${p.hotAvg} max ${p.hotMax}): ${p.over.length ? `OVER: ${p.over.join(', ')}` : 'within limits'}`);
        console.log(`  waited for the loop: ${q(p.schedule)}`);
        console.log(`  position handler:    ${q(p.handler)}${p.errors ? `, ${p.errors} errors` : ''}`);
        console.log(`  sent to each of ${p.players} player(s): ${p.packetsPerSecond} packets/s, ${p.kbPerSecond} KB/s; ${p.moves} teleport(s)`
            + `${p.failedMoves ? `, ${p.failedMoves} failed` : ''}${p.deaths ? `, ${p.deaths} death(s) revived` : ''}`
            + `${p.wanted > p.players ? `; only ${p.players} of ${p.wanted} player(s) spawned` : ''}`);
    }
    if (s.transitions) {
        const t = s.transitions, line = (x) => `${x.count} (avg ${x.avgMs} / p95 ${x.p95Ms} / max ${x.maxMs} ms)`;
        const refused = Object.entries(t.refusals?.reasons || {}).map(([reason, count]) => `${reason} ${count}`).join(', ');
        console.log(`\ntransitions: cold -> hot ${line(t.activation)}; hot -> cold ${line(t.cooldown)}; handoffs ${t.handoffs}; `
            + `refused ${t.refusals?.count || 0}${refused ? ` (${refused})` : ''}`);
    } else if (s.run.scenario === 'hot') console.log('\ntransitions: none recorded (run with --diagnostics)');
    if (s.run.scenario === 'hot' && !s.player) console.log('\nplayer: none in the window: the hot scenario did not start (server.log, "hot scenario")');
    // A short window (a script that ends before a CPU chunk does) has no chunk of its own to show.
    const shown = Object.entries(s.threads).filter(([, t]) => t.minutes > 0 || t.starvedChunks > 0);
    if (!shown.length && Object.keys(s.threads).length) console.log('\ncpu: no chunk ended inside the window (it was shorter than [Perf] cpuChunkSeconds)');
    for (const [label, t] of shown) {
        if (!t.minutes) {
            console.log(`\n${label}: no usable cpu chunk, ${t.starvedChunks} starved ones left out (the profiler sampled too rarely)`);
            continue;
        }
        console.log(`\n${label}: busy ${t.busyPct} %, gc ${t.gcPct} %, long turns ${t.longTurnsPerMin}/min,`
            + ` longest ${t.longestMs} ms (p95 of chunk longest ${t.chunkLongestP95Ms} ms)${t.instances > 1 ? `, ${t.instances} instances` : ''}`
            + `${t.starvedChunks ? `; ${t.starvedChunks} starved chunks left out (the profiler sampled too rarely)` : ''}`
            + `${t.unsampledSec ? `; ${t.unsampledSec} s without samples left out${t.sampleGaps ? ` (${t.sampleGaps} sample gaps over ${CpuProfile.STARVED_STRETCH_MS} ms)` : ''}` : ''}`);
        if (t.longTurnCode.length) console.log('  long turns held by:');
        for (const row of t.longTurnCode.slice(0, 6)) console.log(`  ${String(row.ms).padStart(8)} ms  ${row.fn}`);
        console.log(`  by part: ${t.cpuParts.map(row => `${row.part} ${row.pct} %`).join(', ')}`);
        console.log('  cpu by function (self, % of profiled busy time):');
        for (const row of t.cpuSelf.slice(0, 10)) console.log(`  ${String(row.pct).padStart(6)} %  ${row.fn}`);
        console.log('  cpu by project file:');
        for (const row of t.cpuFiles.slice(0, 6)) console.log(`  ${String(row.pct).padStart(6)} %  ${row.fn}`);
    }
    const c = s.context, span = (v) => (v ? `${v.start}->${v.end} (max ${v.max})` : '-');
    if (c) {
        console.log(`\ncontext: hot ${c.load.hotAvg ?? '-'} / cold ${c.load.coldAvg ?? '-'} bots avg, players max ${c.load.playersMax ?? '-'},`
            + ` sustained lag max ${c.load.lagSustainedMaxMs ?? '-'} ms; main heap after GC ${span(c.memory.mainHeapAfterGcMb)} MB,`
            + ` geodata ${span(c.memory.geodataMb)} MB, free memory min ${c.memory.freeMemMinMb ?? '-'} MB, major page faults ${c.memory.majorPageFaults}`);
        if (c.memory.mainGc) console.log(`main GC pauses per minute: ${pauses(c.memory.mainGc)}`);
        const d = c.database;
        console.log(`database: queue max ${d.pendingMax ?? '-'}${d.maxPending != null ? ` (peak ${d.maxPending})` : ''}, WAL ${span(d.walMb)} MB,`
            + ` world ${span(d.worldMb)} MB, history WAL ${span(d.historyWalMb)} MB, checkpoints ${d.checkpoints}`);
        const truncate = (r) => (r ? `${r.at} ${r.ok ? (r.busy ? 'busy' : 'ok') : `failed${r.error ? ` (${r.error})` : ''}`}${r.durationMs != null ? ` ${r.durationMs} ms` : ''}` : 'none');
        console.log(`  WAL truncate: last ${truncate(d.walTruncate.last)}, last emptied ${truncate(d.walTruncate.lastEmptied)};`
            + ` maintenance refused in the window: ${Object.entries(d.maintenanceRefusals).map(([key, count]) => `${key} ${count}`).join(', ') || 'none'}`);
        if (d.overBudgetJobs?.length) console.log(`  jobs past the 12 ms drain slice: ${d.overBudgetJobs.slice(0, 6)
            .map(row => `${row.op} ${row.count}x (max since start ${row.maxMs} ms)`).join(', ')}`);
        for (const op of d.operations.slice(0, 6)) console.log(`  ${String(op.runMs).padStart(8)} ms run, ${String(op.waitMs).padStart(8)} ms wait  ${op.count}x ${op.op}`);
        const q = c.commitQueue, f = c.failures;
        console.log(`commit queue: depth max ${q.depthMax ?? '-'}, ${q.bytesMaxKb ?? '-'} KB, oldest ${q.oldestMaxMs ?? '-'} ms, paused ${Math.round(100 * q.pausedShare)} % of lines`);
        console.log(`failures: worker faults ${f.workerFaults} (${f.faultBots ?? 0} bots held, ${f.quarantinedMax ?? 0} quarantined${f.lastFault ? `; last ${f.lastFault.stage}: ${f.lastFault.reason}` : ''}),`
            + ` command DB errors ${f.commandDbErrors ?? 0}, afterCommit errors ${f.afterCommitErrors},`
            + ` swallowed ${f.swallowed ?? 0}${f.swallowedSites && Object.keys(f.swallowedSites).length ? ` ${JSON.stringify(f.swallowedSites)}` : ''}, safety repairs ${JSON.stringify(f.safetyRepairs)}, path queue max ${f.pathQueueMax ?? '-'}`
            + `${f.restarts.length ? `, restarted: ${f.restarts.join(', ')}` : ''}`);
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
