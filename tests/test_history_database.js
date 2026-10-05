'use strict';

// Two databases (step 1.8): the world file keeps what changes together; the
// history file keeps finished events, filled through the world's outbox by the
// history thread (src/HistoryStore.js, src/HistoryWorker.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const Database = invoke('Database');
const HistoryStore = invoke('HistoryStore');
const MarketTradeOverviewReader = invoke('MarketTradeOverviewReader');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const SavedGames = require('../scripts/saved-games');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-database-'));
const worldPath = path.join(directory, 'world.sqlite');
const historyPath = path.join(directory, 'world.history.sqlite');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function removeFiles(file) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
}

function useWorld(file) {
    options.default.Database.path = file;
    options.default.Database.historyPath = '';
}

function count(connection, sql, params = []) {
    return Number(connection.prepare(sql).get(...params).n);
}

function character(name) {
    return {
        name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 83000, locY: 148000, locZ: -3400
    };
}

function item(selfId, amount, name = `Item ${selfId}`) {
    return { selfId, name, amount, enchant: 0, equipped: false, slot: 0 };
}

async function waitFor(check, message) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(message);
}

async function outboxRows() {
    return Number((await Database.execute(['SELECT COUNT(*) AS n FROM history_outbox']))[0].n);
}

// A player buys from an AFK shop: the world change is one transaction; its
// history rows reach the history file and leave the outbox.
async function tradeWritesWorldAndHistory() {
    useWorld(worldPath);
    Database.init();
    assert.strictEqual(Database.stats().historyPath, historyPath);
    await Database.createAccount('history_owner', 'pw');
    await Database.createAccount('history_buyer', 'pw');
    const ownerId = Number((await Database.createCharacter('history_owner', character('HistoryOwner'))).insertId);
    const buyerId = Number((await Database.createCharacter('history_buyer', character('HistoryBuyer'))).insertId);
    const stockId = Number((await Database.setItem(ownerId, item(1001, 10))).insertId);
    await Database.setItem(buyerId, item(57, 1000, 'Adena'));
    const sale = await Database.createAfkTradeShop(ownerId, {
        storeType: 1, title: 'Sale', town: 'Giran', locX: 83000, locY: 148000, locZ: -3400,
        appearance: { model: { name: 'HistoryOwner' } },
        lines: [{ objectId: stockId, selfId: 1001, name: 'Item 1001', count: 4, price: 10, stackable: true }]
    });
    const bought = await Database.buyFromAfkTradeShop(buyerId, {
        shopId: sale.shop.id, ownerId, lineId: sale.shop.lines[0].id, amount: 2, expectedPrice: 10, expectedRevision: 1
    });
    const buyerItems = await Database.fetchItems(buyerId);
    assert.strictEqual(buyerItems.find((row) => Number(row.selfId) === 1001).amount, 2, 'the world holds the bought items');
    assert.strictEqual(buyerItems.find((row) => Number(row.selfId) === 57).amount, 980);

    const trades = await Database.readHistory(['SELECT * FROM market_trades WHERE eventKey = ?', [`afk:${bought.eventId}`]]);
    assert.strictEqual(trades.length, 1, 'the trade row is in the history file');
    assert.deepStrictEqual([trades[0].sellerCharacterId, trades[0].buyerCharacterId, trades[0].totalPrice], [ownerId, buyerId, 20]);
    const notifications = await Database.fetchAfkTradeNotifications(ownerId);
    assert.deepStrictEqual(notifications.map((event) => [event.id, event.kind, event.amount]), [[bought.eventId, 'sale', 2]],
        'the owner notification is the outbox row of the trade');
    await Database.markAfkTradeNotificationsDelivered(ownerId, [bought.eventId]);
    assert.strictEqual((await Database.fetchAfkTradeNotifications(ownerId)).length, 0,
        'a delivered mark lands after the event it marks');
    await waitFor(async () => (await outboxRows()) === 0, 'moved rows must leave the outbox');
    assert.strictEqual((await Database.execute([
        "SELECT name FROM sqlite_master WHERE name IN ('market_trades', 'afk_trade_events', 'clan_goal_events', 'bot_life_events')"
    ])).length, 0, 'history tables are not in the world file');

    // Readers: the market overview (main thread and read-only worker), the
    // bot life journal and clan events read the history file.
    assert.strictEqual((await Database.fetchMarketTradeOverview()).windows.day.trades, 1);
    await LifeEvents.record(ownerId, 'death', 'fell in battle', {}, 4);
    assert.deepStrictEqual((await LifeEvents.recentForBot(ownerId)).map((event) => event.summary), ['fell in battle']);
    await Database.close();
    return { ownerId, buyerId };
}

