'use strict';
process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const root = path.resolve(__dirname, '..');
const isolated = require('./helpers/isolatedSocialDatabase')('checkpoint-tail-barrier', root);
process.chdir(root);
require('./helpers/databaseIsolation');
const sqlite = require('node:sqlite');
const NativeDatabase = sqlite.DatabaseSync;
const allowed = new Set([isolated.world, isolated.history, isolated.world + '.access.sqlite']);
const physicalDirectory = fs.realpathSync(isolated.directory);
const nativeFailures = [];
const writeSql = 'UPDATE checkpoint_barrier_probe SET value=? WHERE id=1';
let connection, writeAttempts = 0;

// The fixture owns its paths before Global and every native open. Observe
// actual SQLite exceptions without changing SQL, return values or Error identity.
class ObservedDatabase extends NativeDatabase {
    constructor(filename, settings) {
        assert(path.isAbsolute(filename) && allowed.has(filename), 'only exact fixture databases may open');
        if (fs.existsSync(filename)) {
            assert.equal(fs.realpathSync(filename), path.join(physicalDirectory, path.basename(filename)),
                'fixture files must stay inside their own physical directory');
            assert.equal(fs.statSync(filename).nlink, 1, 'fixture databases cannot be foreign hard links');
        }
        super(filename, settings);
        if (filename === isolated.world && !connection) connection = this;
    }
    prepare(...args) {
        let statement;
        try { statement = super.prepare(...args); }
        catch (error) { if (this === connection) nativeFailures.push(error); throw error; }
        if (this !== connection) return statement;
        return new Proxy(statement, { get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            return (...parameters) => {
                if (args[0] === writeSql && ['run', 'get', 'all'].includes(key)) writeAttempts += 1;
                try { return Reflect.apply(value, target, parameters); }
                catch (error) { nativeFailures.push(error); throw error; }
            };
        } });
    }
}
sqlite.DatabaseSync = ObservedDatabase;
require('../src/Global');
isolated.assertConfigured(options.default);
// The real background services still run. Their periodic maintenance is kept
// outside this short, explicitly controlled writer phase; busy_timeout stays 5000.
options.default.Database.checkpointIntervalMs = 60000;
options.default.Database.historyTransferMs = 60000;
const Database = invoke('Database');
const Coordinator = require('../src/DatabaseCheckpointCoordinator');
const requestDescriptor = Object.getOwnPropertyDescriptor(Coordinator, 'request');
const holders = new Set();
const gates = new Set();
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => {
    console.error('Checkpoint barrier fixture exceeded its 120 second bound');
    process.exitCode = 1;
    for (const gate of gates) gate.resolve();
    for (const entry of holders) entry.worker.postMessage('release');
}, 120000);
deadline.unref();
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    const result = { promise, resolve, reject };
    gates.add(result);
    return result;
}
async function waitFor(predicate, message, timeout = 4000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (predicate()) return;
        await delay(10);
    }
    assert.fail(message);
}
function setRequest(work) {
    Object.defineProperty(Coordinator, 'request', { ...requestDescriptor, value: work });
}
function restoreRequest() { Object.defineProperty(Coordinator, 'request', requestDescriptor); }
const facts = () => connection.prepare('SELECT id,value FROM checkpoint_barrier_probe ORDER BY id').all()
    .map(row => ({ id: row.id, value: row.value }));
const committed = value => [{ id: 1, value }, { id: 2, value: 0 }];
const write = (value, operation, onTiming) => Database.execute([
    writeSql, [value], { onTiming }
], operation);
async function rejected(work) {
    try { await work(); } catch (error) { return error; }
    assert.fail('the operation must reject');
}

