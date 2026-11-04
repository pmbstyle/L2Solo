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

const MAX_SITES = 128;
const OTHER_SITES = 'other sites';

const counts = new Map();
// The server's warning line; modules loaded without Global (unit fixtures) still get the line.
const warn = (...params) => (global.utils ? utils.infoWarn('Failure', ...params) : console.warn('Failure ::', format(...params)));

// A failure at `site` (a fixed name, `area.what`): counted; the first one is logged with its stack.
// Returns nothing, so `promise.catch(error => note(site, error))` resolves to undefined, not the error.
function note(site, error) {
    const key = counts.has(site) || counts.size < MAX_SITES ? site : OTHER_SITES;
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (count === 1) warn('%s (repeats are counted, not logged): %s', site, error?.stack || error);
}

// A refusal its owner throws as a bare code (`afk_trade_demand_changed`, `economy_material_protected`):
// an outcome the caller handles, not a failure. A catch that takes both counts only what is not one.
const REFUSAL_CODE = /^[a-z][a-z0-9_]*$/;
function refusal(error) {
    return typeof error?.message === 'string' && REFUSAL_CODE.test(error.message);
}

// The backstop's site for an error nobody named: its kind, the error's name and first stack frame
// (messages often carry ids, so they would split one site into many).
function siteOf(kind, error) {
    const lines = String(error?.stack || error?.message || error).split('\n');
    return `${kind}: ${error?.stack ? `${error.name || 'Error'} ${(lines[1] || '').trim()}` : lines[0].slice(0, 160)}`;
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

module.exports = { note, refusal, siteOf, snapshot, merge, report, MAX_SITES };
