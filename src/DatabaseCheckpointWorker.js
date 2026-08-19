'use strict';

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');

const databasePath = String(workerData?.databasePath || '');
const connection = new DatabaseSync(databasePath, { timeout: 250 });
connection.exec('PRAGMA busy_timeout = 250; PRAGMA wal_autocheckpoint = 0;');

function walBytes() {
    try { return Number(fs.statSync(`${databasePath}-wal`).size || 0); } catch (_) { return 0; }
}

function checkpoint(message = {}) {
    const beforeBytes = walBytes();
    const minimum = Math.max(0, Number(message.minWalBytes || 0));
    if (message.force !== true && beforeBytes < minimum) {
        return {
            ok: true,
            skipped: true,
            reason: 'below_threshold',
            mode: 'passive',
            beforeBytes,
            afterBytes: beforeBytes,
            durationMs: 0,
            busy: 0,
            logFrames: 0,
            checkpointedFrames: 0
        };
    }

    const mode = message.mode === 'truncate'
        ? 'TRUNCATE'
        : message.mode === 'restart' ? 'RESTART' : 'PASSIVE';
    const resetMode = mode === 'RESTART';
    if (resetMode) {
        connection.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.min(250, Number(message.busyTimeoutMs) || 50))};`);
    }
    const startedAt = process.hrtime.bigint();
    try {
        const row = connection.prepare(`PRAGMA wal_checkpoint(${mode})`).get() || {};
        return {
            ok: true,
            skipped: false,
            mode: mode.toLowerCase(),
            beforeBytes,
            afterBytes: walBytes(),
            durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
            busy: Math.max(0, Number(row.busy || 0)),
            logFrames: Math.max(0, Number(row.log || 0)),
            checkpointedFrames: Math.max(0, Number(row.checkpointed || 0))
        };
    } finally {
        if (resetMode) connection.exec('PRAGMA busy_timeout = 250;');
    }
}

function respond(id, result) {
    parentPort.postMessage({ type: 'result', id, result });
}

parentPort.on('message', (message = {}) => {
    if (message.type === 'checkpoint') {
        try {
            respond(message.id, checkpoint(message));
        } catch (error) {
            respond(message.id, {
                ok: false,
                error: error?.message || String(error),
                beforeBytes: walBytes(),
                afterBytes: walBytes()
            });
        }
        return;
    }
    if (message.type === 'shutdown') {
        let result = null;
        try {
            result = checkpoint({ force: true, mode: message.final === false ? 'passive' : 'truncate' });
        } catch (error) {
            result = { ok: false, error: error?.message || String(error) };
        }
        try { connection.close(); } catch (_) { /* process exit is the final fallback */ }
        respond(message.id, result);
        parentPort.close();
    }
});

parentPort.postMessage({ type: 'ready', databasePath });