async function heldWriter() {
    // This is a real, unrelated SQLite connection holding BEGIN IMMEDIATE.
    // Its release promise stands in for a reset request's asynchronous lock
    // lifetime. It is NOT a TRUNCATE measurement or the owner of a runtime fault.
    // test_database_checkpoint_worker.js covers the real Coordinator/PRAGMA path.
    const worker = new Worker(`
        'use strict';
        const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
        const {parentPort,workerData}=require('node:worker_threads');
        const sqlite=require('node:sqlite'),NativeDatabase=sqlite.DatabaseSync;
        assert(path.isAbsolute(workerData.world));
        assert.equal(path.dirname(workerData.world),workerData.directory);
        assert.equal(fs.realpathSync(workerData.world),path.join(fs.realpathSync(workerData.directory),path.basename(workerData.world)));
        assert.equal(fs.statSync(workerData.world).nlink,1);
        sqlite.DatabaseSync=class OwnedDatabase extends NativeDatabase {
            constructor(filename,options) {
                assert.equal(filename,workerData.world,'holder may open only its exact fixture database');
                super(filename,options);
            }
        };
        const db=new sqlite.DatabaseSync(workerData.world,{timeout:5000});
        db.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE');
        db.prepare('UPDATE checkpoint_barrier_probe SET value=999 WHERE id=2').run();
        let released=false,phaseTimer;
        const release=()=>{
            if(released)return;released=true;clearTimeout(phaseTimer);clearTimeout(safetyTimer);
            db.exec('ROLLBACK');db.close();parentPort.postMessage('released');parentPort.close();
        };
        const safetyTimer=setTimeout(release,12000);
        parentPort.on('message',message=>{
            if(message==='phase'&&!phaseTimer)phaseTimer=setTimeout(release,5500);
            if(message==='release')release();
        });
        parentPort.postMessage('locked');
    `, { eval: true, workerData: { world: isolated.world, directory: isolated.directory } });
    let readyResolve, readyReject, releaseResolve, releaseReject, exitResolve, exitReject, goneResolve;
    const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
    const released = new Promise((yes, no) => { releaseResolve = yes; releaseReject = no; });
    const exited = new Promise((yes, no) => { exitResolve = yes; exitReject = no; });
    const gone = new Promise(resolve => { goneResolve = resolve; });
    for (const promise of [ready, released, exited]) promise.catch(() => {});
    const entry = { worker, ready, released, exited, gone, ended: false, nativeReleased: false, code: null };
    holders.add(entry);
    worker.on('message', message => {
        if (message === 'locked') readyResolve();
        if (message === 'released') { entry.nativeReleased = true; releaseResolve(); }
    });
    worker.once('error', error => { readyReject(error); releaseReject(error); exitReject(error); });
    worker.once('exit', code => {
        entry.ended = true; entry.code = code;
        goneResolve(code);
        if (code !== 0 || !entry.nativeReleased) {
            const error = Error(`holder exited before a clean native release: ${code}`);
            readyReject(error); releaseReject(error); exitReject(error);
        } else exitResolve();
    });
    await ready;
    return entry;
}
async function drainHolder(entry) {
    await entry.released; await entry.exited;
    assert.equal(entry.code, 0, 'physical writers must exit naturally after rollback and native close');
}

