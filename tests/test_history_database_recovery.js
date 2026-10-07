'use strict';

// Disposable SQLite fixtures only; no game, launcher or Observer is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

assert.equal(process.env.L2NODE_CONFIG_FILE, 'config/default.ini');
assert(!process.env.L2NODE_SHARED_CONFIG_FILE, 'a shared configuration must not enter these fixtures');
const isolated = require('./helpers/isolatedSocialDatabase')('history-recovery');
require('../src/Global');
isolated.assertConfigured(options.default);
invoke('GameServer/DataCache').init();
const Database = invoke('Database');
const History = invoke('HistoryDatabase');
const Store = invoke('HistoryStore');
const SavedGames = require('../scripts/saved-games');
utils.infoFail = (_prefix, message, detail) => { throw new Error(`${message}: ${detail}`); };

const root = path.join(isolated.directory, 'fixtures');
fs.mkdirSync(root, { recursive: true });
const schema = fs.readFileSync(path.resolve(__dirname, '../database/sql/history.sql'), 'utf8');
const valueTables = ['characters', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines',
    'clans', 'clan_warehouse_items', 'clan_warehouse_ledger', 'clan_warehouse_reservations', 'board_settlements', 'bot_life_state'];

function snapshot(db, tables = valueTables) {
    return Object.fromEntries(tables.map((table) => [table,
        db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map((row) => ({ ...row }))]));
}

async function fixture(run) {
    const directory = fs.mkdtempSync(path.join(root, 'recovery-'));
    const worldPath = path.join(directory, 'world.sqlite');
    const historyPath = Store.pathFor(worldPath);
    options.default.Database.path = worldPath;
    options.default.Database.historyPath = historyPath;
    try {
        Database.init();
        await Database.close();
        await run({ directory, worldPath, historyPath });
    } finally {
        await Database.close();
        fs.rmSync(directory, { force: true, recursive: true });
    }
}

function seedWorld(db) {
    db.exec(`INSERT INTO accounts VALUES ('fixture', 'pw');
        INSERT INTO characters(id, username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
        VALUES (1, 'fixture', 'Owner', 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0),
               (2, 'fixture', 'Buyer', 0, 0, 100, 100, 0, 0, 0, 0, 0, 0, 0);
        INSERT INTO items(selfId, name, amount, characterId) VALUES (57, 'Adena', 1000, 1), (1001, 'Item', 7, 2);
        INSERT INTO warehouse_items(selfId, name, amount, characterId) VALUES (1002, 'Warehouse item', 3, 1);
        INSERT INTO board_settlements(ownerId, selfId, name, amount, createdAt) VALUES (1, 57, 'Adena', 11, 1);
        INSERT INTO bot_life_state(characterId, accountName, characterName, exp, adena, inventorySummary, statsJson, simulationRevision)
        VALUES (1, 'fixture', 'Owner', 850, 1000, '{"adena":1000}', '{"fixture":"kept"}', 9);
        INSERT INTO clans(id, name, leaderId, level) VALUES (1, 'FixtureClan', 1, 1);
        INSERT INTO clan_warehouse_items(clanId, selfId, name, amount) VALUES (1, 57, 'Adena', 300);
        INSERT INTO clan_warehouse_ledger(clanId, characterId, selfId, amount, operation, resolveKey)
        VALUES (1, 1, 57, 300, 'deposit', 'fixture:deposit');
        INSERT INTO clan_warehouse_reservations(clanId, selfId, amount, goalKey) VALUES (1, 57, 10, 'fixture:goal');
        INSERT INTO afk_trade_shops(ownerId, storeType, town, locX, locY, locZ, createdAt, updatedAt)
        VALUES (1, 1, 'Giran', 0, 0, 0, 1, 1);
        INSERT INTO afk_trade_shops(ownerId, storeType, escrowAdena, town, locX, locY, locZ, createdAt, updatedAt)
        VALUES (2, 3, 40, 'Giran', 0, 0, 0, 1, 1);
        INSERT INTO afk_trade_lines(shopId, selfId, count, initialCount, price, createdAt, updatedAt)
        VALUES (1, 1001, 4, 4, 10, 1, 1), (2, 1002, 2, 2, 20, 1, 1);`);
}

function journal(operation, delta = 5) {
    return { rows: [{ hour: Math.floor(Date.now() / Store.HOUR_MS), operation, store: 'inventory',
        selfId: 57, delta, events: 1 }], conflicts: [] };
}

function trade(eventKey) {
    return { eventKey, occurredAt: Date.now(), channel: 'wts', sourceType: 'fixture', selfId: 1001,
        itemName: 'Item', quantity: 1, unitPrice: 10, totalPrice: 10 };
}

