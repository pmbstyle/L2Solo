'use strict';

// Recovery contracts reproduced as failures on the original split-DB base.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

assert.equal(process.env.L2NODE_CONFIG_FILE, 'config/default.ini');
assert(!process.env.L2NODE_SHARED_CONFIG_FILE);
require('../src/Global');
const Database = invoke('Database');
const Store = invoke('HistoryStore');
const PvpJournal = invoke('PvpJournal');
const SavedGames = require('../scripts/saved-games');
utils.infoFail = (_prefix, message, detail) => { throw new Error(`${message}: ${detail}`); };
const root = path.resolve(__dirname, '../tmp/database-audit/fixtures');
fs.mkdirSync(root, { recursive: true });

function append(world, history, eventKey) {
    world.prepare('INSERT INTO history_outbox(kind, payload) VALUES (?, ?)').run('market_trade', JSON.stringify({
        eventKey, occurredAt: Date.now(), channel: 'wts', sourceType: 'fixture', selfId: 1001,
        itemName: 'Item', quantity: 1, unitPrice: 10, totalPrice: 10
    }));
    Store.transfer(history, world);
    world.exec('DELETE FROM history_outbox');
}

function pair(worldPath, historyPath) {
    const world = new DatabaseSync(worldPath, { readOnly: true });
    const history = fs.existsSync(historyPath) ? new DatabaseSync(historyPath, { readOnly: true }) : null;
    try {
        return {
            adena: world.prepare('SELECT amount FROM items WHERE selfId=57').get().amount,
            token: world.prepare("SELECT value FROM world_meta WHERE key='historyToken'").get().value,
            sequence: world.prepare("SELECT seq FROM sqlite_sequence WHERE name='history_outbox'").get().seq,
            outbox: world.prepare('SELECT COUNT(*) AS n FROM history_outbox').get().n,
            cursor: history ? Store.cursor(history) : null,
            owner: history ? Store.meta(history, Store.WORLD_TOKEN_KEY) : null,
            trades: history ? history.prepare('SELECT eventKey FROM market_trades ORDER BY id').all().map((r) => r.eventKey) : null
        };
    } finally { history?.close(); world.close(); }
}