// Finished clan actions move to the history file; their keys stay unique.
async function finishedClanActions() {
    Database.init();
    await Database.execute(["INSERT INTO accounts(username, password) VALUES ('bot_history_clan', 'pw')"]);
    await Database.execute([`INSERT INTO characters
        (id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
        VALUES (9301, 'bot_history_clan', 'HistoryLeader', 4, 0, 40, 500, 250, 0, 0, 0, 0, 0, 0, 0)`]);
    await Database.execute(["INSERT INTO clans(id, name, leaderId, level) VALUES (93, 'HistoryClan', 9301, 1)"]);
    await Database.execute([`INSERT INTO clan_simulation_clans(clanId, mode, createdAt, updatedAt, stateJson)
        VALUES (93, 'autonomous', 1, 1, '{}')`]);
    const created = await Database.enqueueClanAction({ clanId: 93, actionKey: 'history:once', actionType: 'goal_plan' });
    assert.strictEqual(created.created, true);
    const claim = await Database.claimClanAction({});
    assert.strictEqual(claim.action.id, created.actionId);
    const resolved = await Database.resolveClanAction({ actionId: created.actionId, status: 'succeeded', result: { done: 1 } });
    assert.strictEqual(resolved.action.status, 'succeeded');
    assert.strictEqual((await Database.execute(['SELECT COUNT(*) AS n FROM clan_actions'])).at(0).n, 0,
        'a finished action leaves the world in the transaction that finishes it');
    const again = await Database.enqueueClanAction({ clanId: 93, actionKey: 'history:once', actionType: 'goal_plan' });
    assert.deepStrictEqual([again.created, again.idempotent, again.actionId], [false, true, created.actionId],
        'a key taken by a finished action is still taken');
    const repeated = await Database.resolveClanAction({ actionId: created.actionId, status: 'failed' });
    assert.deepStrictEqual([repeated.idempotent, repeated.status], [true, 'succeeded']);
    const listed = await Database.fetchClanActions({ clanId: 93 });
    assert.deepStrictEqual(listed.map((action) => [action.actionKey, action.status]), [['history:once', 'succeeded']]);
    const events = await Database.fetchClanGoalEvents(93);
    assert.deepStrictEqual(events.map((event) => event.eventType), ['action_succeeded']);
    await Database.close();
}