test('migration resumes after history copy and before source drop with the same world token', async () => {
    await fixture(async ({ worldPath, historyPath }) => {
        const world = new DatabaseSync(worldPath);
        try {
            seedWorld(world);
            world.exec(schema);
            const at = Date.now();
            world.prepare(`INSERT INTO market_trades(eventKey, occurredAt, channel, selfId, quantity, unitPrice, totalPrice)
                VALUES ('old:trade', ?, 'wts', 1001, 1, 10, 10)`).run(at);
            world.prepare(`INSERT INTO afk_trade_events(id, ownerId, counterpartyId, kind, selfId, amount, unitPrice, totalPrice, createdAt)
                VALUES (12, 1, 2, 'sale', 1001, 1, 10, 10, ?), (13, 1, 2, 'sale', 1001, 1, 10, 10, ?)`).run(at, at);
            world.prepare("INSERT INTO clan_goal_events(id, clanId, eventType, occurredAt) VALUES (80, 1, 'goal_updated', ?)").run(at);
            world.prepare("INSERT INTO bot_life_events(id, characterId, eventType, summary, createdAt) VALUES (9, 1, 'death', 'old', ?)").run(at);
            world.prepare(`INSERT INTO market_store_events(storeId, characterId, characterName, storeType, eventType, reason, occurredAt, openedAt, itemsJson)
                VALUES ('old:store', 1, 'Owner', 1, 'opened', 'fixture', ?, ?, '[]')`).run(at, at);
            world.prepare(`INSERT INTO economy_flow_hour(hour, operation, store, selfId, delta, events)
                VALUES (?, 'old:journal', 'inventory', 57, 9, 1)`).run(Math.floor(at / Store.HOUR_MS));
            world.prepare(`INSERT INTO pvp_conflicts(at, source, action, outcome, initiatorId, targetId)
                VALUES (?, 'cold', 'contest', 'won', 1, 2)`).run(at);
            world.prepare(`INSERT INTO pvp_conflict_hour(hour, source, action, outcome, conflicts)
                VALUES (?, 'cold', 'contest', 'won', 1)`).run(Math.floor(at / Store.HOUR_MS));
            world.prepare(`INSERT INTO clan_actions(id, clanId, actionKey, actionType, status, resolvedAt)
                VALUES (2, 1, 'old:done', 'goal_plan', 'succeeded', ?),
                       (3, 1, 'old:pending', 'goal_plan', 'pending', NULL)`).run(at);
            const before = snapshot(world);
            const markers = snapshot(world, ['schema_migrations']);
            const token = world.prepare("SELECT value FROM world_meta WHERE key = 'historyToken'").get().value;
            const interrupted = new Proxy(world, {
                get(target, key) {
                    if (key === 'exec') return (sql) => {
                        if (sql === 'DROP TABLE main.afk_trade_events') throw new Error('fixture:after-copy-before-drop');
                        return target.exec(sql);
                    };
                    const value = Reflect.get(target, key);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
            assert.throws(() => History.prepare(interrupted, historyPath), /fixture:after-copy-before-drop/);
            assert.equal(world.prepare('SELECT COUNT(*) AS n FROM afk_trade_events').get().n, 2);
            let history = Store.open(historyPath);
            assert.equal(history.prepare('SELECT COUNT(*) AS n FROM afk_trade_events').get().n, 2);
            history.close();
            History.prepare(world, historyPath);
            assert.deepEqual(History.prepare(world, historyPath), {}, 'third prepare does no work');
            assert(!fs.existsSync(`${historyPath}.orphan`), 'the partial history must survive token validation');
            assert.deepEqual(snapshot(world), before);
            assert.deepEqual(snapshot(world, ['schema_migrations']), markers);
            assert.equal(world.prepare("SELECT value FROM world_meta WHERE key = 'historyToken'").get().value, token);
            history = Store.open(historyPath);
            try {
                for (const table of Store.MOVED_TABLES) {
                    assert.equal(history.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
                        table === 'market_trades' ? 3 : table === 'afk_trade_events' ? 2 : 1, table);
                    assert(!world.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
                }
                assert.deepEqual(history.prepare('SELECT actionKey FROM clan_actions').all().map((r) => r.actionKey), ['old:done']);
                assert.deepEqual(world.prepare('SELECT actionKey FROM clan_actions').all().map((r) => r.actionKey), ['old:pending']);
            } finally { history.close(); }
        } finally { world.close(); }
        Database.init();
        const next = await Database.recordHistory('afk_event', { ownerId: 1, kind: 'sale', selfId: 1001, itemName: 'Item',
            amount: 1, unitPrice: 10, totalPrice: 10, createdAt: Date.now() });
        assert(next > 80, 'new outbox ids exceed both old AFK and clan event ids');
        await Database.flushHistory();
        await Database.close();
        Database.init();
        assert.equal((await Database.readHistory(['SELECT COUNT(*) AS n FROM afk_trade_events']))[0].n, 3);
    });
});

test('failed history commit rolls back additive rows and cursor, then replay applies once', async () => {
    await fixture(async ({ worldPath, historyPath }) => {
        const world = new DatabaseSync(worldPath);
        const history = Store.open(historyPath);
        try {
            const put = world.prepare('INSERT INTO history_outbox(kind, payload) VALUES (?, ?)');
            put.run('journal', JSON.stringify(journal('fixture:replay')));
            put.run('life_events', JSON.stringify({ characterId: 1, events: [
                { eventType: 'hunt', summary: 'first', weight: 1, createdAt: Date.now(), meta: {}, coalesce: true }
            ] }));
            const faulty = new Proxy(history, {
                get(target, key) {
                    if (key === 'exec') return (sql) => {
                        if (sql === 'COMMIT') throw new Error('fixture:history-commit');
                        return target.exec(sql);
                    };
                    const value = Reflect.get(target, key);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
            assert.throws(() => Store.transfer(faulty, world), /fixture:history-commit/);
            assert.equal(Store.cursor(history), 0);
            assert.equal(history.prepare('SELECT COUNT(*) AS n FROM economy_flow_hour').get().n, 0);
            assert.equal(history.prepare('SELECT COUNT(*) AS n FROM bot_life_events').get().n, 0);
            assert.equal(Store.transfer(history, world).moved, 2);
            assert.equal(Store.transfer(history, world).moved, 0);
            assert.deepEqual({ ...history.prepare('SELECT delta, events FROM economy_flow_hour').get() }, { delta: 5, events: 1 });
            assert.equal(history.prepare('SELECT COUNT(*) AS n FROM bot_life_events').get().n, 1);
            assert.equal(world.prepare('SELECT COUNT(*) AS n FROM history_outbox').get().n, 2, 'transfer only reads the world');
        } finally { history.close(); world.close(); }
        Database.init();
        await Database.flushHistory();
        await Database.close();
        const stoppedWorld = new DatabaseSync(worldPath);
        assert.equal(stoppedWorld.prepare('SELECT COUNT(*) AS n FROM history_outbox').get().n, 0);
        stoppedWorld.close();
    });
});

test('outbox insertion failure rolls back the actual AFK deal including money and items', async () => {
    await fixture(async ({ worldPath }) => {
        Database.init();
        await Database.createAccount('fixture', 'pw');
        const make = (name) => ({ name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0,
            face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 });
        const ownerId = Number((await Database.createCharacter('fixture', make('Owner'))).insertId);
        const buyerId = Number((await Database.createCharacter('fixture', make('Buyer'))).insertId);
        const stock = Number((await Database.setItem(ownerId, { selfId: 1001, name: 'Item', amount: 7,
            enchant: 0, equipped: false, slot: 0 })).insertId);
        await Database.setItem(buyerId, { selfId: 57, name: 'Adena', amount: 1000, enchant: 0, equipped: false, slot: 0 });
        const opened = await Database.createAfkTradeShop(ownerId, { storeType: 1, title: 'Fixture', town: 'Giran',
            locX: 0, locY: 0, locZ: 0, appearance: { model: { name: 'Owner' } }, lines: [
                { objectId: stock, selfId: 1001, name: 'Item', count: 4, price: 10, stackable: true }
            ] });
        await Database.flushHistory();
        const read = new DatabaseSync(worldPath, { readOnly: true });
        const before = snapshot(read);
        read.close();
        await Database.execute([`CREATE TRIGGER fixture_reject_outbox BEFORE INSERT ON history_outbox
            BEGIN SELECT RAISE(ABORT, 'fixture:outbox-write'); END`]);
        const request = { shopId: opened.shop.id, ownerId, lineId: opened.shop.lines[0].id,
            amount: 2, expectedPrice: 10, expectedRevision: 1 };
        await assert.rejects(Database.buyFromAfkTradeShop(buyerId, request), /fixture:outbox-write/);
        const after = new DatabaseSync(worldPath, { readOnly: true });
        assert.deepEqual(snapshot(after), before);
        after.close();
        assert.equal((await Database.readHistory(['SELECT COUNT(*) AS n FROM market_trades']))[0].n, 0);
        await Database.execute(['DROP TRIGGER fixture_reject_outbox']);
        await Database.buyFromAfkTradeShop(buyerId, request);
        assert.equal((await Database.fetchItems(buyerId)).find((row) => row.selfId === 57).amount, 980);
        assert.equal((await Database.readHistory(['SELECT COUNT(*) AS n FROM market_trades']))[0].n, 1);
    });
});

test('close drains queued writes, rejects later writes and preserves backlog when history is unavailable', async () => {
    await fixture(async ({ worldPath, historyPath }) => {
        Database.init();
        const queued = Array.from({ length: 20 }, () => Database.recordHistory('journal', journal('fixture:close', 1)));
        const closing = Database.close();
        assert.equal(Database.close(), closing);
        await assert.rejects(Database.recordHistory('journal', journal('fixture:late')), /shutdown is in progress/);
        await Promise.all(queued);
        await closing;
        const world = new DatabaseSync(worldPath);
        const history = Store.open(historyPath);
        assert.equal(world.prepare('SELECT COUNT(*) AS n FROM history_outbox').get().n, 0);
        assert.deepEqual({ ...history.prepare("SELECT delta, events FROM economy_flow_hour WHERE operation='fixture:close'").get() },
            { delta: 20, events: 20 });
        history.close(); world.close();
        Database.init();
        await History.stop();
        await Database.recordHistory('market_trade', trade('fixture:worker-unavailable'));
        await Database.close();
        const stopped = new DatabaseSync(worldPath);
        assert.equal(stopped.prepare('SELECT COUNT(*) AS n FROM history_outbox').get().n, 1);
        stopped.close();
        Database.init();
        assert.equal((await Database.readHistory(["SELECT COUNT(*) AS n FROM market_trades WHERE eventKey='fixture:worker-unavailable'"]))[0].n, 1);
    });
});

test('stopped pair save preserves authoritative state and replays its saved backlog once', async () => {
    await fixture(async ({ directory, worldPath, historyPath }) => {
        const world = new DatabaseSync(worldPath);
        seedWorld(world);
        const before = snapshot(world);
        world.prepare('INSERT INTO history_outbox(kind, payload) VALUES (?, ?)').run('journal', JSON.stringify(journal('fixture:saved-backlog')));
        world.close();
        const args = { databasePath: worldPath, historyPath, savesDir: path.join(directory, 'saves') };
        const save = await SavedGames.run({ ...args, operation: 'create', name: 'Fixture pair' });
        assert(fs.existsSync(path.join(args.savesDir, save.id, 'history.sqlite')));
        Database.init();
        await Database.recordMarketTrade(trade('fixture:after-save'));
        await Database.execute(['UPDATE items SET amount=900 WHERE selfId=57']);
        await Database.close();
        await SavedGames.run({ ...args, operation: 'load', id: save.id });
        const restored = new DatabaseSync(worldPath);
        assert.deepEqual(snapshot(restored), before);
        assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM history_outbox').get().n, 1);
        restored.close();
        Database.init();
        assert.deepEqual((await Database.readHistory(["SELECT delta, events FROM economy_flow_hour WHERE operation='fixture:saved-backlog'"]))
            .map((row) => [row.delta, row.events]), [[5, 1]]);
        assert.equal((await Database.readHistory(["SELECT COUNT(*) AS n FROM market_trades WHERE eventKey='fixture:after-save'"]))[0].n, 0);
        await Database.close();
        Database.init();
        assert.equal((await Database.readHistory(["SELECT delta FROM economy_flow_hour WHERE operation='fixture:saved-backlog'"]))[0].delta, 5);
    });
});

test('a genuine legacy one-file save migrates its source tables and keeps marker 50 stable on restart', async () => {
    await fixture(async ({ directory, worldPath, historyPath }) => {
        const world = new DatabaseSync(worldPath);
        seedWorld(world);
        const before = snapshot(world);
        world.exec(schema);
        world.exec(`DROP TABLE history_meta; DROP TABLE history_outbox;
            DELETE FROM schema_migrations WHERE version=50;
            DELETE FROM world_meta WHERE key='historyToken';`);
        Store.APPLY.market_trade(world, trade('fixture:legacy'));
        world.close();
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(historyPath + suffix, { force: true });
        const args = { databasePath: worldPath, historyPath, savesDir: path.join(directory, 'legacy-saves') };
        const save = await SavedGames.run({ ...args, operation: 'create', name: 'Legacy one-file world' });
        assert(!fs.existsSync(path.join(args.savesDir, save.id, 'history.sqlite')));
        Database.init();
        await Database.close();
        await SavedGames.run({ ...args, operation: 'load', id: save.id });
        assert(!fs.existsSync(historyPath), 'the legacy load removes the newer history');
        Database.init();
        assert.equal((await Database.readHistory(["SELECT COUNT(*) AS n FROM market_trades WHERE eventKey='fixture:legacy'"]))[0].n, 1);
        const firstMarkers = await Database.execute(['SELECT * FROM schema_migrations ORDER BY version']);
        await Database.close();
        const restored = new DatabaseSync(worldPath);
        assert.deepEqual(snapshot(restored), before);
        restored.close();
        Database.init();
        assert.deepEqual(await Database.execute(['SELECT * FROM schema_migrations ORDER BY version']), firstMarkers);
        assert.equal((await Database.readHistory(["SELECT COUNT(*) AS n FROM market_trades WHERE eventKey='fixture:legacy'"]))[0].n, 1);
    });
});
