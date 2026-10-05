const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');

const Database = invoke('Database');
const EconomyJournal = invoke('EconomyJournal');
const PvpJournal = invoke('PvpJournal');
const databasePath = path.join(process.cwd(), 'tmp', 'test-economy-journal.sqlite');
const historyPath = path.join(process.cwd(), 'tmp', 'test-economy-journal.history.sqlite');

function clean() {
    for (const file of [databasePath, historyPath]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
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

// Everything the world holds, per item, read from every store the journal watches.
async function worldTotals() {
    const bids = (await Database.execute([
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'clan_hall_bids'"
    ], 'test:bids-table')).length > 0;
    const rows = await Database.execute([`
        SELECT selfId, SUM(amount) AS amount FROM (
            SELECT selfId, amount FROM items
            UNION ALL SELECT selfId, amount FROM warehouse_items
            UNION ALL SELECT selfId, amount FROM clan_warehouse_items
            UNION ALL SELECT 57, escrowAdena FROM afk_trade_shops
            UNION ALL SELECT lines.selfId, lines.count FROM afk_trade_lines lines
                JOIN afk_trade_shops shops ON shops.id = lines.shopId WHERE shops.storeType = 1
            ${bids ? 'UNION ALL SELECT 57, amount FROM clan_hall_bids' : ''}
        ) GROUP BY selfId`], 'test:world-totals');
    return new Map(rows.map((row) => [Number(row.selfId), Number(row.amount)]));
}

// The journal lives in the history file; readHistory waits for the outbox.
async function journalRows() {
    await Database.flushJournals();
    return Database.readHistory(['SELECT * FROM economy_flow_hour'], 'test:journal');
}

function sumBy(rows, keyOf) {
    const sums = new Map();
    rows.forEach((row) => sums.set(keyOf(row), (sums.get(keyOf(row)) || 0) + Number(row.delta)));
    return sums;
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();

    // A transaction that fails leaves nothing in the journal.
    EconomyJournal.begin('test:discarded');
    EconomyJournal.record('inventory', 57, 100);
    EconomyJournal.discard();
    assert.deepStrictEqual(EconomyJournal.drain(), []);

    await Database.createAccount('journal_owner', 'pw');
    await Database.createAccount('journal_customer', 'pw');
    const ownerId = Number((await Database.createCharacter('journal_owner', character('JournalOwner'))).insertId);
    const customerId = Number((await Database.createCharacter('journal_customer', character('JournalCustomer'))).insertId);
    const baseline = sumBy(await journalRows(), (row) => Number(row.selfId));
    const before = await worldTotals();

    const stockId = Number((await Database.setItem(ownerId, item(1001, 10))).insertId);
    await Database.setItem(customerId, item(57, 1000, 'Adena'));
    await Database.setItem(ownerId, item(57, 100, 'Adena'));

    const sale = await Database.createAfkTradeShop(ownerId, {
        storeType: 1, title: 'Sale', town: 'Giran', locX: 83000, locY: 148000, locZ: -3400,
        appearance: { model: { name: 'JournalOwner' } },
        lines: [{ objectId: stockId, selfId: 1001, name: 'Item 1001', count: 4, price: 10, stackable: true }]
    });
    await Database.buyFromAfkTradeShop(customerId, {
        shopId: sale.shop.id, ownerId, lineId: sale.shop.lines[0].id, amount: 2, expectedPrice: 10, expectedRevision: 1
    });
    await Database.closeAfkTradeShop(ownerId);

    const wantedId = Number((await Database.setItem(customerId, item(2002, 3))).insertId);
    const buy = await Database.createAfkTradeShop(ownerId, {
        storeType: 3, title: 'Buy', town: 'Giran', locX: 83000, locY: 148000, locZ: -3400,
        appearance: { model: { name: 'JournalOwner' } },
        lines: [{ selfId: 2002, name: 'Item 2002', count: 3, price: 5, stackable: true }]
    });
    await Database.sellToAfkTradeShop(customerId, {
        shopId: buy.shop.id, ownerId, lineId: buy.shop.lines[0].id, objectId: wantedId,
        amount: 2, expectedPrice: 5, expectedRevision: 1
    });
    await Database.closeAfkTradeShop(ownerId);

    // A bot action written through the summary sync carries its reason.
    await Database.syncInventorySummary(customerId, {
        57: { selfId: 57, name: 'Adena', amount: 1500 },
        1001: { selfId: 1001, name: 'Item 1001', amount: 2 },
        2002: { selfId: 2002, name: 'Item 2002', amount: 1 }
    }, 'npc_liquidation');

    // A statement that fails halfway is rolled back and not journaled.
    await assert.rejects(Database.execute([
        'UPDATE items SET amount = amount - 7 WHERE characterId = ? AND selfId IN (1001, 2002)', [ownerId]
    ], 'test:failing-update'));

    const after = await worldTotals();
    const rows = await journalRows();
    const journaled = sumBy(rows, (row) => Number(row.selfId));
    baseline.forEach((delta, selfId) => journaled.set(selfId, (journaled.get(selfId) || 0) - delta));
    new Set([...before.keys(), ...after.keys(), ...journaled.keys()]).forEach((selfId) => {
        const worldChange = (after.get(selfId) || 0) - (before.get(selfId) || 0);
        assert.strictEqual(journaled.get(selfId) || 0, worldChange, `journal must close for item ${selfId}`);
    });

    // Trades and escrow only move value: each AFK operation nets to zero.
    const byOperation = sumBy(rows.filter((row) => Number(row.selfId) === 57), (row) => row.operation);
    ['afk-trade:buy', 'afk-trade:sell', 'afk-trade:close'].forEach((prefix) => {
        const names = [...byOperation.keys()].filter((name) => name.startsWith(prefix));
        names.forEach((name) => assert.strictEqual(byOperation.get(name), 0, `${name} must net to zero`));
    });
    assert.ok(rows.some((row) => row.operation === 'inventory:sync-summary:npc_liquidation'
        && Number(row.selfId) === 57 && Number(row.delta) > 0), 'the sync reason must name the operation');
    assert.ok(!rows.some((row) => row.operation === 'test:failing-update'), 'a failed statement must not be journaled');

    // A finished cold fight is journaled with who started it, the outcome, its length, actions and kills.
    const fighter = (characterId, level, karma = 0) => ({ characterId, level, stats: { karma } });
    PvpJournal.coldConflict({
        key: 'test-conflict', revenge: false, reason: 'contest', spotId: 'spot-1', npcId: 20001,
        partyIds: [null, 'party-2'], sideSizes: [1, 2], outcome: 'pvp_killed', fought: true,
        principals: [fighter(ownerId, 30), fighter(customerId, 28, 120)],
        losingSide: 1, kills: [{ victimId: customerId, pvp: true }, { victimId: 9, pvp: false }],
        durationMs: 4200, actions: 12, personaFor: () => ({ archetype: 'brawler' }), at: Date.now()
    });
    const actor = (id, level, karma) => ({ fetchId: () => id, fetchLevel: () => level, fetchKarma: () => karma });
    PvpJournal.hotKill({ attacker: actor(ownerId, 30, 0), victim: actor(customerId, 29, 0), pk: true,
        attackerKarma: 0, playerInvolved: true, at: Date.now() });
    await Database.flushJournals();
    const [hot] = await Database.readHistory(["SELECT * FROM pvp_conflicts WHERE source = 'hot'"], 'test:pvp-hot');
    assert.strictEqual(hot.outcome, 'pk');
    assert.strictEqual(hot.playerInvolved, 1);
    const [conflict] = await Database.readHistory(['SELECT * FROM pvp_conflicts WHERE conflictKey = ?', ['test-conflict']], 'test:pvp');
    assert.strictEqual(conflict.initiatorId, ownerId);
    assert.strictEqual(conflict.targetKarma, 120);
    assert.strictEqual(conflict.sideSizes, '1:2');
    assert.strictEqual(conflict.kills, 2);
    assert.strictEqual(conflict.pkKills, 1);
    assert.strictEqual(conflict.initiatorArchetype, 'brawler');
    assert.strictEqual(conflict.matchup, 'solo_vs_party');
    assert.strictEqual(conflict.losingSide, 1);
    assert.strictEqual(conflict.durationMs, 4200);
    assert.strictEqual(conflict.actions, 12);
    const [summary] = await Database.readHistory([
        "SELECT * FROM pvp_conflict_hour WHERE source = 'cold' AND outcome = 'pvp_killed'"
    ], 'test:pvp-hour');
    assert.strictEqual(summary.conflicts, 1);
    assert.strictEqual(summary.pkKills, 1);

    // The triggers live only on the server's connection: another tool may still write.
    const other = new DatabaseSync(databasePath);
    other.exec(`UPDATE items SET amount = amount + 1 WHERE characterId = ${ownerId} AND selfId = 57`);
    other.close();

    await Database.close();
    clean();
    console.log('economy journal tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