// A crash after the history file took the rows but before the world deleted
// them from the outbox: the next start moves nothing twice.
async function crashBetweenMoveAndDelete() {
    Database.init();
    const journal = { rows: [{ hour: Math.floor(Date.now() / HOUR_MS), operation: 'test:crash', store: 'inventory', selfId: 57, delta: 5, events: 1 }], conflicts: [] };
    const journalId = await Database.recordHistory('journal', journal);
    const tradeId = (await Database.recordMarketTrade({ eventKey: 'test:crash', selfId: 57, quantity: 1, unitPrice: 7, channel: 'wts' })).outboxId;
    const outbox = await Database.execute(['SELECT id, kind, payload FROM history_outbox WHERE id IN (?, ?) ORDER BY id', [journalId, tradeId]]);
    assert.strictEqual(outbox.length, 2);
    await Database.flushHistory();
    await waitFor(async () => (await outboxRows()) === 0, 'moved rows must leave the outbox');
    await Database.close();

    // Put the moved rows back as if their delete never ran.
    const world = new DatabaseSync(worldPath);
    outbox.forEach((row) => world.prepare('INSERT INTO history_outbox (id, kind, payload) VALUES (?, ?, ?)').run(row.id, row.kind, row.payload));
    world.close();

    Database.init();
    await waitFor(async () => (await outboxRows()) === 0, 'rows left by a crash are deleted, not moved again');
    const journaled = await Database.readHistory(["SELECT delta, events FROM economy_flow_hour WHERE operation = 'test:crash'"]);
    assert.deepStrictEqual(journaled.map((row) => [row.delta, row.events]), [[5, 1]], 'an additive row is not added twice');
    assert.strictEqual((await Database.readHistory(["SELECT COUNT(*) AS n FROM market_trades WHERE eventKey = 'test:crash'"]))[0].n, 1);
    await Database.close();

    // The same at the level of one transfer: a row that fails to apply is
    // skipped, the batch commits once, a repeated transfer is a no-op.
    const worldDb = new DatabaseSync(worldPath);
    const historyDb = HistoryStore.open(historyPath);
    const before = HistoryStore.cursor(historyDb);
    worldDb.prepare('INSERT INTO history_outbox (kind, payload) VALUES (?, ?), (?, ?)').run(
        'unknown_kind', '{}', 'market_trade', JSON.stringify({ eventKey: 'test:after-bad', occurredAt: 1, channel: 'wts',
            sourceType: '', selfId: 57, itemName: '', quantity: 1, unitPrice: 1, totalPrice: 1 }));
    const first = HistoryStore.transfer(historyDb, worldDb);
    assert.deepStrictEqual([first.moved, first.failed, first.upTo], [1, 1, before + 2]);
    assert.deepStrictEqual(HistoryStore.transfer(historyDb, worldDb), { moved: 0, failed: 0, upTo: before + 2, errors: [] });
    assert.strictEqual(count(historyDb, "SELECT COUNT(*) AS n FROM market_trades WHERE eventKey = 'test:after-bad'"), 1);
    worldDb.exec('DELETE FROM history_outbox');
    worldDb.close();
    historyDb.close();
}

function conflict(outcome, at) {
    return { at, source: 'cold', conflictKey: null, action: 'contest', reason: null, spotId: null, npcId: null, matchup: null,
        outcome, pvp: 0, initiatorId: 1, initiatorLevel: 1, initiatorArchetype: null, initiatorKarma: 0, targetId: 2,
        targetLevel: 1, targetArchetype: null, targetKarma: 0, sideSizes: '1:1', losingSide: null, kills: 0, pkKills: 0,
        durationMs: 0, playerInvolved: 0, actions: 0 };
}

