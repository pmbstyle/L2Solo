'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('life-save-diagnostics', root);
const sqlite = require('node:sqlite'), NativeDatabase = sqlite.DatabaseSync;
const allowed = new Set([isolated.world, isolated.history, isolated.world + '.access.sqlite']);
const nativeFailures = [];
let connection, loggerThrows = false, codeGetterThrows = false;
const getterFailure = Error('diagnostic getter unavailable');
class ObservedDatabase extends NativeDatabase {
    constructor(filename, settings) {
        assert(path.isAbsolute(filename) && allowed.has(filename));
        super(filename, settings);
        if (filename === isolated.world && !connection) connection = this;
    }
    prepare(...args) {
        const statement = super.prepare(...args);
        if (this !== connection) return statement;
        return new Proxy(statement, { get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            return (...parameters) => {
                try { return Reflect.apply(value, target, parameters); }
                catch (error) {
                    nativeFailures.push(error);
                    if (codeGetterThrows) Object.defineProperty(error, 'code', { get() { throw getterFailure; } });
                    throw error;
                }
            };
        } });
    }
}
sqlite.DatabaseSync = ObservedDatabase;
require(path.join(root, 'src/Global'));
isolated.assertConfigured(options.default);
options.default.Database.checkpointIntervalMs = 60000;
options.default.Database.historyTransferMs = 60000;
const Database = invoke('Database');
const Checkpoint = invoke('GameServer/Bot/Population/NativeWriteCheckpoint');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { WorkerCommandAdmissionRefusal } = invoke('GameServer/Bot/Population/WorkerCommandAdmission');
const logs = [], originalWarn = console.warn, originalCheck = Checkpoint.check;
let refusedError;
Checkpoint.check = (...args) => {
    try { return originalCheck(...args); }
    catch (error) { refusedError = error; throw error; }
};
console.warn = (format, value, ...rest) => {
    if (format !== 'DB          :: bot life save failure %s') return originalWarn(format, value, ...rest);
    if (loggerThrows) throw Error('diagnostic logger unavailable');
    logs.push(JSON.parse(value));
};
const deadline = setTimeout(() => { console.error('Life-save diagnostic fixture exceeded 30 seconds'); process.exit(1); }, 30000);
deadline.unref();
async function rejection(work, expected) {
    let actual;
    try { await work(); } catch (error) { actual = error; }
    assert(actual);
    assert.equal(actual, expected(), 'diagnostics preserve the exact original rejection');
    return actual;
}
(async () => {
    Database.init(); assert(Database.isReady());
    await Database.createAccount('bot_save_diag', 'fixture');
    const id = Number((await Database.createCharacter('bot_save_diag', {
        name: 'LifeSaveDiag', race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    })).insertId);
    await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,
        activityStartedAt,nextResolveAt,lastResolvedAt,lastHotAt,updatedAt,statsJson)
        VALUES(?,?,?,'cold','resting',0,0,0,0,0,'{}')`, [id, 'bot_save_diag', 'LifeSaveDiag']]);
    const state = (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0];
    const beforeWrite = Checkpoint.create(id, { workerAdmission: {
        characterId: id, commandId: 'save-diagnostic', commandCheckpoint: Protocol.commandCheckpoint(state), check: () => null
    } });
    const statement = ['UPDATE bot_life_state SET statsJson=?2 WHERE characterId=?1', [id, '{"secret":"SECRET_SAVE_PARAMETER"}']];
    Checkpoint.bindRow(beforeWrite, statement, id);
    const baseFailures = Database.stats().failures;
    assert.equal((await Database.saveBotLifeState(statement, { beforeWrite })).affectedRows, 1);
    assert.equal(logs.length, 0, 'successful native saves do not log');
    const facts = () => Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
    const saved = await facts();
    await Database.execute([`CREATE TRIGGER save_diagnostic_fault BEFORE UPDATE ON bot_life_state
        BEGIN SELECT json_extract('SECRET_SAVE_SQL', '$.value'); END`]);
    await rejection(() => Database.saveBotLifeState(statement, { beforeWrite }), () => nativeFailures.at(-1));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].phase, 'write');
    assert.equal(logs[0].code, 'ERR_SQLITE_ERROR');
    assert.equal(logs[0].sqliteCode, 1);
    assert.deepEqual(await facts(), saved, 'the actual native failed statement has no physical side effects');
    loggerThrows = true;
    await rejection(() => Database.saveBotLifeState(statement, { beforeWrite }), () => nativeFailures.at(-1));
    loggerThrows = false;
    assert.equal(logs.length, 1);
    codeGetterThrows = true;
    const malformed = await rejection(() => Database.saveBotLifeState(statement, { beforeWrite }), () => nativeFailures.at(-1));
    codeGetterThrows = false;
    assert.throws(() => malformed.code, error => error === getterFailure);
    assert.equal(logs.length, 1);
    await Database.execute(['DROP TRIGGER save_diagnostic_fault']);
    await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [id]]);
    const revised = await facts();
    const refusal = await rejection(() => Database.saveBotLifeState(statement, { beforeWrite }), () => refusedError);
    assert(refusal instanceof WorkerCommandAdmissionRefusal);
    assert.equal(logs.length, 2);
    assert.equal(logs[1].phase, 'write_admission');
    assert.equal(logs[1].code, 'BOT_WORKER_COMMAND_ADMISSION_REFUSED');
    assert.equal(logs[1].sqliteCode, null);
    assert.deepEqual(await facts(), revised, 'a native stale checkpoint cannot rewrite the state');
    const captureFailure = Error('SECRET_CAPTURE_MESSAGE');
    await rejection(() => Database.saveBotLifeState(statement, new Proxy({}, {
        getOwnPropertyDescriptor() { throw captureFailure; }
    })),
        () => captureFailure);
    assert.equal(logs.length, 3);
    assert.equal(logs[2].phase, 'write_admission');
    const forged = Object.assign(Error('SECRET_FORGED_MESSAGE'), { code: 'BOT_WORKER_COMMAND_ADMISSION_REFUSED' });
    await rejection(() => Database.saveBotLifeState(statement, { beforeWrite() { throw forged; } }), () => forged);
    assert.equal(logs.length, 4);
    assert.equal(logs[3].admissionRefusalReason, null, 'a matching code on an ordinary Error is not native admission evidence');
    assert.equal(Database.stats().failures, baseFailures + 6, 'SQL and admission failures retain native accounting');
    assert.equal(Database.stats().operations['bot-life:save'].failures, 6);
    assert.equal(logs[1].admissionRefusalReason, 'stale_command');
    for (const log of logs) {
        assert.equal(log.operation, 'bot-life:save');
        assert.equal(log.configuredWriterBusyTimeoutMs, 5000);
        assert(log.frames.length > 0 && log.frames.length <= 8);
        assert(log.frames.every(frame => /^\s+at /.test(frame)));
    }
    assert(!JSON.stringify(logs).includes('SECRET_'), 'SQL, parameters and arbitrary error messages stay private');
    console.log('Native save diagnostics: SQL, stale admission, capture, throwing logger/getter and exact rejection PASS');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    console.warn = originalWarn; Checkpoint.check = originalCheck;
    await Database.close(); sqlite.DatabaseSync = NativeDatabase;
    clearTimeout(deadline); fs.rmSync(isolated.directory, { recursive: true, force: true });
});
