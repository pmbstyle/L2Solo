'use strict';
const assert = require('node:assert/strict');
require('../src/GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const isolated = require('./helpers/isolatedSocialDatabase')('transaction-diagnostics', root);
process.chdir(root);
const sqlite = require('node:sqlite');
const NativeDatabase = sqlite.DatabaseSync;
const allowed = new Set([isolated.world, isolated.history, isolated.world + '.access.sqlite']);
const nativeFailures = [];
const getterFailure = Error('fixture code getter unavailable');
let connection, throwCodeGetter = false, writer, writerExited;

// Observe real native exceptions and return values without changing SQL,
// results, queue order or production exports. Only the separate getter control
// changes an already thrown native Error; ordinary controls keep it untouched.
function observe(error, method) {
    nativeFailures.push({ error, method, code: error.code, sqliteCode: error.errcode });
    if (throwCodeGetter && error.errcode === 1) {
        Object.defineProperty(error, 'code', { configurable: true, get() { throw getterFailure; } });
    }
    throw error;
}
class ObservedDatabase extends NativeDatabase {
    constructor(filename, settings) {
        assert(path.isAbsolute(filename) && allowed.has(filename), 'only exact fixture databases can open');
        super(filename, settings);
        if (filename === isolated.world && !connection) connection = this;
    }
    exec(...args) {
        try { return super.exec(...args); }
        catch (error) { if (this === connection) observe(error, 'exec'); throw error; }
    }
    prepare(...args) {
        let statement;
        try { statement = super.prepare(...args); }
        catch (error) { if (this === connection) observe(error, 'prepare'); throw error; }
        if (this !== connection) return statement;
        return new Proxy(statement, { get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            return (...parameters) => {
                try { return Reflect.apply(value, target, parameters); }
                catch (error) { observe(error, String(key)); }
            };
        } });
    }
}
sqlite.DatabaseSync = ObservedDatabase;
require(path.join(root, 'src/Global'));
isolated.assertConfigured(options.default);
// Native background database services stay active, with a long periodic
// maintenance interval so this fixture's explicit writer defines the lock.
options.default.Database.checkpointIntervalMs = 60000;
options.default.Database.historyTransferMs = 60000;
const Database = invoke('Database');
const originalWarn = console.warn;
const logs = [];
let loggerThrows = false;
console.warn = (format, serialized, ...rest) => {
    if (format !== 'DB          :: sqlite transaction failure %s') return originalWarn(format, serialized, ...rest);
    if (loggerThrows) throw Error('fixture logger unavailable');
    logs.push(JSON.parse(serialized));
};
const deadline = setTimeout(() => { console.error('Native transaction diagnostic fixture exceeded 45 seconds'); process.exit(1); }, 45000);
deadline.unref();
const claim = ids => Database.claimColdSimulationLeases(ids.map(characterId => ({
    characterId, expectedRevision: 0, ownerId: 'cold_simulation_owner',
    leaseId: `diagnostic:${characterId}`, timestamp: 1000, leaseUntil: 10000
})));
const rowFacts = () => Database.execute([
    'SELECT characterId,simulationOwner,simulationRevision,simulationLeaseId,simulationLeaseUntil FROM bot_life_state ORDER BY characterId'
]);
const tableCount = table => Database.execute([`SELECT COUNT(*) AS n FROM ${table}`]).then(rows => rows[0].n);
async function rejectedNative(work, sqliteCode) {
    const previous = nativeFailures.length;
    let actual;
    try { await work(); } catch (error) { actual = error; }
    assert(actual, 'the real native operation must reject');
    assert.equal(nativeFailures.length, previous + 1);
    const native = nativeFailures.at(-1);
    assert.equal(actual, native.error, 'the exact native Error reaches the caller');
    assert.equal(native.code, 'ERR_SQLITE_ERROR');
    assert.equal(native.sqliteCode, sqliteCode);
    return native;
}
async function seed(index) {
    const username = `bot_transaction_diag_${index}`;
    await Database.createAccount(username, 'fixture');
    const id = Number((await Database.createCharacter(username, {
        name: `TransactionDiag${index}`, race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    })).insertId);
    await Database.execute([
        "INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,statsJson) VALUES(?,?,?,'cold','hunting','{}')",
        [id, username, `TransactionDiag${index}`]
    ]);
    return id;
}
async function installWorkFault(id) {
    await Database.execute([`CREATE TRIGGER diagnostic_work_fault AFTER UPDATE OF simulationRevision ON bot_life_state
        WHEN NEW.characterId = ${id} BEGIN
            INSERT INTO diagnostic_effects(id,parentId) VALUES(NEW.characterId,NULL);
            SELECT json_extract('SECRET_DIAGNOSTIC_SQL_VALUE', '$.value');
        END`]);
}
(async () => {
    Database.init(); assert(Database.isReady()); assert(connection);
    assert.equal(connection.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    const ids = [await seed(1), await seed(2)];
    await Database.execute(['CREATE TABLE diagnostic_latch(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)']);
    await Database.execute(['INSERT INTO diagnostic_latch VALUES(1,0)']);
    await Database.execute(['CREATE TABLE diagnostic_parents(id INTEGER PRIMARY KEY)']);
    await Database.execute(['CREATE TABLE diagnostic_effects(id INTEGER PRIMARY KEY,parentId INTEGER REFERENCES diagnostic_parents(id) DEFERRABLE INITIALLY DEFERRED)']);
    const before = await rowFacts(), failuresBefore = Database.stats().failures;
    writer = new Worker(`
        const assert=require('node:assert/strict'),path=require('node:path');
        const {parentPort,workerData}=require('node:worker_threads');
        const {DatabaseSync}=require('node:sqlite');
        assert(path.isAbsolute(workerData.world));
        const db=new DatabaseSync(workerData.world);
        db.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE');
        db.prepare('UPDATE diagnostic_latch SET value=1 WHERE id=1').run();
        parentPort.postMessage('locked');
        setTimeout(()=>{db.exec('COMMIT');db.close();parentPort.postMessage('released');parentPort.close();},5500);
    `, { eval: true, workerData: { world: isolated.world } });
    writerExited = new Promise((resolve, reject) => { writer.once('error', reject); writer.once('exit', code => code === 0 ? resolve() : reject(Error(`writer exit ${code}`))); });
    const released = new Promise((resolve, reject) => {
        writer.on('message', message => { if (message === 'released') resolve(); }); writer.once('error', reject);
    });
    await new Promise((resolve, reject) => {
        writer.once('message', message => { assert.equal(message, 'locked'); resolve(); }); writer.once('error', reject);
    });
    await rejectedNative(() => claim(ids), 5);
    assert.equal(logs.length, 1, 'a native BEGIN failure must emit diagnostics');
    assert.equal(logs[0].phase, 'begin');
    assert.equal(logs[0].operation, 'bot-life:cold-owner-claim-batch');
    assert.equal(logs[0].sqliteCode, 5);
    await released; await writerExited; writer = null;
    assert.deepEqual(await rowFacts(), before);
    assert.equal(Database.stats().failures, failuresBefore + 1);

    await installWorkFault(ids[1]);
    await rejectedNative(() => claim(ids), 1);
    assert.equal(logs[1].phase, 'work'); assert.equal(logs[1].sqliteCode, 1);
    assert.deepEqual(await rowFacts(), before, 'both earlier claim CAS and trigger effect roll back');
    assert.equal(await tableCount('diagnostic_effects'), 0);
    assert.equal(Database.stats().failures, failuresBefore + 2);
    await Database.execute(['DROP TRIGGER diagnostic_work_fault']);

    await Database.execute([`CREATE TRIGGER diagnostic_commit_fault AFTER UPDATE OF simulationRevision ON bot_life_state
        WHEN NEW.characterId = ${ids[1]} BEGIN
            INSERT INTO diagnostic_effects(id,parentId) VALUES(NEW.characterId,999999);
        END`]);
    await rejectedNative(() => claim(ids), 787);
    assert.equal(logs[2].phase, 'commit'); assert.equal(logs[2].sqliteCode, 787);
    assert.deepEqual(await rowFacts(), before);
    assert.equal(await tableCount('diagnostic_effects'), 0);
    assert.equal(Database.stats().failures, failuresBefore + 3);
    await Database.execute(['DROP TRIGGER diagnostic_commit_fault']);

    await installWorkFault(ids[1]);
    loggerThrows = true;
    await rejectedNative(() => claim(ids), 1);
    loggerThrows = false;
    assert.deepEqual(await rowFacts(), before);
    assert.equal(await tableCount('diagnostic_effects'), 0);
    assert.equal(logs.length, 3);
    assert.equal(Database.stats().failures, failuresBefore + 4);

    // Nonordinary error-descriptor control, separate from the unchanged
    // native codes 5/1/787 above. The helper must not mask it or skip rollback.
    throwCodeGetter = true;
    const getterNative = await rejectedNative(() => claim(ids), 1);
    throwCodeGetter = false;
    assert.throws(() => getterNative.error.code, error => error === getterFailure);
    assert.deepEqual(await rowFacts(), before);
    assert.equal(await tableCount('diagnostic_effects'), 0);
    assert.equal(logs.length, 3);
    assert.equal(Database.stats().failures, failuresBefore + 5);
    await Database.execute(['DROP TRIGGER diagnostic_work_fault']);

    const granted = await claim(ids);
    assert(granted.every(row => row.ok));
    assert((await rowFacts()).every(row => row.simulationRevision === 1));
    const stale = await claim(ids);
    assert(stale.every(row => row.reason === 'stale_revision'));
    assert.equal(Database.stats().failures, failuresBefore + 5);
    assert.equal(logs.length, 3, 'successful and stale CAS transactions do not log');
    for (const log of logs) {
        assert.equal(log.code, 'ERR_SQLITE_ERROR');
        assert.equal(log.configuredWriterBusyTimeoutMs, 5000);
        assert(log.frames.length > 0 && log.frames.length <= 8);
        assert(log.frames.every(frame => /^\s+at /.test(frame)));
    }
    assert(!JSON.stringify(logs).includes('SECRET_DIAGNOSTIC_SQL_VALUE'));
    console.log(JSON.stringify({ pass: true, nativeInit: true, fullSchema: true, actualClaimBatch: true,
        phases: logs.map(log => log.phase), sqliteCodes: logs.map(log => log.sqliteCode),
        ordinaryFailureDelta: 4, nonordinaryGetterFailureDelta: 1, sameNativeError: true,
        rollback: true, successfulAndStaleTransactionsLog: false, noSqlOrParameters: true }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    loggerThrows = false; throwCodeGetter = false; console.warn = originalWarn;
    if (writer) { await writerExited.catch(() => null); await writer.terminate(); }
    await Database.close(); sqlite.DatabaseSync = NativeDatabase;
    clearTimeout(deadline); fs.rmSync(isolated.directory, { recursive: true, force: true });
});