// A history file made before pvp_conflicts had the fight's actions gets the column.
function pvpActionsColumn() {
    const file = path.join(directory, 'pvp-actions.history.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE pvp_conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        source TEXT NOT NULL, conflictKey TEXT, action TEXT NOT NULL, reason TEXT, spotId TEXT, npcId INTEGER,
        matchup TEXT, outcome TEXT NOT NULL, pvp INTEGER NOT NULL DEFAULT 0, initiatorId INTEGER NOT NULL,
        initiatorLevel INTEGER NOT NULL DEFAULT 0, initiatorArchetype TEXT, initiatorKarma INTEGER NOT NULL DEFAULT 0,
        targetId INTEGER NOT NULL, targetLevel INTEGER NOT NULL DEFAULT 0, targetArchetype TEXT,
        targetKarma INTEGER NOT NULL DEFAULT 0, sideSizes TEXT, losingSide INTEGER, kills INTEGER NOT NULL DEFAULT 0,
        pkKills INTEGER NOT NULL DEFAULT 0, durationMs INTEGER NOT NULL DEFAULT 0, playerInvolved INTEGER NOT NULL DEFAULT 0)`);
    old.close();
    const db = HistoryStore.open(file);
    HistoryStore.APPLY.journal(db, { conflicts: [{ ...conflict('migrated', Date.now()), actions: 7 }] });
    assert.strictEqual(db.prepare('SELECT actions FROM pvp_conflicts').get().actions, 7);
    db.close();
    HistoryStore.open(file).close();
}

// Age cleanup in the history thread keeps each table's old rule.
function retention() {
    const file = path.join(directory, 'retention.history.sqlite');
    const db = HistoryStore.open(file);
    const now = Date.now();
    const trade = (key, at) => HistoryStore.APPLY.market_trade(db, { eventKey: key, occurredAt: at, channel: 'wts',
        sourceType: '', selfId: 1, itemName: '', quantity: 1, unitPrice: 1, totalPrice: 1 });
    trade('old', now - 91 * DAY_MS);
    trade('kept', now - 89 * DAY_MS);
    const store = (id, at) => HistoryStore.APPLY.market_store(db, { storeId: id, characterId: 1, characterName: 'A',
        storeType: 1, eventType: 'opened', reason: '', occurredAt: at, openedAt: at, itemsJson: [] });
    store('old', now - 91 * DAY_MS);
    store('kept', now - 89 * DAY_MS);
    const hour = Math.floor(now / HOUR_MS);
    HistoryStore.APPLY.journal(db, {
        rows: [{ hour: hour - 15 * 24, operation: 'old', store: 's', selfId: 1, delta: 1, events: 1 },
            { hour: hour - 13 * 24, operation: 'kept', store: 's', selfId: 1, delta: 1, events: 1 }],
        conflicts: [conflict('old', now - 15 * DAY_MS), conflict('raw-old', now - 13 * HOUR_MS), conflict('kept', now - HOUR_MS)]
    });
    const action = (id, resolvedAt) => HistoryStore.APPLY.clan_action(db, { id, clanId: 1, actionKey: `a${id}`,
        actionType: 'goal_plan', priority: 0, status: 'succeeded', attempt: 1, availableAt: 0, leaseUntil: null,
        payloadJson: '{"x":1}', resultJson: '{"y":1}', reasonCode: '', createdAt: 0, updatedAt: resolvedAt, resolvedAt });
    action(1, now - 2 * HOUR_MS);
    action(2, now - 1000);
    const event = (id, occurredAt) => HistoryStore.APPLY.clan_goal_event(db, { clanId: 1, eventType: 'action_succeeded',
        goalType: '', plan: '', reasonCode: '', payloadJson: '{"x":1}', occurredAt }, id);
    event(1, now - 2 * HOUR_MS);
    event(2, now - 1000);

    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM clan_actions INDEXED BY clan_actions_uncompacted_details
        WHERE resolvedAt IS NOT NULL AND resolvedAt < ? AND (payloadJson <> '{}' OR resultJson <> '{}')
        ORDER BY resolvedAt, id LIMIT 10`).all(now);
    assert(plan.some((row) => String(row.detail).includes('clan_actions_uncompacted_details')));
    HistoryStore.retention(db, now);
    const keys = (sql) => db.prepare(sql).all().map((row) => Object.values(row)[0]);
    assert.deepStrictEqual(keys('SELECT eventKey FROM market_trades'), ['kept'], 'market trades: 90 days');
    assert.deepStrictEqual(keys('SELECT storeId FROM market_store_events'), ['kept'], 'market store journal: 90 days');
    assert.deepStrictEqual(keys('SELECT operation FROM economy_flow_hour'), ['kept'], 'economy journal: 14 days');
    assert.deepStrictEqual(keys('SELECT outcome FROM pvp_conflict_hour ORDER BY outcome'), ['kept', 'raw-old'], 'PvP summary: 14 days');
    assert.deepStrictEqual(keys('SELECT outcome FROM pvp_conflicts'), ['kept'], 'raw PvP rows: 12 hours');
    assert.deepStrictEqual(keys('SELECT payloadJson || resultJson FROM clan_actions ORDER BY id'), ['{}{}', '{"x":1}{"y":1}'],
        'finished clan actions keep details for an hour');
    assert.deepStrictEqual(keys('SELECT payloadJson FROM clan_goal_events ORDER BY id'), ['{}', '{"x":1}'],
        'action events keep details for an hour');
    db.close();
}

