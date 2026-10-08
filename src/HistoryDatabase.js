'use strict';

// Main-thread side of the history database (HistoryStore.js): prepares the
// file at start, runs the history thread (HistoryWorker.js) that moves the
// world's outbox rows into it, and keeps a read-only connection for readers.
// In WAL mode these reads never block the history thread's writes.

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const Statements = require('./DatabaseStatements');
const HistoryStore = require('./HistoryStore');
const Diagnostics = require('./GameServer/Bot/Economy/EconomyDiagnostics');
const PopulationConfig = require('./GameServer/Bot/Population/PopulationConfig');
let worldToken = '';

const FLUSH_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 20000;

let worker = null;
let reader = null;
let config = null;
let stopping = false;
let writerTelemetry = null;
let restartTimer = null;
let nextId = 0;
const pending = new Map();
const counters = { moved: 0, failed: 0, flushes: 0, starts: 0, restarts: 0, errors: 0, lastError: null, upTo: 0 };

function normalizeRow(row) {
    if (!row || typeof row !== 'object') return row;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]));
}

// A history file that belongs to another world (another world token, or a
// cursor past this world's outbox) is set aside, not mixed in.
function setAside(historyPath) {
    const target = `${historyPath}.orphan`;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(target + suffix, { force: true });
    fs.renameSync(historyPath, target);
    for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(historyPath + suffix)) fs.renameSync(historyPath + suffix, target + suffix);
    }
}

// Synchronous, before the server starts: owns the history file for this world
// and moves an old world's history tables into it (HistoryStore.moveWorldTables).
function prepare(world, historyPath) {
    const token = String(world.prepare("SELECT value FROM world_meta WHERE key = 'historyToken'").get()?.value || '');
    worldToken = token;
    const outboxSeq = Number(world.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'history_outbox'").get()?.seq || 0);
    let history = HistoryStore.open(historyPath);
    const owner = HistoryStore.meta(history, HistoryStore.WORLD_TOKEN_KEY);
    if ((owner && owner !== token) || HistoryStore.cursor(history) > outboxSeq) {
        history.close();
        setAside(historyPath);
        utils.infoWarn('DB', 'history file %s belongs to another world; moved to %s.orphan', historyPath, historyPath);
        history = HistoryStore.open(historyPath);
    }
    HistoryStore.setMeta(history, HistoryStore.WORLD_TOKEN_KEY, token);
    history.close();
    const moved = HistoryStore.moveWorldTables(world, historyPath);
    const rows = Object.values(moved).reduce((sum, count) => sum + count, 0);
    if (rows) utils.infoSuccess('DB', 'history tables moved to %s (%d rows)', historyPath, rows);
    return moved;
}

function settle(id, error, value) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(value);
    if (!pending.size) worker?.unref();
}

function rejectPending(error) {
    [...pending.keys()].forEach((id) => settle(id, error));
}

function reportMoved(upTo) {
    if (upTo <= counters.upTo) return;
    counters.upTo = upTo;
    try {
        config.onMoved?.(upTo);
    } catch (error) {
        utils.infoWarn('DB', 'history outbox cleanup failed: %s', error.message);
    }
}

function spawn() {
    if (!config || stopping || worker) return;
    const instance = new Worker(path.join(__dirname, 'HistoryWorker.js'), {
        workerData: { worldPath: config.worldPath, historyPath: config.historyPath, transferMs: config.transferMs,
            ...(config.diagnostics ? { developerDiagnostics: true, diagnostics: config.diagnostics } : {}) }
    });
    worker = instance;
    if (config.diagnostics) Diagnostics.connect(batch => {
        if (worker !== instance) return false;
        const message = { type: 'economy_diagnostics', ...batch };
        instance.postMessage(message); return Buffer.byteLength(JSON.stringify(message));
    });
    if (PopulationConfig.developerDiagnostics) counters.starts += 1;
    instance.on('message', (message = {}) => {
        if (instance !== worker) return;
        if (message.type === 'economy_diagnostics_ack') {
            if (!config?.diagnostics || !PopulationConfig.developerDiagnostics) return;
            Diagnostics.ack(message.id, message.written);
            const report = message.writer;
            if (report?.enabled === true) writerTelemetry = { enabled: true, batches: Number(report.batches || 0), records: Number(report.records || 0),
                dropped: Number(report.dropped || 0), bytes: Number(report.bytes || 0), writeMs: Number(report.writeMs || 0), rotations: Number(report.rotations || 0), fileBytes: Number(report.fileBytes || 0) };
            return; }
        if (message.type === 'moved' || message.type === 'flushed' || message.type === 'stopped') {
            if (PopulationConfig.developerDiagnostics) counters.moved += Number(message.moved || 0);
            if (PopulationConfig.developerDiagnostics) counters.failed += Number(message.failed || 0);
            reportMoved(Number(message.upTo || 0));
        }
        if (message.type === 'errors' || message.type === 'error') {
            if (PopulationConfig.developerDiagnostics) counters.errors += 1;
            counters.lastError = message.error || (message.errors || []).join('; ');
            utils.infoWarn('DB', 'history transfer: %s', counters.lastError);
        }
        if (message.type === 'flushed' || message.type === 'stopped') {
            settle(Number(message.id), message.error ? new Error(message.error) : null, Number(message.upTo || 0));
        }
    });
    const failed = (error) => {
        if (instance !== worker) return;
        worker = null;
        if (config?.diagnostics) Diagnostics.disconnect();
        rejectPending(error);
        if (stopping || !config) return;
        if (PopulationConfig.developerDiagnostics) counters.restarts += 1;
        utils.infoWarn('DB', 'history thread stopped (%s); restarting', error.message);
        restartTimer = setTimeout(() => {
            restartTimer = null;
            spawn();
        }, 1000);
        restartTimer.unref?.();
    };
    instance.on('error', failed);
    instance.on('exit', (code) => failed(new Error(`history_worker_exited:${code}`)));
    // After the listeners: adding a 'message' listener refs the worker's port again,
    // and a process that only opened the database (a test, a script) must still exit.
    instance.unref();
}

