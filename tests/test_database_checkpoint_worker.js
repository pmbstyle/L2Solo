const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const workerThreads = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const Database = invoke('Database');
const CheckpointCoordinator = require('../src/DatabaseCheckpointCoordinator');
const databasePath = path.join(process.cwd(), 'tmp', 'test-database-checkpoint-worker.sqlite');
const secondDatabasePath = path.join(process.cwd(), 'tmp', 'test-database-checkpoint-worker-second.sqlite');
const keepAlive = setInterval(() => {}, 1000);

const databaseFiles = [databasePath, secondDatabasePath]
    .flatMap((file) => [file, `${file}-wal`, `${file}-shm`]);
for (const file of databaseFiles) fs.rmSync(file, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await delay(25);
    }
    return false;
}

async function run() {
    const autoCheckpoint = (await Database.execute(['PRAGMA wal_autocheckpoint'], 'test:wal-autocheckpoint'))[0];
    assert.strictEqual(Number(autoCheckpoint.wal_autocheckpoint), 0,
        'gameplay writes must never inherit SQLite synchronous auto-checkpoint stalls');
    assert(await waitFor(() => CheckpointCoordinator.snapshot().ready),
        'dedicated checkpoint worker must become ready after database initialization');

    await Database.execute(['CREATE TABLE checkpoint_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)']);
    await Database.execute([
        `WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 50000)
         INSERT INTO checkpoint_probe(id, value) SELECT value, printf('%080d', value) FROM seq`
    ], 'test:checkpoint-seed');

    const reader = new DatabaseSync(databasePath, { readOnly: true });
    reader.exec('BEGIN');
    assert.strictEqual(Number(reader.prepare('SELECT COUNT(*) count FROM checkpoint_probe').get().count), 50000);
    await Database.execute([
        `WITH RECURSIVE seq(value) AS (SELECT 50001 UNION ALL SELECT value + 1 FROM seq WHERE value < 100000)
         INSERT INTO checkpoint_probe(id, value) SELECT value, printf('%080d', value) FROM seq`
    ], 'test:checkpoint-reader-pinned-write');

    let mainLoopProgress = 0;
    const heartbeat = setInterval(() => { mainLoopProgress += 1; }, 1);
    const pinned = await Database.checkpoint();
    clearInterval(heartbeat);
    assert.strictEqual(pinned.ok, true, `worker checkpoint failed: ${pinned.error || 'unknown'}`);
    assert.strictEqual(pinned.mode, 'passive');
    assert(mainLoopProgress > 0 || pinned.durationMs < 1,
        'a non-trivial checkpoint must allow the main event loop to continue');
    assert(Number(pinned.logFrames) >= Number(pinned.checkpointedFrames),
        'PASSIVE checkpoint accounting must remain internally consistent under a pinned reader');

    reader.exec('ROLLBACK');
    reader.close();
    const drained = await Database.checkpoint();
    assert.strictEqual(drained.ok, true);
    assert(Number(drained.checkpointedFrames) <= Number(drained.logFrames));
    const reset = await Database.checkpoint({ mode: 'restart', busyTimeoutMs: 50 });
    assert.strictEqual(reset.ok, true);
    assert.strictEqual(reset.mode, 'restart', 'idle maintenance must be able to reset a fully checkpointed WAL generation');
    assert.strictEqual(Number(reset.busy), 0, 'a drained WAL must reset without waiting on another owner');
    assert(Number(reset.pageSize) >= 512, 'checkpoint telemetry must expose the SQLite page size');
    assert(Number(reset.generationBytes) > 0, 'checkpoint telemetry must expose logical WAL generation bytes');
    assert.strictEqual(CheckpointCoordinator.snapshot().resets, 1, 'successful reset telemetry must be explicit');
    assert.strictEqual(CheckpointCoordinator.snapshot().lastReset.mode, 'restart');
    const beforeCrash = CheckpointCoordinator.snapshot();

    await CheckpointCoordinator.terminateForTest();
    await Database.execute(['INSERT INTO checkpoint_probe(id, value) VALUES (100001, ?)', ['after-worker-crash']],
        'test:write-after-checkpoint-worker-crash');
    assert(await waitFor(() => {
        const state = CheckpointCoordinator.snapshot();
        return state.ready && state.restarts > beforeCrash.restarts;
    }), 'checkpoint worker must restart independently without interrupting authoritative writes');
    const recovered = await Database.checkpoint();
    assert.strictEqual(recovered.ok, true);

    const snapshot = Database.stats().checkpoint;
    assert.strictEqual(snapshot.ready, true);
    assert(snapshot.completed >= 4, 'checkpoint telemetry must expose completed worker runs');
    assert(snapshot.restarts >= 1, 'checkpoint telemetry must expose worker recovery');
    assert.strictEqual(snapshot.errors, 0, 'a deliberate worker exit must not be reported as a database failure');

    assert.strictEqual(await Database.close(), true);
    const verification = new DatabaseSync(databasePath, { readOnly: true });
    assert.strictEqual(Number(verification.prepare('SELECT COUNT(*) count FROM checkpoint_probe').get().count), 100001,
        'worker failure and graceful final checkpoint must preserve every committed row');
    verification.close();
    const walSize = fs.existsSync(`${databasePath}-wal`) ? fs.statSync(`${databasePath}-wal`).size : 0;
    assert.strictEqual(walSize, 0, 'graceful close must leave no checkpoint debt behind');

    options.default.Database.path = path.relative(process.cwd(), secondDatabasePath);
    Database.init();
    assert.strictEqual(CheckpointCoordinator.snapshot().lastReset, null,
        'a new database lifecycle must not inherit the previous database reset baseline');
    assert.strictEqual(CheckpointCoordinator.snapshot().resets, 0,
        'checkpoint counters must describe only the active database lifecycle');
    assert.strictEqual(await Database.close(), true);

    const coordinatorPath = require.resolve('../src/DatabaseCheckpointCoordinator');
    const OriginalWorker = workerThreads.Worker;
    class FailingCheckpointWorker extends EventEmitter {
        constructor() {
            super();
            queueMicrotask(() => this.emit('message', { type: 'ready' }));
        }

        unref() {}

        postMessage(message) {
            if (message.type === 'checkpoint') {
                queueMicrotask(() => this.emit('message', {
                    type: 'result',
                    id: message.id,
                    result: { ok: false, error: 'synthetic_checkpoint_failure' }
                }));
            } else if (message.type === 'shutdown') {
                queueMicrotask(() => this.emit('message', {
                    type: 'result',
                    id: message.id,
                    result: { ok: true, mode: 'passive', busy: 0 }
                }));
            }
        }

        async terminate() {}
    }

    delete require.cache[coordinatorPath];
    workerThreads.Worker = FailingCheckpointWorker;
    const ErrorCoordinator = require(coordinatorPath);
    try {
        ErrorCoordinator.start(path.join(process.cwd(), 'tmp', 'synthetic-checkpoint-error.sqlite'), { intervalMs: 60000 });
        assert(await waitFor(() => ErrorCoordinator.snapshot().ready));
        const failedReset = await ErrorCoordinator.request({ force: true, mode: 'restart' });
        assert.strictEqual(failedReset.mode, 'restart', 'failed checkpoint results must retain their requested mode');
        assert.strictEqual(ErrorCoordinator.snapshot().resetErrors, 1,
            'a failed RESTART must increment reset-specific error telemetry');
        await ErrorCoordinator.stop({ final: false });
    } finally {
        workerThreads.Worker = OriginalWorker;
        delete require.cache[coordinatorPath];
    }
    console.log('Database checkpoint worker isolation and recovery checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
    for (const file of databaseFiles) fs.rmSync(file, { force: true });
    clearInterval(keepAlive);
});
