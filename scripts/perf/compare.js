'use strict';

// Two window runs side by side (summary.json of each, scripts/perf/report.js): the numbers, their
// change, and the functions whose share of a thread's CPU moved most. Says when the runs are not
// comparable (another save, scenario or window).

const fs = require('fs');
const path = require('path');
const { summarize } = require('./report');

function load(dir) {
    const file = path.join(dir, 'summary.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : summarize(dir);
}

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

// Run-to-run noise: two window runs of one commit on one save (MacBook Pro 2015, 10 min windows,
// 2026-11-03) moved cores and busy shares 3-4 %, long turns a minute 10-16 %, heap at the end
// 9-16 %, the sampled growth up to 50 % and the single longest turn 30-90 %. A change inside these
// (with some margin) is marked "noise": it needs more runs, or a longer window, to mean anything.
// Main's GC pauses a minute are not measured run to run yet: they take the gc % band.
const NOISE = [[/% cpu/, 0.15], [/WAL|db queue|commit queue|page faults/, 0.3], [/cores|busy %/, 0.06], [/activation|cooldown/, 0.3], [/packets|KB/, 0.2], [/gc %/, 0.3], [/^main gc .*\/min$/, 0.3], [/long turns\/min/, 0.2], [/heap end|rss/, 0.2],
    [/sampled growth/, 0.6], [/longest|player .* max/, 1], [/player /, 0.3]];

const GC_NAMES = { minor: 'scavenge', major: 'mark-compact', incremental: 'incremental marking', weak: 'weak callbacks' };

function delta(label, a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
    const change = round(b - a, 2);
    const pct = a ? ` (${change >= 0 ? '+' : ''}${Math.round(100 * (b - a) / a)} %)` : '';
    const noise = NOISE.find(([pattern]) => pattern.test(label))?.[1];
    const within = noise !== undefined && change !== 0 && (a ? Math.abs(b - a) / Math.abs(a) <= noise : false);
    return `${change >= 0 ? '+' : ''}${change}${pct}${within ? '  noise' : ''}`;
}

function rows(a, b) {
    const out = [['process cores', a.processCores, b.processCores], ['cold due max', a.coldDueMax, b.coldDueMax],
        ['recorder % of main', a.recorderMainPct, b.recorderMainPct]];
    for (const label of new Set([...Object.keys(a.threads), ...Object.keys(b.threads)])) {
        const x = a.threads[label] || {}, y = b.threads[label] || {};
        out.push([`${label} busy %`, x.busyPct, y.busyPct], [`${label} gc %`, x.gcPct, y.gcPct],
            [`${label} long turns/min`, x.longTurnsPerMin, y.longTurnsPerMin], [`${label} longest ms`, x.longestMs, y.longestMs],
            [`${label} p95 chunk longest ms`, x.chunkLongestP95Ms, y.chunkLongestP95Ms],
            [`${label} starved chunks (left out)`, x.starvedChunks ?? 0, y.starvedChunks ?? 0],
            [`${label} s without samples (left out)`, x.unsampledSec ?? 0, y.unsampledSec ?? 0]);
        for (const part of new Set([...(x.cpuParts || []), ...(y.cpuParts || [])].map(row => row.part))) {
            const share = (t) => t.cpuParts?.find(row => row.part === part)?.pct ?? 0;
            out.push([`${label} ${part} % cpu`, share(x), share(y)]);
        }
    }
    if (a.player || b.player) {
        out.push(['player hot bots avg', a.player?.hotAvg, b.player?.hotAvg],
            ['player wait p95 ms', a.player?.schedule.p95Ms, b.player?.schedule.p95Ms],
            ['player wait p99 ms', a.player?.schedule.p99Ms, b.player?.schedule.p99Ms],
            ['player wait max ms', a.player?.schedule.maxMs, b.player?.schedule.maxMs],
            ['player handler p95 ms', a.player?.handler.p95Ms, b.player?.handler.p95Ms],
            ['player handler p99 ms', a.player?.handler.p99Ms, b.player?.handler.p99Ms],
            ['player packets/s', a.player?.packetsPerSecond, b.player?.packetsPerSecond],
            ['player KB/s', a.player?.kbPerSecond, b.player?.kbPerSecond]);
    }
    if (a.transitions || b.transitions) {
        for (const kind of ['activation', 'cooldown']) {
            const x = a.transitions?.[kind], y = b.transitions?.[kind];
            out.push([`${kind}s`, x?.count, y?.count], [`${kind} avg ms`, x?.avgMs, y?.avgMs], [`${kind} p95 ms`, x?.p95Ms, y?.p95Ms]);
        }
    }
    if (a.context || b.context) {
        const ca = a.context || {}, cb = b.context || {};
        out.push(['db queue max', ca.database?.pendingMax, cb.database?.pendingMax],
            ['WAL end MB', ca.database?.walMb?.end, cb.database?.walMb?.end],
            ['commit queue depth max', ca.commitQueue?.depthMax, cb.commitQueue?.depthMax],
            ['commit queue oldest max ms', ca.commitQueue?.oldestMaxMs, cb.commitQueue?.oldestMaxMs],
            ['worker faults', ca.failures?.workerFaults, cb.failures?.workerFaults],
            ['afterCommit errors', ca.failures?.afterCommitErrors, cb.failures?.afterCommitErrors],
            ['swallowed failures', ca.failures?.swallowed, cb.failures?.swallowed],
            ['main heap after GC end MB', ca.memory?.mainHeapAfterGcMb?.end, cb.memory?.mainHeapAfterGcMb?.end],
            ['major page faults', ca.memory?.majorPageFaults, cb.memory?.majorPageFaults]);
        // Main's GC pauses, every kind either run saw (a run that counted pauses and has none of a kind
        // shows 0); the longest only for mark-compacts, the pause that holds a turn (a scavenge is a few ms).
        const ga = ca.memory?.mainGc, gb = cb.memory?.mainGc;
        for (const kind of new Set([...Object.keys(ga || {}), ...Object.keys(gb || {})])) {
            const none = { perMin: 0, msPerMin: 0, maxMsSinceStart: 0 }, name = GC_NAMES[kind] || kind;
            const x = ga && (ga[kind] || none), y = gb && (gb[kind] || none);
            out.push([`main gc ${name}/min`, x?.perMin, y?.perMin], [`main gc ${name} ms/min`, x?.msPerMin, y?.msPerMin]);
            if (kind === 'major') out.push([`main gc ${name} longest since start ms`, x?.maxMsSinceStart, y?.maxMsSinceStart]);
        }
    }
    out.push(['main heap end MB', a.memory.mainHeapUsedMb?.end, b.memory.mainHeapUsedMb?.end],
        ['rss max MB', a.memory.rssMb?.max, b.memory.rssMb?.max]);
    for (const label of new Set([...Object.keys(a.memory.heaps), ...Object.keys(b.memory.heaps)])) {
        if (label !== 'main') out.push([`${label} heap end MB`, a.memory.heaps[label]?.end, b.memory.heaps[label]?.end]);
    }
    for (const label of new Set([...Object.keys(a.memory.growth), ...Object.keys(b.memory.growth)])) {
        const grew = (s) => (s.memory.growth[label] ? s.memory.growth[label].afterMb - s.memory.growth[label].beforeMb : NaN);
        out.push([`${label} sampled growth MB`, round(grew(a)), round(grew(b))]);
    }
    return out;
}

// Functions whose share of the thread's profiled CPU moved most (percentage points).
// A function missing from one run's list is below that list's last share, not at 0: it counts at
// that floor, shown as "<=", so falling off a list is not read as a move.
function moved(x = [], y = [], count) {
    const floor = (list) => (list.length ? list.at(-1).pct : 0);
    const before = new Map(x.map(row => [row.fn, row.pct])), after = new Map(y.map(row => [row.fn, row.pct]));
    return [...new Set([...before.keys(), ...after.keys()])].map((fn) => {
        const a = before.has(fn) ? before.get(fn) : floor(x), b = after.has(fn) ? after.get(fn) : floor(y);
        return { fn, before: before.has(fn) ? a : `<=${a}`, after: after.has(fn) ? b : `<=${b}`, change: round(b - a) };
    }).filter(row => row.change !== 0).sort((p, q) => Math.abs(q.change) - Math.abs(p.change)).slice(0, count);
}

function compare(dirA, dirB, { top = 8 } = {}) {
    const a = load(dirA), b = load(dirB);
    const name = (s) => `${s.run.folder}: ${s.run.sha}${s.run.dirty ? ' (uncommitted)' : ''}, ${s.run.scenario}, ${s.run.save.name}`;
    console.log(`A ${name(a)}\nB ${name(b)}`);
    const differs = [['save', a.run.save.id, b.run.save.id], ['scenario', a.run.scenario, b.run.scenario],
        ['window minutes', a.run.windowMinutes, b.run.windowMinutes], ['warm-up minutes', a.run.warmupMinutes, b.run.warmupMinutes],
        ['diagnostics', a.run.diagnostics, b.run.diagnostics],
        ['players', JSON.stringify(a.run.crowd || null), JSON.stringify(b.run.crowd || null)],
        ['players in the window', a.player?.players ?? 0, b.player?.players ?? 0]].filter(([, x, y]) => x !== y);
    for (const [what, x, y] of differs) console.log(`  not comparable: ${what} ${x} vs ${y}`);
    const table = rows(a, b);
    const width = Math.max(...table.map(([label]) => label.length));
    console.log(`\n${''.padEnd(width)}  ${'A'.padStart(9)}  ${'B'.padStart(9)}  change`);
    for (const [label, x, y] of table) {
        const show = (value) => String(Number.isFinite(value) ? value : '-').padStart(9);
        console.log(`${label.padEnd(width)}  ${show(x)}  ${show(y)}  ${delta(label, x, y)}`);
    }
    for (const label of new Set([...Object.keys(a.threads), ...Object.keys(b.threads)])) {
        const list = moved(a.threads[label]?.cpuSelf, b.threads[label]?.cpuSelf, top);
        if (!list.length) continue;
        console.log(`\n${label}: share of CPU moved (% of profiled busy time, A -> B)`);
        for (const row of list) console.log(`  ${String(row.change > 0 ? `+${row.change}` : row.change).padStart(6)}  ${row.before} -> ${row.after}  ${row.fn}`);
    }
    return { a, b, differs, table };
}

module.exports = { compare };
