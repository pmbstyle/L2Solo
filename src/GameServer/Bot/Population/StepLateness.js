'use strict';

// How late a cold step's commit lands: the commit ack's time minus the step's due (a step
// started its lead early and committed by its due counts 0). The kernel counts each committed
// step's lateness into these buckets (cumulative, plain numbers: they cross the worker
// boundary in the heartbeat); main takes a window of them for the health line and the perf
// report reads the windows. A percentile is its bucket's upper bound.
const BOUNDS_MS = Object.freeze([0, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000]);

function empty() {
    return new Array(BOUNDS_MS.length + 1).fill(0);
}

function bucketOf(lateMs) {
    const ms = Math.max(0, Number(lateMs) || 0);
    for (let index = 0; index < BOUNDS_MS.length; index++) if (ms <= BOUNDS_MS[index]) return index;
    return BOUNDS_MS.length;
}

// counts since the earlier cumulative copy; a worker restart starts its counts again.
function since(counts, earlier) {
    const now = Array.isArray(counts) ? counts : empty();
    const before = Array.isArray(earlier) && earlier.length === now.length ? earlier : empty();
    const delta = now.map((count, index) => count - before[index]);
    return delta.some(count => count < 0) ? now.slice() : delta;
}

function add(into, counts) {
    if (Array.isArray(counts)) counts.forEach((count, index) => { into[index] = (into[index] || 0) + (Number(count) || 0); });
    return into;
}

// The bucket bound under which the share `ratio` of the steps landed; Infinity past the last bound.
function percentile(counts, ratio) {
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (!total) return 0;
    let seen = 0;
    for (let index = 0; index < counts.length; index++) {
        seen += counts[index];
        if (seen >= total * ratio) return index < BOUNDS_MS.length ? BOUNDS_MS[index] : Infinity;
    }
    return Infinity;
}

// { steps, p50Ms, p99Ms, maxMs } of a window's counts and its exact longest lateness: a
// percentile is its bucket's bound, never above the longest (past the last bound it is that).
function summary(counts, maxMs) {
    const max = Math.round(Math.max(0, Number(maxMs) || 0));
    return { steps: counts.reduce((sum, count) => sum + count, 0), p50Ms: Math.min(percentile(counts, 0.5), max),
        p99Ms: Math.min(percentile(counts, 0.99), max), maxMs: max };
}

module.exports = { BOUNDS_MS, empty, bucketOf, since, add, percentile, summary };