// An old world kept every history table in its own file: the first start
// copies them into the history file and drops them from the world, and a
// move interrupted after the copy resumes without duplicates.
async function migrateOldWorld({ ownerId, buyerId }) {
    const oldWorld = path.join(directory, 'old.sqlite');
    const oldHistory = path.join(directory, 'old.history.sqlite');
    useWorld(oldWorld);
    Database.init();
    await Database.close();
    // Turn the new world back into an old single-file one.
    const world = new DatabaseSync(oldWorld);
    world.exec(`DROP TRIGGER market_store_insert; DROP TRIGGER market_store_update; DROP TABLE history_outbox;
        DELETE FROM world_meta; DELETE FROM schema_migrations WHERE version = 50;`);
    world.exec(fs.readFileSync(path.join(__dirname, '../database/sql/history.sql'), 'utf8'));
    world.exec(`DROP TABLE history_meta; DROP INDEX clan_actions_clan_recent;
        INSERT INTO accounts(username, password) VALUES ('old_owner', 'pw');
        INSERT INTO characters(id, username, name, classId, race, maxHp, maxMp, sex, face, hair, hairColor, locX, locY, locZ)
            VALUES (${ownerId}, 'old_owner', 'OldOwner', 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0),
                   (${buyerId}, 'old_owner', 'OldBuyer', 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0);
        INSERT INTO clans(id, name, leaderId, level) VALUES (5, 'OldClan', ${ownerId}, 1);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
        INSERT INTO afk_trade_events(shopId, ownerId, counterpartyId, kind, selfId, itemName, amount, unitPrice, totalPrice, createdAt)
            SELECT NULL, ${ownerId}, ${buyerId}, 'sale', 1001, 'Item', 1, 10, 10, ${Date.now()} FROM n;
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
        INSERT INTO clan_goal_events(clanId, eventType, occurredAt) SELECT 5, 'goal_updated', i FROM n;
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
        INSERT INTO bot_life_events(characterId, eventType, summary, createdAt) SELECT ${ownerId}, 'death', 'e' || i, i FROM n;
        INSERT INTO market_store_events(storeId, characterId, characterName, storeType, eventType, reason, occurredAt, openedAt, itemsJson)
            VALUES ('s1', ${ownerId}, 'OldOwner', 1, 'opened', 'r', ${Date.now()}, ${Date.now()}, '[]');
        INSERT INTO economy_flow_hour(hour, operation, store, selfId, delta, events) VALUES (${Math.floor(Date.now() / HOUR_MS)}, 'old', 'inventory', 57, 9, 1);
        INSERT INTO pvp_conflicts(at, source, action, outcome, initiatorId, targetId) VALUES (${Date.now()}, 'cold', 'contest', 'won', 1, 2);
        INSERT INTO pvp_conflict_hour(hour, source, action, outcome, conflicts) VALUES (${Math.floor(Date.now() / HOUR_MS)}, 'cold', 'contest', 'won', 1);
        INSERT INTO clan_actions(clanId, actionKey, actionType, status, resolvedAt) VALUES
            (5, 'old:done', 'goal_plan', 'succeeded', 1), (5, 'old:failed', 'goal_plan', 'failed', 1),
            (5, 'old:pending', 'goal_plan', 'pending', NULL);`);
    const expected = Object.fromEntries(HistoryStore.MOVED_TABLES.map((table) => [table,
        count(world, `SELECT COUNT(*) AS n FROM ${table}`)]));
    expected.market_trades += expected.afk_trade_events; // the old start-up copy of AFK events into the trade journal
    const maxAfkId = count(world, 'SELECT MAX(id) AS n FROM afk_trade_events');
    // An earlier move was interrupted after copying the goal events.
    const partial = HistoryStore.open(oldHistory);
    partial.exec(`ATTACH DATABASE '${oldWorld}' AS world;
        INSERT INTO clan_goal_events SELECT * FROM world.clan_goal_events; DETACH DATABASE world;`);
    partial.close();
    world.close();

    Database.init();
    const moved = new DatabaseSync(oldHistory, { readOnly: true });
    HistoryStore.MOVED_TABLES.forEach((table) => {
        assert.strictEqual(count(moved, `SELECT COUNT(*) AS n FROM ${table}`), expected[table], `${table} moved once`);
    });
    assert.deepStrictEqual(moved.prepare('SELECT actionKey FROM clan_actions ORDER BY id').all().map((row) => row.actionKey),
        ['old:done', 'old:failed'], 'finished clan actions move, live ones stay');
    moved.close();
    assert.deepStrictEqual((await Database.execute(['SELECT actionKey FROM clan_actions'])).map((row) => row.actionKey), ['old:pending']);
    assert.strictEqual((await Database.execute([`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'
        AND name IN (${HistoryStore.MOVED_TABLES.map((table) => `'${table}'`).join(', ')})`]))[0].n, 0);
    // New event ids continue above the moved ones.
    const eventId = await Database.recordHistory('afk_event', { shopId: null, ownerId, counterpartyId: buyerId, kind: 'sale',
        selfId: 1001, itemName: 'Item', amount: 1, unitPrice: 10, totalPrice: 10, createdAt: Date.now() });
    assert(eventId > maxAfkId);
    assert.strictEqual((await Database.fetchAfkTradeNotifications(ownerId, 200)).length, expected.afk_trade_events + 1);
    await Database.close();

    // A world file replaced under its history file gets a fresh history file.
    removeFiles(oldWorld);
    Database.init();
    assert.strictEqual((await Database.readHistory(['SELECT COUNT(*) AS n FROM afk_trade_events']))[0].n, 0);
    await Database.close();
    assert(fs.existsSync(`${oldHistory}.orphan`), 'the old history file is set aside, not mixed in');
}

