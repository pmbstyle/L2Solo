'use strict';

// The one rule for a failure the code survives: a catch that keeps its fallback, a write nobody
// awaits, the process backstop. Each failure counts under its site; the first one of a site is
// logged with its stack, repeats are only counted (status line `swallowed=`, summed at exit).
// It never rethrows: many callers run in timers, where a throw is fatal (NodeL2 uncaughtException).
// The cost is on the failure path only: one Map get/set, one log line per site.
// One instance per thread. Main: NodeL2's backstop and the hot sites. The cold worker ships its
// counts in each heartbeat (ColdSimulationKernel `failures.swallowed`), and
// ColdSimulationCoordinator.failureSnapshot merges them with main's.
const { format } = require('node:util');

// Named sites (`area.what`, fixed in the code) and the backstop's unnamed ones are capped apart, so
// unnamed sites (one per distinct throw) cannot crowd the named ones out.
const MAX_SITES = 128;
const MAX_UNNAMED_SITES = 32;
const OTHER_SITES = 'other sites', OTHER_UNNAMED = 'other unnamed sites';

const counts = new Map();
let trace = null;
let named = 0, unnamed = 0;
// The server's warning line; modules loaded without Global (unit fixtures) still get the line.
const warn = (...params) => (global.utils ? utils.infoWarn('Failure', ...params) : console.warn('Failure ::', format(...params)));

function record(site, error, isNamed) {
    let key = site;
    if (!counts.has(site)) {
        if (isNamed ? named >= MAX_SITES : unnamed >= MAX_UNNAMED_SITES) key = isNamed ? OTHER_SITES : OTHER_UNNAMED;
        else if (isNamed) named += 1;
        else unnamed += 1;
    }
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    // Every failure is a record of the decision trace too (when it is on): where a bot's story broke.
    // lazy: cycle the trace's config loads modules that note failures.
    try { (trace ||= require('./GameServer/Bot/DecisionTrace')).record({ kind: 'failure', site: String(key) }); } catch { /* The trace never fails a failure path. */ }
    if (count === 1) warn('%s (repeats are counted, not logged): %s', site, error?.stack || error);
}

// A failure at `site` (a fixed name, `area.what`): counted; the first one is logged with its stack.
// Returns nothing, so `promise.catch(error => note(site, error))` resolves to undefined, not the error.
function note(site, error) {
    record(site, error, true);
}

// The process backstop (NodeL2): an error nobody named, its site taken from the error (siteOf).
function noteUnnamed(kind, error) {
    record(siteOf(kind, error), error, false);
}

// A refusal its owner throws as a bare code in a plain Error (`afk_trade_demand_changed`,
// `economy_material_protected`): an outcome the caller handles, not a failure. A catch that takes
// both counts only what is not one. A TypeError or RangeError is a bug whatever its message, and
// a code ending in `_exhausted` or `_overflow` names a limit or an invariant that broke.
const REFUSAL_CODE = /^[a-z][a-z0-9_]*$/, BROKEN_LIMIT = /_(exhausted|overflow)$/;
function refusal(error) {
    return error instanceof Error && error.name === 'Error' && typeof error.message === 'string'
        && REFUSAL_CODE.test(error.message) && !BROKEN_LIMIT.test(error.message);
}

// The backstop's site: its kind, the error's name and first stack frame (messages often carry
// ids, which would split one site into many); without a stack, its first line with digits masked.
function siteOf(kind, error) {
    const lines = String(error?.stack || error?.message || error).split('\n');
    return `${kind}: ${error?.stack ? `${error.name || 'Error'} ${(lines[1] || '').trim()}` : lines[0].slice(0, 160).replace(/\d+/g, '#')}`;
}

// { site: count } since the thread started; null while nothing failed (a healthy heartbeat carries nothing).
function snapshot() {
    return counts.size ? Object.fromEntries(counts) : null;
}

// Main's and the worker's snapshots summed by site.
function merge(...snapshots) {
    const merged = {};
    for (const one of snapshots) {
        for (const [site, count] of Object.entries(one || {})) merged[site] = (merged[site] || 0) + (Number(count) || 0);
    }
    return merged;
}

// At exit: each site that failed more than once, with its count (the first was logged when it happened).
function report() {
    for (const [site, count] of counts) {
        if (count > 1) warn('%s x%d', site, count);
    }
}

module.exports = { note, noteUnnamed, refusal, snapshot, merge, report, MAX_SITES, MAX_UNNAMED_SITES };
