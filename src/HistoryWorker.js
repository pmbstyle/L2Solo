'use strict';

// The history thread: the only writer of the history file. Every few hundred
// milliseconds (or at once on a flush) it moves the world's outbox rows into
// the history file in batches and runs the age cleanup once a minute. It only
// reads the world file; the main thread deletes the moved outbox rows.

const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const HistoryStore = require('./HistoryStore');

const TRANSFER_MS = Math.max(10, Number(workerData?.transferMs) || 200);
const RETENTION_MS = 60 * 1000;
const BATCH = 1000;

const history = HistoryStore.open(String(workerData.historyPath));
const world = new DatabaseSync(String(workerData.worldPath), { readOnly: true, timeout: 5000 });
let lastRetentionAt = 0;
let reportedUpTo = 0;
let timer = null;

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

function tick() {
    try {
        const result = drain();
        // Also report a cursor that was reached before a restart: the main
        // thread then deletes outbox rows a crash left behind.
        if (result.upTo > reportedUpTo) {
            reportedUpTo = result.upTo;
            parentPort.postMessage({ type: 'moved', ...result });
        }
        if (Date.now() - lastRetentionAt >= RETENTION_MS) {
            lastRetentionAt = Date.now();
            HistoryStore.retention(history);
        }
    } catch (error) {
        parentPort.postMessage({ type: 'error', error: error?.message || String(error) });
    }
}

parentPort.on('message', (message = {}) => {
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
    clearInterval(timer);
    world.close();
    history.close();
    parentPort.postMessage({ type: 'stopped', id: message.id, ...reply });
    parentPort.close();
});

tick();
timer = setInterval(tick, TRANSFER_MS);