async function fixture(run) {
    const directory = fs.mkdtempSync(path.join(root, 'save-contract-'));
    const worldPath = path.join(directory, 'world.sqlite');
    const historyPath = Store.pathFor(worldPath);
    options.default.Database.path = worldPath;
    options.default.Database.historyPath = historyPath;
    try {
        Database.init();
        await Database.close();
        let world = new DatabaseSync(worldPath);
        let history = Store.open(historyPath);
        world.exec(`INSERT INTO accounts VALUES ('fixture', 'pw');
            INSERT INTO characters(id, username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
            VALUES (1, 'fixture', 'Owner', 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0);
            INSERT INTO items(selfId, name, amount, characterId) VALUES (57, 'Adena', 100, 1);
            INSERT INTO clans(id, name, leaderId, level) VALUES (1, 'FixtureClan', 1, 1);
            INSERT INTO clan_simulation_clans(clanId, mode, createdAt, updatedAt, stateJson)
            VALUES (1, 'autonomous', 1, 1, '{}');`);
        append(world, history, 'fixture:old');
        world.prepare('INSERT INTO history_outbox(kind, payload) VALUES (?, ?)').run('clan_action', JSON.stringify({
            id: 9, clanId: 1, actionKey: 'fixture:once', actionType: 'goal_plan', priority: 0,
            status: 'succeeded', attempt: 1, availableAt: 0, leaseUntil: null, payloadJson: '{}',
            resultJson: '{}', reasonCode: '', createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: Date.now()
        }));
        Store.transfer(history, world);
        world.exec('DELETE FROM history_outbox');
        history.close(); world.close();
        const args = { databasePath: worldPath, historyPath, savesDir: path.join(directory, 'saves') };
        const old = await SavedGames.run({ ...args, operation: 'create', name: 'Old pair' });
        world = new DatabaseSync(worldPath);
        history = Store.open(historyPath);
        world.exec('UPDATE items SET amount=200 WHERE selfId=57');
        append(world, history, 'fixture:new');
        history.close(); world.close();
        const newer = await SavedGames.run({ ...args, operation: 'create', name: 'New pair' });
        await run({ directory, worldPath, historyPath, args, old, newer });
    } finally {
        await Database.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
}

function failSecondRename(args) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const fs = require('node:fs');
            const { workerData } = require('node:worker_threads');
            const rename = fs.renameSync;
            fs.renameSync = (source, target) => {
                if (target === workerData.historyPath && source.endsWith('.loading')) {
                    throw Object.assign(new Error('fixture:second-rename-EIO'), { code: 'EIO' });
                }
                return rename(source, target);
            };
            require(workerData.modulePath);
        `, { eval: true, workerData: { ...args, modulePath: require.resolve('../scripts/saved-games') } });
        let reply;
        worker.on('message', (message) => { reply = message; });
        worker.once('error', reject);
        worker.once('exit', (code) => {
            if (code || !reply) reject(new Error(`fixture worker exited ${code}`));
            else resolve(reply);
        });
    });
}

test('failed second replacement must preserve the currently loaded pair or a recoverable replacement', async () => {
    await fixture(async ({ directory, worldPath, historyPath, args, old, newer }) => {
        await SavedGames.run({ ...args, operation: 'load', id: old.id });
        const before = pair(worldPath, historyPath);
        const reply = await failSecondRename({ ...args, operation: 'load', id: newer.id });
        assert.match(reply.error, /fixture:second-rename-EIO/);
        const afterFailure = pair(worldPath, historyPath);
        const staging = fs.readdirSync(directory).filter((name) => name.endsWith('.loading'));
        Database.init();
        const afterRestart = await Database.readHistory(['SELECT eventKey FROM market_trades ORDER BY id']);
        await Database.close();
        console.log(JSON.stringify({ case: 'second-rename', before, afterFailure, staging,
            restartedTrades: afterRestart.map((r) => r.eventKey), orphan: fs.existsSync(`${historyPath}.orphan`) }));
        assert.deepEqual(afterFailure, before, 'a failed load must not leave a partially replaced pair');
    });
});

test('a migrated save missing history must be rejected before replacing the live pair', async () => {
    await fixture(async ({ worldPath, historyPath, args, old }) => {
        const before = pair(worldPath, historyPath);
        fs.rmSync(path.join(args.savesDir, old.id, 'history.sqlite'));
        let failure;
        try { await SavedGames.run({ ...args, operation: 'load', id: old.id }); } catch (error) { failure = error; }
        const afterLoad = pair(worldPath, historyPath);
        Database.init();
        const duplicate = await Database.enqueueClanAction({ clanId: 1, actionKey: 'fixture:once', actionType: 'goal_plan' });
        const trades = await Database.readHistory(['SELECT eventKey FROM market_trades']);
        await Database.close();
        assert.equal(duplicate.created, false, 'the finished action stays deduplicated after a rejected load');
        assert.equal(duplicate.idempotent, true);
        console.log(JSON.stringify({ case: 'missing-history', before, afterLoad, loadError: failure?.message || null,
            restartedTrades: trades.map((r) => r.eventKey), finishedActionCreatedAgain: duplicate.created }));
        assert(failure, 'missing history in a migrated save must fail preflight');
        assert.deepEqual(afterLoad, before);
    });
});

test('a failed outbox journal write must preserve buffered economy and PvP rows for retry', async () => {
    await fixture(async ({ worldPath }) => {
        Database.init();
        await Database.execute(['UPDATE items SET amount=amount+25 WHERE selfId=57'], 'fixture:journal-retry');
        PvpJournal.coldConflict({ key: 'fixture:journal-retry', reason: 'fixture', partyIds: [null, null],
            sideSizes: [1, 1], outcome: 'won', fought: true, principals: [
                { characterId: 1, level: 1 }, { characterId: 2, level: 1 }
            ], at: Date.now() });
        await Database.execute([`CREATE TRIGGER fixture_reject_journal BEFORE INSERT ON history_outbox
            WHEN NEW.kind='journal' BEGIN SELECT RAISE(ABORT, 'fixture:journal-outbox-write'); END`]);
        await assert.rejects(Database.flushJournals(), /fixture:journal-outbox-write/);
        await Database.execute(['DROP TRIGGER fixture_reject_journal']);
        const retriedRows = await Database.flushJournals();
        const economy = await Database.readHistory(["SELECT delta, events FROM economy_flow_hour WHERE operation='fixture:journal-retry'"]);
        const pvp = await Database.readHistory(["SELECT conflictKey FROM pvp_conflicts WHERE conflictKey='fixture:journal-retry'"]);
        const world = new DatabaseSync(worldPath, { readOnly: true });
        const adena = world.prepare('SELECT amount FROM items WHERE selfId=57').get().amount;
        world.close();
        console.log(JSON.stringify({ case: 'journal-retry', adena, retriedRows, economy, pvp }));
        assert.deepEqual(economy.map((row) => [row.delta, row.events]), [[25, 1]], 'the committed world delta must survive the journal retry');
        assert.equal(pvp.length, 1);
    });
});

test('a save whose history belongs to another world must be rejected before replacing the live pair', async () => {
    await fixture(async ({ worldPath, historyPath, args, old }) => {
        const before = pair(worldPath, historyPath);
        const savedHistory = Store.open(path.join(args.savesDir, old.id, 'history.sqlite'));
        Store.setMeta(savedHistory, Store.WORLD_TOKEN_KEY, 'fixture:other-world');
        savedHistory.close();
        let failure;
        try { await SavedGames.run({ ...args, operation: 'load', id: old.id }); } catch (error) { failure = error; }
        const afterLoad = pair(worldPath, historyPath);
        Database.init();
        const trades = await Database.readHistory(['SELECT eventKey FROM market_trades']);
        await Database.close();
        console.log(JSON.stringify({ case: 'foreign-history', before, afterLoad, loadError: failure?.message || null,
            restartedTrades: trades.map((r) => r.eventKey), orphan: fs.existsSync(`${historyPath}.orphan`) }));
        assert(failure, 'mismatched file identities must fail preflight');
        assert.deepEqual(afterLoad, before);
    });
});
