'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_MIN_WAL_BYTES = 4 * 1024 * 1024;
const SAMPLE_LIMIT = 256;

let worker = null;
let timer = null;
let restartTimer = null;
let databasePath = null;
let stopping = false;
let ready = false;
let sequence = 0;
let activeRequest = null;
const pending = new Map();
const durations = [];

const counters = {
    starts: 0,
    restarts: 0,
    requests: 0,
    completed: 0,
    skipped: 0,
    busy: 0,
    errors: 0,
    coalesced: 0,
    frames: 0,
    resetRequests: 0,
    resets: 0,
    resetBusy: 0,
    resetErrors: 0
};
let last = null;
let lastReset = null;

function resetState() {
    for (const key of Object.keys(counters)) counters[key] = 0;
    durations.length = 0;
    last = null;
    lastReset = null;
}

function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

function rejectPending(error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    activeRequest = null;
}

function scheduleRestart() {
    if (stopping || !databasePath || restartTimer) return;
    counters.restarts += 1;
    restartTimer = setTimeout(() => {
        restartTimer = null;
        spawn();
    }, 250);
    restartTimer.unref?.();
}

function record(result = {}) {
    const normalized = {
        ...result,
        durationMs: Math.max(0, Number(result.durationMs || 0)),
        at: Date.now()
    };
    last = normalized;
    const reset = normalized.mode === 'restart';
    if (!normalized.ok) counters.errors += 1;
    else if (normalized.skipped) counters.skipped += 1;
    else {
        counters.completed += 1;
        counters.busy += Math.max(0, Number(normalized.busy || 0));
        counters.frames += Math.max(0, Number(normalized.checkpointedFrames || 0));
        durations.push(normalized.durationMs);
        if (durations.length > SAMPLE_LIMIT) durations.shift();
    }
    if (reset) {
        if (!normalized.ok) counters.resetErrors += 1;
        else if (Number(normalized.busy || 0) > 0) counters.resetBusy += 1;
        else {
            counters.resets += 1;
            lastReset = { ...normalized };
        }
    }
    return normalized;
}

function spawn() {
    if (!databasePath || stopping || worker) return;
    ready = false;
    const instance = new Worker(path.join(__dirname, 'DatabaseCheckpointWorker.js'), {
        workerData: { databasePath }
    });
    worker = instance;
    counters.starts += 1;
    instance.on('message', (message = {}) => {
        if (instance !== worker) return;
        if (message.type === 'ready') {
            ready = true;
            return;
        }
        if (message.type !== 'result') return;
        const entry = pending.get(Number(message.id));
        if (!entry) return;
        pending.delete(Number(message.id));
        const result = record({
            mode: entry.mode,
            ...(message.result || { ok: false, error: 'missing_checkpoint_result' })
        });
        if (activeRequest?.id === Number(message.id)) activeRequest = null;
        entry.resolve(result);
    });
    instance.on('error', (error) => {
        if (instance !== worker) return;
        counters.errors += 1;
        last = { ok: false, error: error?.message || String(error), at: Date.now() };
    });
    instance.on('exit', (code) => {
        if (instance !== worker) return;
        worker = null;
        ready = false;
        if (pending.size) rejectPending(new Error(`checkpoint worker exited code=${code}`));
        if (!stopping) scheduleRestart();
    });
    // Registering a MessagePort listener refs the worker again. Keep this
    // after every listener so an idle checkpoint worker cannot keep short
    // lived tools or test processes alive on its own.
    instance.unref?.();
}

function start(nextDatabasePath, options = {}) {
    const resolved = path.resolve(String(nextDatabasePath || ''));
    if (databasePath === resolved && worker && !stopping) return snapshot();
    if (worker || timer || restartTimer) throw new Error('checkpoint coordinator already started for another database');
    resetState();
    databasePath = resolved;
    stopping = false;
    spawn();
    const intervalMs = Math.max(1000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
    const minWalBytes = Math.max(0, Number(options.minWalBytes) || DEFAULT_MIN_WAL_BYTES);
    timer = setInterval(() => {
        request({ minWalBytes }).catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return snapshot();
}

function request(options = {}) {
    if (stopping || !worker) return Promise.reject(new Error('checkpoint worker is not available'));
    if (activeRequest) {
        counters.coalesced += 1;
        if (options.force === true) {
            return activeRequest.promise.then(() => request(options));
        }
        return activeRequest.promise;
    }
    const id = ++sequence;
    counters.requests += 1;
    const mode = options.mode === 'restart'
        ? 'restart'
        : options.mode === 'truncate' ? 'truncate' : 'passive';
    if (mode === 'restart') counters.resetRequests += 1;
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
        resolveRequest = resolve;
        rejectRequest = reject;
    });
    activeRequest = { id, promise };
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, mode });
    worker.postMessage({
        type: 'checkpoint',
        id,
        force: options.force === true,
        mode,
        minWalBytes: Math.max(0, Number(options.minWalBytes || 0)),
        busyTimeoutMs: Math.max(0, Math.min(250, Number(options.busyTimeoutMs) || 0))
    });
    return promise;
}

async function stop(options = {}) {
    if (timer) clearInterval(timer);
    timer = null;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    stopping = true;
    const instance = worker;
    if (!instance) {
        databasePath = null;
        return { stopped: true, final: null };
    }
    if (activeRequest) {
        try { await activeRequest.promise; } catch (_) { /* final checkpoint still gets a chance */ }
    }
    if (worker !== instance) return { stopped: true, final: null };
    const id = ++sequence;
    const final = new Promise((resolve) => pending.set(id, { resolve, reject: resolve }));
    instance.postMessage({ type: 'shutdown', id, final: options.final !== false });
    const result = await Promise.race([
        final,
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'checkpoint_shutdown_timeout' }), 3000))
    ]);
    if (worker === instance) {
        await instance.terminate().catch(() => {});
        worker = null;
    }
    ready = false;
    databasePath = null;
    pending.delete(id);
    activeRequest = null;
    return { stopped: true, final: result };
}

function snapshot() {
    return {
        started: !!worker,
        ready,
        inFlight: !!activeRequest,
        databasePath,
        ...counters,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        maxMs: durations.length ? Number(Math.max(...durations).toFixed(2)) : 0,
        last: last ? { ...last } : null,
        lastReset: lastReset ? { ...lastReset } : null
    };
}

async function terminateForTest() {
    if (!worker) return false;
    await worker.terminate();
    return true;
}

module.exports = { start, request, stop, snapshot, terminateForTest };
