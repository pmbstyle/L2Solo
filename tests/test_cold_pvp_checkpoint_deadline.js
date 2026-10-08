'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(root, 'tests/helpers/databaseIsolation'));
const isolated = require(path.join(root, 'tests/helpers/isolatedSocialDatabase'))('pvp-checkpoint-deadline', root);
fs.writeFileSync(isolated.ini, fs.readFileSync(isolated.ini, 'utf8')
    .replace(/^knowledgeErrorsEnabled\s*=\s*true$/m, 'knowledgeErrorsEnabled = false'));
const sqlite = require('node:sqlite');
const NativeDatabase = sqlite.DatabaseSync;
const opened = [];
sqlite.DatabaseSync = class OwnDatabase extends NativeDatabase {
    constructor(filename, options = {}) {
        assert([isolated.world, isolated.history].includes(path.resolve(String(filename))), 'only exact own UUID paths');
        super(filename, options);
        opened.push({ filename: String(filename), readOnly: options.readOnly === true });
    }
};
const { DatabaseSync } = sqlite;
require(path.join(root, 'src/Global'));
isolated.assertConfigured(options.default);
const Database = invoke('Database');
const History = invoke('HistoryDatabase');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Progression = invoke('GameServer/Bot/BotClassProgression');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Pvp = invoke('GameServer/Bot/Population/ColdPvpResolver');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const Checkpoint = invoke('GameServer/Bot/Population/NativeWriteCheckpoint');
const { WorkerCommandAdmissionRefusal } = invoke('GameServer/Bot/Population/WorkerCommandAdmission');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const timestamp = 1791396041926;
const tables = ['characters', 'bot_life_state', 'skills', 'items', 'warehouse_items',
    'afk_trade_shops', 'afk_trade_lines', 'character_death_experience'];
const copy = value => JSON.parse(JSON.stringify(value));
const outcomes = [];
const observations = [];
let serial = 0, rowSql, deadId, producedDead, expectedDuration, published = 0;

function image(id) {
    const connection = new DatabaseSync(isolated.world, { readOnly: true });
    try {
        return { tables: Object.fromEntries(tables.map(table => [table,
            copy(connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())])), cache: copy(Life.cachedState(id)) };
    } finally {
        connection.close();
    }
}

