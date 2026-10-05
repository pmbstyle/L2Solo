'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { test } = require('node:test');

assert.equal(process.env.L2NODE_CONFIG_FILE, 'config/default.ini');
assert(!process.env.L2NODE_SHARED_CONFIG_FILE);
require('../src/Global');
const Database = invoke('Database');
const Store = invoke('HistoryStore');
const Restore = invoke('DatabaseRestore');
const Pvp = invoke('PvpJournal');
const SavedGames = require('../scripts/saved-games');
const { acquireDatabaseAccess } = require('../scripts/database-access');
utils.infoFail = (_prefix, message, detail) => { throw new Error(`${message}: ${detail}`); };
const root = path.resolve(__dirname, '../tmp/database-fixes/fixtures');
fs.mkdirSync(root, { recursive: true });

function digest(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function pair({ worldPath, historyPath }) {
    const world = new DatabaseSync(worldPath, { readOnly: true });
    const history = new DatabaseSync(historyPath, { readOnly: true });
    try {
        return { adena: world.prepare('SELECT amount FROM items WHERE selfId=57').get().amount,
            sequence: world.prepare("SELECT MAX(seq) AS n FROM sqlite_sequence WHERE name='history_outbox'").get().n,
            outbox: world.prepare('SELECT id,kind,payload FROM history_outbox ORDER BY id').all().map((row) => ({ ...row })),
            cursor: Store.cursor(history), token: Store.meta(history, Store.WORLD_TOKEN_KEY),
            trades: history.prepare('SELECT eventKey FROM market_trades ORDER BY id').all().map((row) => row.eventKey) };
    } finally { history.close(); world.close(); }
}

function append(world, history, key) {
    world.prepare('INSERT INTO history_outbox(kind,payload) VALUES (?,?)').run('market_trade', JSON.stringify({
        eventKey: key, occurredAt: Date.now(), channel: 'wts', sourceType: 'fixture', selfId: 1001,
        itemName: 'Item', quantity: 1, unitPrice: 10, totalPrice: 10
    }));
    Store.transfer(history, world);
    world.exec('DELETE FROM history_outbox');
}

async function fixture(run) {
    const directory = fs.mkdtempSync(path.join(root, 'protocol-'));
    const worldPath = path.join(directory, 'world.sqlite');
    // Exercise a configured history file in a different directory as well.
    const historyPath = path.join(directory, 'archive', 'custom-history.sqlite');
    options.default.Database.path = worldPath;
    options.default.Database.historyPath = historyPath;
    try {
        Database.init();
        await Database.close();
        let world = new DatabaseSync(worldPath);
        let history = Store.open(historyPath);
        world.exec(`INSERT INTO accounts VALUES ('fixture', 'pw');
            INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (1,'fixture','Owner',0,0,100,100,0,0,0,0,0,0,0);
            INSERT INTO items(selfId,name,amount,characterId) VALUES (57,'Adena',100,1);`);
        append(world, history, 'old');
        history.close(); world.close();
        const args = { databasePath: worldPath, historyPath, savesDir: path.join(directory, 'saves') };
        const old = await SavedGames.run({ ...args, operation: 'create', name: 'Old pair' });
        world = new DatabaseSync(worldPath);
        history = Store.open(historyPath);
        world.exec('UPDATE items SET amount=200 WHERE selfId=57');
        append(world, history, 'new');
        history.close(); world.close();
        const newer = await SavedGames.run({ ...args, operation: 'create', name: 'New pair' });
        await SavedGames.run({ ...args, operation: 'load', id: old.id });
        const context = { directory, worldPath, historyPath, args, old, newer };
        await run(context);
    } finally {
        await Database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function faultWorker(context, fault, recoveryOnly = false) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const fs = require('node:fs');
            const { workerData: data, parentPort } = require('node:worker_threads');
            const rename = fs.renameSync;
            const copy = fs.copyFileSync;
            fs.copyFileSync = (source, target, flags) => {
                if (data.fault === 'backup-fail' && source === data.historyPath && target.endsWith('.rollback')) {
                    throw new Error('fixture:backup-copy');
                }
                return copy(source, target, flags);
            };
            fs.renameSync = (source, target) => {
                if (data.fault === 'rollback-fail' && target === data.databasePath + '.restore.json'
                    && JSON.parse(fs.readFileSync(source, 'utf8')).phase === 'committed') {
                    throw new Error('fixture:commit-marker');
                }
                if (data.fault === 'rollback-fail' && target === data.historyPath && source.endsWith('.recovering')) {
                    throw new Error('fixture:rollback-history');
                }
                const result = rename(source, target);
                if (data.fault === 'after-world' && target === data.databasePath && source.endsWith('.loading')) process.exit(91);
                if (data.fault === 'during-rollback' && target === data.databasePath && source.endsWith('.recovering')) process.exit(92);
                if (data.fault === 'after-commit' && target === data.databasePath + '.restore.json'
                    && JSON.parse(fs.readFileSync(target, 'utf8')).phase === 'committed') process.exit(93);
                return result;
            };
            if (data.recoveryOnly) {
                const release = require(data.accessModule).acquireDatabaseAccess(data.databasePath);
                try {
                    require(data.restoreModule).recover(data.databasePath, data.historyPath);
                    parentPort.postMessage({ value: true });
                } catch (error) { parentPort.postMessage({ error: error.message }); }
                finally { release(); }
            } else require(data.savedModule);
        `, { eval: true, workerData: { ...context.args, operation: 'load', id: context.newer.id, fault, recoveryOnly,
            savedModule: require.resolve('../scripts/saved-games'), restoreModule: require.resolve('../src/DatabaseRestore'),
            accessModule: require.resolve('../scripts/database-access') } });
        let message;
        worker.on('message', (value) => { message = value; });
        worker.once('error', reject);
        worker.once('exit', (code) => resolve({ code, message }));
    });
}

async function startup(context) {
    // The runtime acquires this same lock in NodeL2 before Database.init.
    const release = acquireDatabaseAccess(context.worldPath);
    try { Database.init(); await Database.flushHistory(); await Database.close(); }
    finally { release(); }
}

function recoverySources(context) {
    const marker = JSON.parse(fs.readFileSync(Restore.markerPath(context.worldPath), 'utf8'));
    return Object.fromEntries([Restore.markerPath(context.worldPath),
        Restore.files(context.worldPath, marker.id).previous,
        Restore.files(context.historyPath, marker.id).previous].map((file) => [file, digest(file)]));
}

function oldMetadata(context, save) {
    const file = path.join(context.args.savesDir, save.id, 'save.json');
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ name: metadata.name, createdAt: metadata.createdAt }));
}

test('process exit after the world replacement rolls back before startup and repeated startup is stable', async () => {
    await fixture(async (context) => {
        const before = pair(context);
        const sources = Object.fromEntries(['database.sqlite', 'history.sqlite', 'save.json'].map((name) => {
            const file = path.join(context.args.savesDir, context.newer.id, name);
            return [file, digest(file)];
        }));
        assert.equal((await faultWorker(context, 'after-world')).code, 91);
        assert.equal(pair(context).adena, 200);
        assert.equal(JSON.parse(fs.readFileSync(Restore.markerPath(context.worldPath))).phase, 'installing');
        await startup(context);
        assert.deepEqual(pair(context), before);
        assert(!fs.existsSync(Restore.markerPath(context.worldPath)));
        assert(!fs.existsSync(`${context.historyPath}.orphan`));
        await startup(context);
        assert.deepEqual(pair(context), before);
        for (const [file, hash] of Object.entries(sources)) assert.equal(digest(file), hash);
    });
});

test('failed and interrupted rollback retain both sources and recover on the next startup', async () => {
    await fixture(async (context) => {
        const before = pair(context);
        const failed = await faultWorker(context, 'rollback-fail');
        assert.match(failed.message.error, /rollback needs recovery.*fixture:rollback-history/);
        assert.equal(pair(context).adena, 100);
        assert.deepEqual(pair(context).trades, ['old', 'new']);
        const sources = recoverySources(context);
        assert.equal((await faultWorker(context, 'during-rollback', true)).code, 92);
        assert.deepEqual(recoverySources(context), sources);
        await startup(context);
        assert.deepEqual(pair(context), before);
        await startup(context);
        assert.deepEqual(pair(context), before);
    });
});

test('preflight rejection leaves an existing recovery operation and current files untouched', async () => {
    await fixture(async (context) => {
        await faultWorker(context, 'rollback-fail');
        const sources = recoverySources(context);
        const before = pair(context);
        const currentHashes = [digest(context.worldPath), digest(context.historyPath)];
        fs.rmSync(path.join(context.args.savesDir, context.old.id, 'history.sqlite'));
        await assert.rejects(SavedGames.run({ ...context.args, operation: 'load', id: context.old.id }), /history.*missing/);
        assert.deepEqual(pair(context), before);
        assert.deepEqual([digest(context.worldPath), digest(context.historyPath)], currentHashes);
        assert.deepEqual(recoverySources(context), sources);
        await startup(context);
        assert.deepEqual(pair(context).trades, ['old']);
    });
});

test('a committed marker surviving process exit keeps the complete new pair', async () => {
    await fixture(async (context) => {
        assert.equal((await faultWorker(context, 'after-commit')).code, 93);
        assert.equal(JSON.parse(fs.readFileSync(Restore.markerPath(context.worldPath))).phase, 'committed');
        await startup(context);
        assert.equal(pair(context).adena, 200);
        assert.deepEqual(pair(context).trades, ['old', 'new']);
        assert.equal(pair(context).cursor, 2);
        assert(!fs.existsSync(Restore.markerPath(context.worldPath)));
    });
});

test('backup creation failure preserves the old pair and a missing rollback source refuses startup', async () => {
    await fixture(async (context) => {
        const before = pair(context);
        assert.match((await faultWorker(context, 'backup-fail')).message.error, /fixture:backup-copy/);
        assert.deepEqual(pair(context), before);
        assert(!fs.existsSync(Restore.markerPath(context.worldPath)));
        await faultWorker(context, 'after-world');
        const marker = JSON.parse(fs.readFileSync(Restore.markerPath(context.worldPath)));
        fs.rmSync(Restore.files(context.worldPath, marker.id).previous);
        const mixed = pair(context);
        const release = acquireDatabaseAccess(context.worldPath);
        const exitCode = process.exitCode;
        try {
            assert.throws(() => Database.init(), /SQLite initialization failed/);
            assert.equal(Database.isReady(), false);
        } finally { process.exitCode = exitCode; release(); }
        assert.deepEqual(pair(context), mixed);
        assert(fs.existsSync(Restore.markerPath(context.worldPath)));
    });
});

test('an interrupted load without previous files rolls back to absence and a later load succeeds', async () => {
    await fixture(async (context) => {
        for (const file of [context.worldPath, context.historyPath]) {
            for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true });
        }
        assert.equal((await faultWorker(context, 'after-world')).code, 91);
        const marker = JSON.parse(fs.readFileSync(Restore.markerPath(context.worldPath)));
        assert.equal(marker.hadWorld, false);
        assert.equal(marker.hadHistory, false);
        const release = acquireDatabaseAccess(context.worldPath);
        try {
            assert.equal(Restore.recover(context.worldPath, context.historyPath), true);
            assert.equal(Restore.recover(context.worldPath, context.historyPath), false);
        } finally { release(); }
        assert(!fs.existsSync(context.worldPath));
        assert(!fs.existsSync(context.historyPath));
        await SavedGames.run({ ...context.args, operation: 'load', id: context.newer.id });
        await startup(context);
        assert.equal(pair(context).adena, 200);
        assert.deepEqual(pair(context).trades, ['old', 'new']);
    });
});

test('a missing current history with an orphaned journal cannot contaminate a replacement', async () => {
    await fixture(async (context) => {
        fs.rmSync(context.historyPath);
        fs.writeFileSync(`${context.historyPath}-wal`, 'fixture:orphaned-history-wal');
        const worldHash = digest(context.worldPath);
        await assert.rejects(SavedGames.run({ ...context.args, operation: 'load', id: context.newer.id }), /missing.*journal/);
        assert.equal(digest(context.worldPath), worldHash);
        assert(!fs.existsSync(context.historyPath));
        assert.equal(fs.readFileSync(`${context.historyPath}-wal`, 'utf8'), 'fixture:orphaned-history-wal');
        assert(!fs.existsSync(Restore.markerPath(context.worldPath)));
    });
});

test('same-token stale history is rejected for new manifests and earlier metadata without changing source or current pair', async () => {
    await fixture(async (context) => {
        const before = pair(context);
        const savedWorld = path.join(context.args.savesDir, context.newer.id, 'database.sqlite');
        const savedHistory = path.join(context.args.savesDir, context.newer.id, 'history.sqlite');
        fs.copyFileSync(path.join(context.args.savesDir, context.old.id, 'history.sqlite'), savedHistory);
        const sources = [digest(savedWorld), digest(savedHistory)];
        await assert.rejects(SavedGames.run({ ...context.args, operation: 'load', id: context.newer.id }), /checksum/);
        oldMetadata(context, context.newer);
        await assert.rejects(SavedGames.run({ ...context.args, operation: 'load', id: context.newer.id }), /incomplete.*outbox/);
        assert.deepEqual(pair(context), before);
        assert.deepEqual([digest(savedWorld), digest(savedHistory)], sources);
        assert(!fs.existsSync(Restore.markerPath(context.worldPath)));
    });
});

test('earlier metadata cannot omit migrated history and create cannot publish a damaged modern pair', async () => {
    await fixture(async (context) => {
        oldMetadata(context, context.newer);
        fs.rmSync(path.join(context.args.savesDir, context.newer.id, 'history.sqlite'));
        const before = pair(context);
        const currentHashes = [digest(context.worldPath), digest(context.historyPath)];
        await assert.rejects(SavedGames.run({ ...context.args, operation: 'load', id: context.newer.id }), /migrated.*history/);
        assert.deepEqual(pair(context), before);
        assert.deepEqual([digest(context.worldPath), digest(context.historyPath)], currentHashes);
        fs.rmSync(context.historyPath);
        const saves = fs.readdirSync(context.args.savesDir);
        await assert.rejects(SavedGames.run({ ...context.args, operation: 'create' }), /migrated.*history/);
        assert.deepEqual(fs.readdirSync(context.args.savesDir), saves);
        assert.equal(digest(context.worldPath), currentHashes[0]);
        assert(!fs.existsSync(context.historyPath));
    });
});

test('earlier metadata validates tokens and cursors and accepts a complete replay backlog', async () => {
    await fixture(async (context) => {
        oldMetadata(context, context.newer);
        const savedHistory = path.join(context.args.savesDir, context.newer.id, 'history.sqlite');
        let history = Store.open(savedHistory);
        const token = Store.meta(history, Store.WORLD_TOKEN_KEY);
        Store.setMeta(history, Store.WORLD_TOKEN_KEY, 'other-world');
        history.close();
        const before = pair(context);
        await assert.rejects(SavedGames.run({ ...context.args, operation: 'load', id: context.newer.id }), /another world/);
        history = Store.open(savedHistory);
        Store.setMeta(history, Store.WORLD_TOKEN_KEY, token);
        history.exec('DROP TABLE clan_actions');
        history.close();
        await assert.rejects(SavedGames.run({ ...context.args, operation: 'load', id: context.newer.id }), /schema.*incomplete/);
        history = Store.open(savedHistory);
        Store.setMeta(history, Store.CURSOR_KEY, 3);
        history.close();
        await assert.rejects(SavedGames.run({ ...context.args, operation: 'load', id: context.newer.id }), /cursor.*ahead/);
        assert.deepEqual(pair(context), before);
        history = Store.open(savedHistory);
        Store.setMeta(history, Store.CURSOR_KEY, 2);
        history.close();
        const world = new DatabaseSync(path.join(context.args.savesDir, context.newer.id, 'database.sqlite'));
        world.prepare('INSERT INTO history_outbox(kind,payload) VALUES (?,?)').run('journal', JSON.stringify({ rows: [
            { hour: Math.floor(Date.now() / Store.HOUR_MS), operation: 'fixture:backlog', store: 'inventory', selfId: 57, delta: 7, events: 1 }
        ], conflicts: [] }));
        world.close();
        await SavedGames.run({ ...context.args, operation: 'load', id: context.newer.id });
        assert.equal(pair(context).outbox.length, 1);
        await startup(context);
        Database.init();
        assert.equal((await Database.readHistory(["SELECT delta FROM economy_flow_hour WHERE operation='fixture:backlog'"]))[0].delta, 7);
        assert.equal(await Database.flushJournals(), 0);
    });
});

test('the initial migration allocation gap accepts imported history and replays its first backlog once', async () => {
    await fixture(async (context) => {
        const world = new DatabaseSync(context.worldPath);
        let history = Store.open(context.historyPath);
        history.exec('DELETE FROM market_trades');
        Store.setMeta(history, Store.CURSOR_KEY, 0);
        history.close();
        world.exec("DELETE FROM sqlite_sequence WHERE name='history_outbox'");
        world.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/history.sql'), 'utf8'));
        const at = Date.now();
        world.prepare(`INSERT INTO afk_trade_events(id,ownerId,kind,selfId,amount,unitPrice,totalPrice,createdAt)
            VALUES (40,1,'sale',1001,1,10,10,?)`).run(at);
        world.prepare("INSERT INTO clan_goal_events(id,clanId,eventType,occurredAt) VALUES (80,1,'goal_updated',?)").run(at);
        Store.moveWorldTables(world, context.historyPath);
        const inserted = world.prepare('INSERT INTO history_outbox(kind,payload) VALUES (?,?)').run('journal', JSON.stringify({
            rows: [{ hour: Math.floor(at / Store.HOUR_MS), operation: 'fixture:after-import', store: 'inventory', selfId: 57, delta: 5, events: 1 }],
            conflicts: []
        }));
        assert.equal(Number(inserted.lastInsertRowid), 81);
        world.close();
        history = Store.open(context.historyPath);
        assert.equal(Store.cursor(history), 0);
        history.close();
        const save = await SavedGames.run({ ...context.args, operation: 'create', name: 'Immediately after import' });
        oldMetadata(context, save);
        await SavedGames.run({ ...context.args, operation: 'load', id: save.id });
        await startup(context);
        await startup(context);
        history = Store.open(context.historyPath);
        try {
            assert.equal(Store.cursor(history), 81);
            assert.deepEqual({ ...history.prepare("SELECT delta,events FROM economy_flow_hour WHERE operation='fixture:after-import'").get() },
                { delta: 5, events: 1 });
            assert.equal(history.prepare('SELECT COUNT(*) AS n FROM afk_trade_events WHERE id=40').get().n, 1);
            assert.equal(history.prepare('SELECT COUNT(*) AS n FROM clan_goal_events WHERE id=80').get().n, 1);
        } finally { history.close(); }
    });
});

for (const failure of ['after-insert', 'commit']) {
    test(`journal ${failure} failure keeps the batch and later changes for one successful retry`, async () => {
        await fixture(async () => {
            Database.init();
            const conflict = (key) => Pvp.coldConflict({ key, partyIds: [null, null], sideSizes: [1, 1],
                outcome: 'won', fought: true, principals: [{ characterId: 1 }, { characterId: 2 }], at: Date.now() });
            await Database.execute(['UPDATE items SET amount=amount+7 WHERE selfId=57'], 'fixture:journal');
            conflict('first');
            if (failure === 'after-insert') {
                await Database.execute([`CREATE TRIGGER fixture_fail_journal AFTER INSERT ON history_outbox
                    WHEN NEW.kind='journal' BEGIN SELECT RAISE(FAIL,'fixture:after-insert'); END`]);
                await assert.rejects(Database.flushJournals(), /fixture:after-insert/);
                await Database.execute(['DROP TRIGGER fixture_fail_journal']);
            } else {
                const exec = DatabaseSync.prototype.exec;
                let failed = false;
                DatabaseSync.prototype.exec = function (sql) {
                    if (sql === 'COMMIT' && !failed) { failed = true; throw new Error('fixture:journal-commit'); }
                    return exec.call(this, sql);
                };
                try { await assert.rejects(Database.flushJournals(), /fixture:journal-commit/); }
                finally { DatabaseSync.prototype.exec = exec; }
            }
            assert.equal((await Database.execute(['SELECT COUNT(*) AS n FROM history_outbox']))[0].n, 0);
            await Database.execute(['UPDATE items SET amount=amount+9 WHERE selfId=57'], 'fixture:journal');
            conflict('second');
            assert.equal(await Database.flushJournals(), 3);
            assert.deepEqual((await Database.readHistory(["SELECT delta,events FROM economy_flow_hour WHERE operation='fixture:journal'"]))
                .map((row) => [row.delta, row.events]), [[16, 2]]);
            assert.deepEqual((await Database.readHistory(['SELECT conflictKey FROM pvp_conflicts ORDER BY id'])).map((row) => row.conflictKey), ['first', 'second']);
            assert.equal(await Database.flushJournals(), 0);
            await Database.close();
            Database.init();
            assert.equal((await Database.readHistory(["SELECT delta FROM economy_flow_hour WHERE operation='fixture:journal'"]))[0].delta, 16);
        });
    });
}