async function run() {
    const foreign = path.join(isolated.directory, 'foreign.sqlite');
    for (const readOnly of [true, false]) assert.throws(() => new sqlite.DatabaseSync(foreign, { readOnly }),
        /only exact fixture databases may open/, 'foreign paths fail before the native constructor');
    assert.equal(fs.existsSync(foreign), false);
    checks.push('foreign readonly and writable native opens are refused');
    let earlyGetterReads = 0;
    const notInitialized = await rejected(() => Database.checkpoint({ get mode() { earlyGetterReads += 1; } }));
    assert.equal(notInitialized.message, 'SQLite is not initialized (maintenance:checkpoint)');
    assert.equal(earlyGetterReads, 0, 'the initialization guard precedes caller getters');
    checks.push('not-initialized guard');
    Database.init(); assert(Database.isReady()); assert(connection);
    assert.equal(connection.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    await waitFor(() => Coordinator.snapshot().ready, 'actual checkpoint worker must start');
    await Database.execute(['CREATE TABLE checkpoint_barrier_probe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)']);
    await Database.execute(['INSERT INTO checkpoint_barrier_probe VALUES(1,0),(2,0)']);

    const firstHolder = await heldWriter();
    const before = Database.stats().failures, attemptsBefore = writeAttempts;
    let resetRequests = 0, timing, error;
    setRequest(request => {
        assert.equal(request.mode, 'truncate'); resetRequests += 1;
        firstHolder.worker.postMessage('phase');
        return firstHolder.released;
    });
    const reset = Database.checkpoint({ mode: 'truncate', busyTimeoutMs: 50 });
    const update = write(1, 'test:checkpoint-barrier-overlap', value => { timing = value; });
    try { await update; } catch (caught) { error = caught; }
    await reset; await drainHolder(firstHolder);
    restoreRequest();
    console.log('Physical reset-phase control:', JSON.stringify({
        sqliteCode: error?.errcode ?? null, failuresDelta: Database.stats().failures - before,
        resetRequests, writeAttempts: writeAttempts - attemptsBefore, timing, rows: facts()
    }));
    if (error) assert.equal(error, nativeFailures.at(-1), 'the original native rejection identity must be preserved');
    assert.equal(error, undefined, 'a reset reserves the Main writer tail until its physical lock phase releases');
    assert.equal(resetRequests, 1, 'the queued writer is not retried');
    assert.equal(writeAttempts, attemptsBefore + 1, 'one queued operation performs exactly one native write attempt');
    assert.equal(Database.stats().failures, before, 'serialization must not create a SQL failure');
    assert(timing.waitMs >= 5000, 'the writer waits in the queue, with SQLite busy_timeout unchanged');
    assert.deepEqual(facts(), committed(1), 'only the queued Main update commits; holder changes roll back');
    checks.push('physical reset phase serializes native writer without retry');

    const unrelatedHolder = await heldWriter();
    const nativeBefore = nativeFailures.length, unrelatedBefore = Database.stats().failures, unrelatedAttempts = writeAttempts;
    unrelatedHolder.worker.postMessage('phase');
    const busy = await rejected(() => write(2, 'test:checkpoint-barrier-unrelated-writer'));
    assert.equal(nativeFailures.length, nativeBefore + 1);
    assert.equal(busy, nativeFailures.at(-1));
    assert.equal(busy.code, 'ERR_SQLITE_ERROR'); assert.equal(busy.errcode, 5);
    assert.equal(Database.stats().failures, unrelatedBefore + 1, 'unrelated native lock failures remain failures');
    assert.equal(writeAttempts, unrelatedAttempts + 1, 'a native lock refusal is not retried');
    await drainHolder(unrelatedHolder);
    assert.deepEqual(facts(), committed(1));
    console.log('Unrelated native writer control:', JSON.stringify({ sqliteCode: busy.errcode, failuresDelta: 1, rows: facts() }));
    checks.push('unrelated writer still produces exact native SQLITE_BUSY');

    const firstGate = deferred(), secondGate = deferred();
    const calls = [], order = [];
    setRequest(request => {
        calls.push(request); order.push(request.mode === 'passive' ? 'passive' : `reset${calls.filter(row => row.mode !== 'passive').length}`);
        if (request.mode === 'passive') return Promise.resolve('passive-result');
        return calls.filter(row => row.mode !== 'passive').length === 1 ? firstGate.promise : secondGate.promise;
    });
    const prior = write(1, 'test:checkpoint-barrier-prior', () => order.push('main0'));
    const firstReset = Database.checkpoint({ mode: 'restart', busyTimeoutMs: 25 });
    await waitFor(() => calls.length === 1, 'first reset must follow the prior native queue job');
    assert.deepEqual(order, ['main0', 'reset1']);
    const between = write(1, 'test:checkpoint-barrier-between', () => order.push('main1'));
    const mutable = { mode: 'truncate', busyTimeoutMs: 50 };
    let modeReads = 0, timeoutReads = 0;
    const secondReset = Database.checkpoint({
        get mode() { modeReads += 1; return mutable.mode; },
        get busyTimeoutMs() { timeoutReads += 1; return mutable.busyTimeoutMs; }
    });
    assert.equal(modeReads, 1); assert.equal(timeoutReads, 1, 'caller options are read at the original call boundary');
    mutable.mode = 'restart'; mutable.busyTimeoutMs = 200;
    const after = write(1, 'test:checkpoint-barrier-after', () => order.push('main2'));
    const getterError = Error('fixture option getter failed');
    assert.throws(() => Database.checkpoint({ get mode() { throw getterError; } }), error => error === getterError,
        'throwing option getters remain synchronous, with the original Error');
    const timeoutError = Error('fixture timeout getter failed');
    assert.throws(() => Database.checkpoint({ mode: 'restart', get busyTimeoutMs() { throw timeoutError; } }),
        error => error === timeoutError, 'a timeout getter also throws at the original call boundary');
    assert.equal(await Database.checkpoint(), 'passive-result', 'PASSIVE bypasses the reserved Main tail');
    assert.deepEqual(order, ['main0', 'reset1', 'passive']);
    assert.deepEqual(facts(), committed(1));
    firstGate.resolve('first-result');
    await waitFor(() => calls.length === 3, 'second reset must follow the intervening native job');
    assert.deepEqual(order, ['main0', 'reset1', 'passive', 'main1', 'reset2']);
    assert.deepEqual(calls[2], { force: true, mode: 'truncate', minWalBytes: 0, busyTimeoutMs: 50 });
    assert.equal(modeReads, 1); assert.equal(timeoutReads, 1, 'queued maintenance must not reread mutable caller options');
    secondGate.resolve('second-result');
    assert.deepEqual(await Promise.all([prior, firstReset, between, secondReset, after]).then(values => [values[1], values[3]]),
        ['first-result', 'second-result']);
    assert.deepEqual(order, ['main0', 'reset1', 'passive', 'main1', 'reset2', 'main2']);
    restoreRequest();
    checks.push('prior job, two resets, intervening and later jobs preserve order');
    checks.push('options snapshot and synchronous getter Error boundary');
    checks.push('PASSIVE bypass remains outside the Main reservation');

    const requestError = Error('fixture coordinator rejected reset');
    const failuresBeforeRequest = Database.stats().failures;
    setRequest(() => Promise.reject(requestError));
    assert.equal(await rejected(() => Database.checkpoint({ mode: 'restart' })), requestError);
    const requestThrow = Error('fixture coordinator request threw');
    setRequest(() => { throw requestThrow; });
    assert.equal(await rejected(() => Database.checkpoint({ mode: 'truncate' })), requestThrow);
    restoreRequest();
    assert.equal(Database.stats().failures, failuresBeforeRequest, 'a coordinator rejection is not a SQL attempt');
    await write(1, 'test:checkpoint-barrier-after-reset-error');
    const beforeUnknown = Database.stats().failures, unknownCount = nativeFailures.length;
    const unknown = await rejected(() => Database.execute(['SELECT * FROM checkpoint_barrier_missing'], 'test:checkpoint-barrier-unknown-sql'));
    assert.equal(nativeFailures.length, unknownCount + 1);
    assert.equal(unknown, nativeFailures.at(-1));
    assert.equal(unknown.code, 'ERR_SQLITE_ERROR'); assert.equal(unknown.errcode, 1);
    assert.equal(Database.stats().failures, beforeUnknown + 1, 'unknown SQL errors keep native failure accounting');
    await write(1, 'test:checkpoint-barrier-after-sql-error');
    assert.deepEqual(facts(), committed(1));
    checks.push('same coordinator/native SQL rejection identity and queue recovery');

    const closeGate = deferred();
    let closeRequestStarted = false, closed = false;
    setRequest(() => { closeRequestStarted = true; return closeGate.promise; });
    const closingReset = Database.checkpoint({ mode: 'truncate' });
    await waitFor(() => closeRequestStarted, 'close control needs an active reserved reset');
    const close = Database.close();
    close.then(() => { closed = true; }, () => {});
    assert.equal(Database.close(), close, 'concurrent close callers share the native close promise');
    let shutdownGetterReads = 0;
    const shutdown = await rejected(() => Database.checkpoint({ get mode() { shutdownGetterReads += 1; } }));
    assert.equal(shutdown.message, 'SQLite shutdown is in progress (maintenance:checkpoint)');
    assert.equal(shutdownGetterReads, 0);
    await delay(20);
    assert.equal(closed, false, 'close must not stop native services or close the connection before the reset releases');
    assert(Database.isReady()); assert(Coordinator.snapshot().started);
    restoreRequest(); closeGate.resolve();
    await closingReset; assert.equal(await close, true);
    assert.equal(Database.isReady(), false); assert.equal(Coordinator.snapshot().started, false);
    assert.equal(Database.stats().history.running, false, 'native history worker must also be stopped');
    const verification = new sqlite.DatabaseSync(isolated.world, { readOnly: true });
    try {
        assert.deepEqual(verification.prepare('SELECT id,value FROM checkpoint_barrier_probe ORDER BY id').all()
            .map(row => ({ id: row.id, value: row.value })), committed(1));
    } finally { verification.close(); }
    checks.push('close awaits reservation, preserves shutdown guard and physical rows');
}

(async () => {
    let failure, cleanupFailure, closed = false;
    try { await run(); }
    catch (error) { failure = error; }
    finally {
        restoreRequest();
        for (const gate of gates) gate.resolve();
        for (const entry of holders) if (!entry.ended) entry.worker.postMessage('release');
        const holderCleanup = await Promise.allSettled([...holders].map(async entry => {
            const drained = await Promise.race([entry.gone.then(() => true), delay(4000).then(() => false)]);
            if (!drained) { await entry.worker.terminate(); await entry.gone; throw Error('holder required forced cleanup'); }
            assert(entry.ended); assert.equal(entry.code, 0);
        }));
        for (const result of holderCleanup) if (result.status === 'rejected') cleanupFailure ||= result.reason;
        try { await Database.close(); closed = !Database.isReady() && !Coordinator.snapshot().started && !Database.stats().history.running; }
        catch (error) { cleanupFailure ||= error; }
        sqlite.DatabaseSync = NativeDatabase;
        clearInterval(keepAlive); clearTimeout(deadline);
        if (closed && [...holders].every(entry => entry.ended)) fs.rmSync(isolated.directory, { recursive: true, force: true });
        else cleanupFailure ||= Error('native fixture still owns an active database or worker');
    }
    if (failure || cleanupFailure) {
        if (failure) console.error(failure);
        if (cleanupFailure) console.error('Fixture cleanup failed:', cleanupFailure);
        process.exitCode = 1;
    } else console.log('Database checkpoint barrier: PASS', JSON.stringify({ controls: checks, nativeWriterExits: [...holders].map(entry => entry.code) }));
})();