// A save holds both files; loading an old one-file save drops the current
// history file so the world's own history moves at the next start.
async function saves() {
    useWorld(worldPath);
    const savesDir = path.join(directory, 'saves');
    const save = await SavedGames.run({ operation: 'create', databasePath: worldPath, historyPath, savesDir, name: 'two files' });
    const saveDir = path.join(savesDir, save.id);
    assert(fs.existsSync(path.join(saveDir, 'database.sqlite')) && fs.existsSync(path.join(saveDir, 'history.sqlite')));
    assert.strictEqual(save.sizeBytes, fs.statSync(path.join(saveDir, 'database.sqlite')).size
        + fs.statSync(path.join(saveDir, 'history.sqlite')).size);

    Database.init();
    await Database.recordMarketTrade({ eventKey: 'after-save', selfId: 57, quantity: 1, unitPrice: 1, channel: 'wts' });
    await Database.flushHistory();
    await Database.close();
    await SavedGames.run({ operation: 'load', databasePath: worldPath, historyPath, savesDir, id: save.id });
    Database.init();
    assert.strictEqual((await Database.readHistory(["SELECT COUNT(*) AS n FROM market_trades WHERE eventKey = 'after-save'"]))[0].n, 0,
        'loading restores the saved history file with its world');
    assert.strictEqual((await Database.readHistory(["SELECT COUNT(*) AS n FROM market_trades WHERE eventKey = 'test:crash'"]))[0].n, 1);
    await Database.close();

    fs.rmSync(path.join(saveDir, 'history.sqlite'));
    await SavedGames.run({ operation: 'load', databasePath: worldPath, historyPath, savesDir, id: save.id });
    assert(!fs.existsSync(historyPath), 'a one-file save leaves no stale history file');
}

// The observer's read-only worker reads the same history file. It keeps its
// connection open, so it runs last (a save needs the files closed).
async function overviewWorker() {
    useWorld(worldPath);
    Database.init();
    await Database.recordMarketTrade({ eventKey: 'overview', selfId: 57, quantity: 2, unitPrice: 3, channel: 'wts' });
    const at = Date.now();
    const overview = await Database.fetchMarketTradeOverview({ timestamp: at });
    assert.strictEqual(overview.recent[0].eventKey, 'overview');
    assert.deepStrictEqual(await MarketTradeOverviewReader.read(Database.stats().historyPath, { timestamp: at }), overview);
    await Database.close();
}

(async () => {
    try {
        const ids = await tradeWritesWorldAndHistory();
        await finishedClanActions();
        await crashBetweenMoveAndDelete();
        retention();
        pvpActionsColumn();
        await saves();
        await migrateOldWorld(ids);
        await overviewWorker();
        console.log('History database checks passed');
    } finally {
        await Database.close().catch(() => {});
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