async function seed() {
    const account = `bot_pvp_deadline_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `PvpDeadline${serial}`, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 500,
        locX: 50000, locY: 15000, locZ: -5000 })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, equipped: false, enchant: 0, slot: 0 });
    await Database.setItem(id, { selfId: 1869, name: 'Stem', amount: 2, equipped: false, enchant: 0, slot: 0 });
    const original = Database.saveBotLifeState;
    Database.saveBotLifeState = function (statement, writeOptions) {
        rowSql = statement[0];
        return original.call(this, statement, writeOptions);
    };
    try {
        assert(await Life.upsertState({ characterId: id, accountName: account, name: `PvpDeadline${serial}`,
            phase: 'cold', activity: 'hunting', level: 1, exp: 0, sp: 0, adena: 1000,
            loc: { locX: 50000, locY: 15000, locZ: -5000 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
            timing: { activityStartedAt: timestamp - 1000, lastResolvedAt: timestamp - 1000,
                nextResolveAt: timestamp + 30000, lastHotAt: 0 }, stats: { classId: 0 } }, 'deadline_seed'));
    } finally {
        Database.saveBotLifeState = original;
    }
    // Prepare only the genuinely authored free level1 prefix; no earned SP,
    // books, class reset, equipment grant or synthetic skill rows.
    const source = Life.cachedState(id);
    const beforeWrite = Database.createColdTrainingGuard(source, () => assert.equal(Life.cachedState(id), source));
    const training = await Progression.reconcile({ characterId: id, classId: 0, level: 1, seed: id }, { beforeWrite });
    assert.equal(training.spentSp, 0);
    assert.deepEqual(training.consumedBooks, []);
    assert.deepEqual(training.transitions, []);
    Life.acceptNewerLifecycleRow(await Database.publishColdTraining(id, training, { beforeWrite }));
    return id;
}

function authority(id) {
    const input = Protocol.commandCheckpoint(Life.cachedState(id));
    assert(input);
    return Checkpoint.create(id, { workerAdmission: Object.freeze({ characterId: id, commandId: `deadline-direct:${serial}`,
        commandCheckpoint: Object.freeze({ ...input }), check: () => null }) });
}

function statement(id, callback) {
    const current = image(id).tables.bot_life_state.find(row => row.characterId === id);
    const fields = ['characterId', 'accountName', 'characterName', 'level', 'exp', 'sp', 'adena', 'homeRegion', 'currentRegion',
        'spotId', 'activity', 'phase', 'activityStartedAt', 'nextResolveAt', 'lastResolvedAt', 'lastHotAt',
        'locX', 'locY', 'locZ', 'hp', 'maxHp', 'mp', 'maxMp', 'targetLevelBand', 'deathCount', 'partyId',
        'inventorySummary', 'statsJson', 'updatedAt'];
    const actualHeader = rowSql.match(/INSERT INTO bot_life_state\s*\(([^)]+)\)/)[1].split(',').map(value => value.trim());
    assert.deepEqual(actualHeader, fields, 'fixture matches the genuine Life-authored 29-column ROW');
    const value = [rowSql, fields.map(field => current[field])];
    value[1][19] = current.hp - 1;
    value[1][28] = current.updatedAt + 1;
    Checkpoint.bindRow(callback, value, id);
    return value;
}

const refused = error => error instanceof WorkerCommandAdmissionRefusal
    && error.code === 'BOT_WORKER_COMMAND_ADMISSION_REFUSED' && error.message === 'stale_command';

async function check(name, work) {
    try {
        await work();
        outcomes.push({ name, status: 'PASS' });
        console.log('PASS', name);
    } catch (error) {
        outcomes.push({ name, status: 'FAIL', error: error.stack });
        console.error('FAIL', name, error.stack);
    }
}

async function main() {
    Database.init();
    assert(Database.isReady());
    Data.init();
    await Life.init();
    const killerId = await seed();
    deadId = await seed();
    const duelist = (id, hp, attack) => {
        const input = copy(Life.cachedState(id));
        input.vitals = { hp, maxHp: 1000, mp: 500, maxMp: 500 };
        input.stats.coldCombat = { version: 1, classId: 0, cp: 0, cpAt: timestamp,
            base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
            equipment: { weaponKind: 'Weapon.Sword', pAtk: attack, pAtkRnd: 0, mAtk: 100, atkSpd: 379,
                critical: 0, accur: 0, pDef: 200, mDef: 100, evasion: 0 }, effects: [], skills: [] };
        input.stats.coldPvp = { readyAt: timestamp + (id === killerId ? 0 : 500) };
        return input;
    };
    const killer = duelist(killerId, 1000, 50000), victim = duelist(deadId, 1, 1);
    const sides = [{ principal: killer, members: [killer] }, { principal: victim, members: [victim] }];
    const beforeFight = copy(sides);
    const profile = Profile.profileFor(killer, timestamp);
    const actionDelay = Math.max(250, 470000 / profile.atkSpd);
    expectedDuration = Math.min(Pvp.MAX_DURATION_MS, Math.max(1000, actionDelay));
    assert(!Number.isInteger(expectedDuration), 'native physical attack speed produces fractional milliseconds');
    const fight = Pvp.resolve({ sides, roles: new Map(), timestamp, rng: () => 0.5,
        personaFor: () => ({ traits: { caution: 0 } }), openingSide: 0,
        step: { resuming: true, until: timestamp + 1000, expiresAt: timestamp + 30000, maxActions: 1 } });
    assert(fight.started && fight.outcome === 'killed');
    assert.equal(fight.actions, 1);
    assert.equal(fight.durationMs, expectedDuration, 'rounding a persisted deadline must not change combat duration');
    assert.deepEqual(sides, beforeFight, 'native producer never mutates its inputs');
    producedDead = fight.updates.get(deadId);
    assert.equal(producedDead.vitals.hp, 0);
    assert.equal(producedDead.exp, 0);
    assert.equal(producedDead.sp, 0);
    observations.push({ kind: 'native_pvp', expectedDuration, actualDuration: fight.durationMs,
        restUntil: producedDead.stats.restUntil, recoverUntil: producedDead.stats.coldPvp.recoverUntil,
        rawDeadline: timestamp + expectedDuration + Pvp.FLAG_MS + Pvp.RECOVERY_MS });
    await check('native fractional fight stores a non-early integer recovery deadline', async () => {
        assert.equal(producedDead.stats.coldPvp.recoverUntil,
            Math.ceil(timestamp + expectedDuration + Pvp.FLAG_MS) + Pvp.RECOVERY_MS);
        assert(Number.isSafeInteger(producedDead.stats.coldPvp.recoverUntil));
        assert(producedDead.stats.coldPvp.recoverUntil >= timestamp + expectedDuration + Pvp.FLAG_MS + Pvp.RECOVERY_MS);
        assert(producedDead.stats.coldPvp.recoverUntil - (timestamp + expectedDuration + Pvp.FLAG_MS + Pvp.RECOVERY_MS) < 1);
    });
    assert(await Life.upsertState(producedDead, 'native_pvp_death'));
    const input = Life.cachedState(deadId), before = image(deadId);
    assert(Protocol.commandCheckpoint(input), 'current incoming native ROW is a typed integer checkpoint');
    const recovery = Resolver.resolveDeathRecovery(input, timestamp + 1280);
    assert.equal(recovery.nextResolveAt, producedDead.stats.coldPvp.recoverUntil);
    await check('actual Coordinator admission and Life ROW accept the native PvP recovery', async () => {
        const coordinator = new ColdSimulationCoordinator();
        const token = Promise.resolve();
        const identity = { characterId: deadId, commandId: 'deadline-current', commandCheckpoint: Protocol.commandCheckpoint(input) };
        coordinator.commandInflight.set(deadId, token);
        coordinator.population = { executeWorkerLifecycleCommand(state, request, { workerAdmission }) {
            return Life.prepareResolve(state, request.precomputedResult,
                { workerAdmission, timestamp: timestamp + 1280, persist: true }).then(state => ({ ok: true, state }));
        } };
        // This regression ends at FINAL publication. The independent Main
        // postcommit economy review is deliberately outside its boundary.
        coordinator.reviewCommittedEconomy = async state => state;
        const unsubscribe = Life.subscribeChanges((state, reason) => {
            if (state.characterId === deadId && ['resolve', 'death'].includes(reason)) published++;
        });
        let result, error;
        try {
            result = await coordinator.executeLifecycleCommand({ ...identity, precomputedResult: recovery }, identity, () => true);
        } catch (caught) {
            error = caught;
        } finally {
            unsubscribe();
            coordinator.commandInflight.delete(deadId);
        }
        const after = image(deadId);
        observations.push({ kind: 'coordinator_pvp_recovery', before, after, result: copy(result || null),
            error: error ? { name: error.name, message: error.message, code: error.code } : null, published });
        if (error) throw error;
        assert.equal(result.ok, true);
        assert.equal(published, 1);
        assert.equal(after.cache.activity, 'dead');
        assert.equal(after.cache.timing.nextResolveAt, producedDead.stats.coldPvp.recoverUntil);
        assert(Protocol.commandCheckpoint(after.cache));
        const native = after.tables.bot_life_state.find(row => row.characterId === deadId);
        assert.equal(native.nextResolveAt, producedDead.stats.coldPvp.recoverUntil);
        assert.equal(native.lastResolvedAt, timestamp + 1280);
        assert.equal(native.simulationRevision, before.tables.bot_life_state.find(row => row.characterId === deadId).simulationRevision);
        for (const table of tables.filter(value => value !== 'bot_life_state')) {
            assert.deepEqual(after.tables[table], before.tables[table], 'zero-award death wait conserves every physical SQL fact');
        }
    });

    const malformed = [[12, 1.5], [13, timestamp + 0.25], [14, NaN], [15, -1], [28, Infinity],
        [28, null], [13, '1791396148192'], [11, 'hot'], [10, '']];
    for (const [index, value] of malformed) {
        await check(`malformed outgoing ROW scalar ${index}:${String(value)} refuses before SQL`, async () => {
            const id = await seed(), callback = authority(id), proposed = statement(id, callback), before = image(id);
            proposed[1][index] = value;
            await assert.rejects(async () => Database.saveBotLifeState(proposed, { beforeWrite: callback }), refused);
            const after = image(id);
            observations.push({ kind: 'outgoing_negative', index, value: String(value), before, after });
            assert.deepEqual(after, before);
            assert.equal((await Database.updateCharacterVitals(id, 999, 1000, 500, 500, { beforeWrite: callback })).affectedRows, 1,
                'a refused proposal never advances the original private session');
        });
    }
    await check('outgoing ROW changed after native capture refuses before queued SQL', async () => {
        const id = await seed(), callback = authority(id), proposed = statement(id, callback), before = image(id);
        const pending = Database.saveBotLifeState(proposed, { beforeWrite: callback });
        pending.catch(() => {});
        // captureRow has already copied the current capability. The real DAO
        // runs on queryTail's next microtask and must recheck this live ROW.
        proposed[1][13] += 0.25;
        await assert.rejects(pending, refused);
        const after = image(id);
        observations.push({ kind: 'queued_outgoing_negative', before, after });
        assert.deepEqual(after, before);
    });
    await check('valid outgoing native ROW advances the same private writer family', async () => {
        const id = await seed(), callback = authority(id), proposed = statement(id, callback), before = image(id);
        proposed[1][12] = null;
        proposed[1][15] = null;
        const result = await Database.saveBotLifeState(proposed, { beforeWrite: callback });
        assert.equal(result.affectedRows, 1);
        const after = image(id), native = after.tables.bot_life_state.find(row => row.characterId === id);
        assert.equal(native.hp, before.cache.vitals.hp - 1);
        assert.equal(native.activityStartedAt, null);
        assert.equal(native.lastHotAt, null);
        assert.deepEqual(after.cache, before.cache, 'private ROW advance itself never publishes Main cache');
        assert.equal((await Database.updateCharacterVitals(id, 999, 1000, 500, 500, { beforeWrite: callback })).affectedRows, 1);
        observations.push({ kind: 'valid_row_private_advance', before, after: image(id) });
    });
    await check('stale incoming native authority refuses without writes', async () => {
        const id = await seed(), callback = authority(id), proposed = statement(id, callback);
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [id]]);
        const before = image(id);
        await assert.rejects(Database.saveBotLifeState(proposed, { beforeWrite: callback }), refused);
        assert.deepEqual(image(id), before);
    });
    await check('malformed incoming checkpoint refuses before writer creation', async () => {
        const id = await seed(), before = image(id), checkpoint = Protocol.commandCheckpoint(before.cache);
        checkpoint.nextResolveAt += 0.25;
        assert.throws(() => Checkpoint.create(id, { workerAdmission: { characterId: id, commandId: 'bad-incoming',
            commandCheckpoint: checkpoint, check: () => null } }), error => error instanceof WorkerCommandAdmissionRefusal);
        assert.deepEqual(image(id), before);
    });
    const report = { scope: 'functional native producer/Coordinator/Life/SQLite checkpoint only',
        runtime: false, World: false, Inspector: false, timing: false, outcomes, observations, opened };
    if (process.env.N53_EVIDENCE_FILE) fs.writeFileSync(process.env.N53_EVIDENCE_FILE, JSON.stringify(report, null, 2) + '\n');
    console.log('RESULTS', JSON.stringify({ count: outcomes.length, pass: outcomes.filter(row => row.status === 'PASS').length,
        fail: outcomes.filter(row => row.status === 'FAIL').length }));
    assert(outcomes.every(row => row.status === 'PASS'), 'all checkpoint deadline controls must pass');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    const historyBeforeClose = History.stats();
    await Database.close();
    const historyAfterClose = History.stats();
    assert.equal(historyAfterClose.running, false);
    assert.equal(historyAfterClose.path, null);
    sqlite.DatabaseSync = NativeDatabase;
    fs.rmSync(isolated.directory, { recursive: true, force: true });
    console.log('CLEANUP', JSON.stringify({ directory: isolated.directory, exists: fs.existsSync(isolated.directory),
        historyBeforeClose, historyAfterClose,
        resourceUsage: 'native HistoryWorker joined by Database.close; no ColdSimulationWorker/World/Inspector launched' }));
});
