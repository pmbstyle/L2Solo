'use strict';

const { performance } = require('perf_hooks');

const SAMPLE_LIMIT = 1024;
const urgentQueue = [];
const normalQueue = [];
const pending = new Map();
const waitSamples = [];
const runSamples = [];
let drainTimer = null;

const counters = {
    enqueued: 0,
    completed: 0,
    coalesced: 0,
    canceled: 0,
    errors: 0,
    urgent: 0,
    yields: 0,
    maxDepth: 0
};

function sample(target, value) {
    target.push(Math.max(0, Number(value) || 0));
    if (target.length > SAMPLE_LIMIT) target.shift();
}

function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

function nextEntry() {
    for (;;) {
        const entry = urgentQueue.shift() || normalQueue.shift();
        if (!entry) return null;
        if (!entry.canceled && pending.get(entry.key) === entry) return entry;
    }
}

function scheduleDrain() {
    if (drainTimer || pending.size === 0) return;
    // A zero-delay timer creates a macrotask boundary between actors. Timers
    // that serve real players can therefore run before the next AI decision.
    drainTimer = setTimeout(drain, 0);
}

function drain() {
    drainTimer = null;
    const entry = nextEntry();
    if (!entry) return;
    pending.delete(entry.key);
    sample(waitSamples, performance.now() - entry.queuedAt);
    const startedAt = performance.now();
    try {
        entry.task();
        counters.completed += 1;
    } catch (error) {
        counters.errors += 1;
        if (typeof entry.onError === 'function') entry.onError(error);
        else console.error('Hot AI dispatch error:', error);
    } finally {
        sample(runSamples, performance.now() - startedAt);
        if (pending.size > 0) {
            counters.yields += 1;
            scheduleDrain();
        }
    }
}

function enqueue(key, task, options = {}) {
    if (!key || typeof task !== 'function') return false;
    const existing = pending.get(key);
    if (existing) {
        counters.coalesced += 1;
        if (options.urgent === true && !existing.urgent) {
            existing.urgent = true;
            counters.urgent += 1;
            urgentQueue.push(existing);
        }
        return false;
    }
    const entry = {
        key,
        task,
        onError: options.onError,
        urgent: options.urgent === true,
        queuedAt: performance.now(),
        canceled: false
    };
    pending.set(key, entry);
    (entry.urgent ? urgentQueue : normalQueue).push(entry);
    counters.enqueued += 1;
    if (entry.urgent) counters.urgent += 1;
    counters.maxDepth = Math.max(counters.maxDepth, pending.size);
    scheduleDrain();
    return true;
}

function cancel(key) {
    const entry = pending.get(key);
    if (!entry) return false;
    entry.canceled = true;
    pending.delete(key);
    counters.canceled += 1;
    return true;
}

function snapshot() {
    return {
        ...counters,
        depth: pending.size,
        urgentDepth: [...pending.values()].filter((entry) => entry.urgent).length,
        waitP95Ms: percentile(waitSamples, 0.95),
        waitMaxMs: waitSamples.length ? Number(Math.max(...waitSamples).toFixed(2)) : 0,
        runP95Ms: percentile(runSamples, 0.95),
        runMaxMs: runSamples.length ? Number(Math.max(...runSamples).toFixed(2)) : 0
    };
}

function resetForTest() {
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = null;
    pending.clear();
    urgentQueue.length = 0;
    normalQueue.length = 0;
    waitSamples.length = 0;
    runSamples.length = 0;
    Object.keys(counters).forEach((key) => { counters[key] = 0; });
}

module.exports = { enqueue, cancel, snapshot, resetForTest };
