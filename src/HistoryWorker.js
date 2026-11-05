'use strict';

// The history thread: the only writer of the history file. It moves the
// world's outbox rows into the history file in batches: after a wake message
// from the main thread (a world write job ended), at most once per transfer
// interval, and at once on a flush. Once a minute it also drains and runs the
// age cleanup, which bounds the delay of a lost wake message (the rows stay in
// the outbox until reported as moved, so nothing is ever lost). It only reads
// the world file; the main thread deletes the moved outbox rows.

const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const HistoryStore = require('./HistoryStore');
const { heapRecord, observe } = require('./GameServer/Bot/Population/WorkerHeapTelemetry');
if (workerData.developerDiagnostics === true) observe(); // major-GC window for the v8Heap record (WorkerHeapTelemetry)
// The decision trace's writer (decisionTrace on): its records come from main (decision_trace messages).
const traceWriter = workerData.trace ? new (require('./DecisionTraceWriter').DecisionTraceWriter)(
    require('node:path').join(require('node:path').dirname(workerData.worldPath), 'logs'), workerData.trace, { enabled: true }) : null;

const TRANSFER_MS = Math.max(10, Number(workerData?.transferMs) || 200);
const RETENTION_MS = 60 * 1000;
const BATCH = 1000;

const history = HistoryStore.open(String(workerData.historyPath));
const world = new DatabaseSync(String(workerData.worldPath), { readOnly: true, timeout: 5000 });
let reportedUpTo = 0;
let lastTickAt = 0;
let tickTimer = null;
let retentionTimer = null;

// Moves every outbox row that is there now; returns the totals.
function drain() {
    const total = { moved: 0, failed: 0, upTo: HistoryStore.cursor(history) };
    for (;;) {
        const result = HistoryStore.transfer(history, world, BATCH);
        total.moved += result.moved;
        total.failed += result.failed;
        total.upTo = result.upTo;
        if (result.errors.length) parentPort.postMessage({ type: 'errors', errors: result.errors.slice(0, 5) });
        if (result.moved + result.failed < BATCH) return total;
    }
}

function tick(withRetention = false) {
    lastTickAt = Date.now();
    try {
        const result = drain();
        // The once-a-minute tick also carries this thread's heap.
        const heap = withRetention ? { v8Heap: heapRecord() } : null;
        // Also report a cursor that was reached before a restart: the main
        // thread then deletes outbox rows a crash left behind.
        if (result.upTo > reportedUpTo) {
            reportedUpTo = result.upTo;
            parentPort.postMessage({ type: 'moved', ...result, ...heap });
        } else {
            // Lets the main thread send the next wake message.
            parentPort.postMessage({ type: 'idle', ...heap });
        }
        if (withRetention) {
            HistoryStore.retention(history);
            traceWriter?.cleanup();
        }
    } catch (error) {
        parentPort.postMessage({ type: 'error', error: error?.message || String(error) });
    }
}

// A wake message ends the wait: the next tick runs now, or when the transfer
// interval since the last one has passed, so a busy world still transfers in
// batches at the old pace.
function scheduleTick() {
    if (tickTimer) return;
    tickTimer = setTimeout(() => {
        tickTimer = null;
        tick();
    }, Math.max(0, lastTickAt + TRANSFER_MS - Date.now()));
}

parentPort.on('message', (message = {}) => {
    if (message.type === 'wake') {
        scheduleTick();
        return;
    }
    if (message.type === 'decision_trace') {
        if (!traceWriter) return;
        let written = 0;
        try {
            // Canonical history always goes first; the trace never aborts it.
            tick(); written = traceWriter.write(message.records) || 0;
        } catch { /* Counted as lost by main's trace (writer), never stops the world. */ }
        parentPort.postMessage({ type: 'decision_trace_ack', id: message.id, written, writer: traceWriter.snapshot() }); return;
    }
    if (message.type !== 'flush' && message.type !== 'stop') return;
    let reply;
    try {
        const result = drain();
        reportedUpTo = Math.max(reportedUpTo, result.upTo);
        reply = { ...result, error: null };
    } catch (error) {
        reply = { moved: 0, failed: 0, upTo: reportedUpTo, error: error?.message || String(error) };
    }
    if (message.type === 'flush') {
        parentPort.postMessage({ type: 'flushed', id: message.id, ...reply });
        return;
    }
    clearTimeout(tickTimer);
    clearInterval(retentionTimer);
    world.close();
    history.close();
    parentPort.postMessage({ type: 'stopped', id: message.id, ...reply });
    parentPort.close();
});

tick(true);
retentionTimer = setInterval(() => tick(true), RETENTION_MS);