function start({ worldPath, historyPath, onMoved, transferMs } = {}) {
    stopping = false;
    config = { worldPath, historyPath, onMoved, transferMs };
    if (PopulationConfig.developerDiagnostics && PopulationConfig.economyDiagnostics) {
        // No full config/path/account data in the developer header.
        let build = 'unknown';
        try {
            let git = path.resolve(__dirname, '../.git');
            if (fs.statSync(git).isFile()) git = path.resolve(path.dirname(git), fs.readFileSync(git, 'utf8').trim().replace(/^gitdir: /, ''));
            const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
            const common = fs.existsSync(path.join(git, 'commondir'))
                ? path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim()) : git;
            build = head.startsWith('ref: ') ? fs.readFileSync(path.join(common, head.slice(5)), 'utf8').trim() : head;
        } catch { /* An exported build need not have Git metadata. */ }
        config.diagnostics = { build: /^[0-9a-f]{40}$/.test(build) ? build : 'unknown',
            world: worldToken.slice(0, 96), run: require('node:crypto').randomUUID(),
            rate: String(process.env.L2NODE_PROGRESSION_RATE || 'config').slice(0, 16),
            config: { population: PopulationConfig.maxPlayingPopulation, honestTravel: PopulationConfig.coldHonestTravel,
                staticShotsDisabled: PopulationConfig.staticShotsDisabled, workerHeapMb: PopulationConfig.coldWorkerHeapMb } };
    }
    counters.upTo = 0;
    reader = new DatabaseSync(historyPath, { readOnly: true, timeout: 5000 });
    spawn();
}

function request(type, timeoutMs) {
    if (!worker) return Promise.reject(new Error('history_worker_unavailable'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(id, new Error(`history_${type}_timeout`)), timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        worker.ref();
        worker.postMessage({ type, id });
    });
}

// Resolves once every outbox row committed before the call is in the history
// file. Readers call it first, so they see what the world already committed.
function flush() {
    if (PopulationConfig.developerDiagnostics) counters.flushes += 1;
    return request('flush', FLUSH_TIMEOUT_MS);
}

// Moves what is left in the outbox, then stops the thread. Returns the last
// moved outbox id (the caller deletes the outbox rows up to it).
async function stop() {
    if (!config) return 0;
    clearTimeout(restartTimer);
    restartTimer = null;
    stopping = true;
    if (config.diagnostics) {
        const deadline = Date.now() + 500;
        while ((Diagnostics.stats().queued || Diagnostics.stats().inFlight) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 10));
        const left = Diagnostics.stats(); Diagnostics.stop();
        if (left.queued || left.inFlight) utils.infoWarn('DB', 'economy diagnostics stop dropped %d pending records', left.queued + left.inFlight);
    }
    let upTo = counters.upTo;
    if (worker) {
        try {
            upTo = await request('stop', STOP_TIMEOUT_MS);
        } catch (error) {
            // The outbox keeps what was not moved; the next start moves it.
            utils.infoWarn('DB', 'history thread stop: %s', error.message);
        }
    }
    const instance = worker;
    worker = null;
    rejectPending(new Error('history_worker_stopped'));
    if (instance) await instance.terminate().catch(() => {});
    reader?.close();
    reader = null;
    config = null;
    return upTo;
}

function all(sql, params = []) {
    if (!reader) throw new Error('History database is not open');
    return Statements.prepare(reader, sql).all(...params).map(normalizeRow);
}

function one(sql, params = []) {
    if (!reader) throw new Error('History database is not open');
    return normalizeRow(Statements.prepare(reader, sql).get(...params));
}

function stats() {
    if (!PopulationConfig.developerDiagnostics) return { path: config?.historyPath || null, running: !!worker, upTo: counters.upTo, diagnostics: { enabled: false } };
    return { path: config?.historyPath || null, running: !!worker, ...counters,
        ...(PopulationConfig.developerDiagnostics && PopulationConfig.economyDiagnostics ? { economyDiagnostics: { ...Diagnostics.stats(), writer: writerTelemetry } } : {}) };
}

module.exports = { all, flush, one, prepare, start, stats, stop };
