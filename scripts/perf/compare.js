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

function delta(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
    const change = round(b - a, 2);
    const pct = a ? ` (${change >= 0 ? '+' : ''}${Math.round(100 * (b - a) / a)} %)` : '';
    return `${change >= 0 ? '+' : ''}${change}${pct}`;
}

function rows(a, b) {
    const out = [['process cores', a.processCores, b.processCores], ['cold due max', a.coldDueMax, b.coldDueMax],
        ['recorder % of main', a.recorderMainPct, b.recorderMainPct]];
    for (const label of new Set([...Object.keys(a.threads), ...Object.keys(b.threads)])) {
        const x = a.threads[label] || {}, y = b.threads[label] || {};
        out.push([`${label} busy %`, x.busyPct, y.busyPct], [`${label} gc %`, x.gcPct, y.gcPct],
            [`${label} long turns/min`, x.longTurnsPerMin, y.longTurnsPerMin], [`${label} longest ms`, x.longestMs, y.longestMs],
            [`${label} p95 chunk longest ms`, x.chunkLongestP95Ms, y.chunkLongestP95Ms]);
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
function moved(x = [], y = [], count) {
    const share = new Map();
    for (const row of x) share.set(row.fn, [row.pct, 0]);
    for (const row of y) share.set(row.fn, [share.get(row.fn)?.[0] || 0, row.pct]);
    return [...share].map(([fn, [before, after]]) => ({ fn, before, after, change: round(after - before) }))
        .filter(row => row.change !== 0).sort((p, q) => Math.abs(q.change) - Math.abs(p.change)).slice(0, count);
}

function compare(dirA, dirB, { top = 8 } = {}) {
    const a = load(dirA), b = load(dirB);
    const name = (s) => `${s.run.folder}: ${s.run.sha}${s.run.dirty ? ' (uncommitted)' : ''}, ${s.run.scenario}, ${s.run.save.name}`;
    console.log(`A ${name(a)}\nB ${name(b)}`);
    const differs = [['save', a.run.save.id, b.run.save.id], ['scenario', a.run.scenario, b.run.scenario],
        ['window minutes', a.run.windowMinutes, b.run.windowMinutes], ['warm-up minutes', a.run.warmupMinutes, b.run.warmupMinutes],
        ['diagnostics', a.run.diagnostics, b.run.diagnostics]].filter(([, x, y]) => x !== y);
    for (const [what, x, y] of differs) console.log(`  not comparable: ${what} ${x} vs ${y}`);
    const table = rows(a, b);
    const width = Math.max(...table.map(([label]) => label.length));
    console.log(`\n${''.padEnd(width)}  ${'A'.padStart(9)}  ${'B'.padStart(9)}  change`);
    for (const [label, x, y] of table) {
        const show = (value) => String(Number.isFinite(value) ? value : '-').padStart(9);
        console.log(`${label.padEnd(width)}  ${show(x)}  ${show(y)}  ${delta(x, y)}`);
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
