const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const databasePath = path.join(process.cwd(), 'tmp', 'test-market-trade-history.sqlite');

function clean() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    const timestamp = Date.now();
    const base = {
        selfId: 1864,
        itemName: 'Stem',
        town: 'Giran',
        seller: { characterId: 10, name: 'Seller' },
        buyer: { characterId: 11, name: 'Buyer' }
    };
    const first = await Database.recordMarketTrade({
        ...base, eventKey: 'test:stem:1', at: timestamp - 23 * 60 * 60 * 1000,
        channel: 'wts', sourceType: 'cold_store', quantity: 2, unitPrice: 100
    });
    assert.strictEqual(first.inserted, true);
    const duplicate = await Database.recordMarketTrade({
        ...base, eventKey: 'test:stem:1', at: timestamp - 23 * 60 * 60 * 1000,
        channel: 'wts', sourceType: 'cold_store', quantity: 2, unitPrice: 100
    });
    assert.strictEqual(duplicate.inserted, false, 'event keys must make journal retries idempotent');
    await Database.recordMarketTrade({
        ...base, eventKey: 'test:stem:2', at: timestamp - 21 * 60 * 60 * 1000,
        channel: 'wtb', sourceType: 'cold_buy_store', quantity: 1, unitPrice: 200
    });
    await Database.recordMarketTrade({
        ...base, eventKey: 'test:stem:3', at: timestamp - 6 * 24 * 60 * 60 * 1000,
        channel: 'wts', sourceType: 'player_store', quantity: 3, unitPrice: 50, town: 'Dion'
    });
    await Database.recordMarketTrade({
        ...base, eventKey: 'test:ore:1', at: timestamp - 60 * 60 * 1000,
        selfId: 1872, itemName: 'Animal Bone', channel: 'wts', sourceType: 'player_store', quantity: 4, unitPrice: 25
    });

    const overview = await Database.fetchMarketTradeOverview({ timestamp });
    assert.strictEqual(overview.scope, 'persistent_90d');
    assert.deepStrictEqual(overview.windows.day, {
        trades: 3, units: 7, adena: 500, items: 2,
        firstAt: timestamp - 23 * 60 * 60 * 1000,
        lastAt: timestamp - 60 * 60 * 1000
    });
    assert.strictEqual(overview.windows.week.trades, 4);
    assert.strictEqual(overview.byItem.find((item) => item.selfId === 1864).trades, 3);
    assert.strictEqual(overview.byTown.Giran.trades, 3);
    assert.strictEqual(overview.byTown.Dion.trades, 1);

    const history = await Database.fetchMarketTradeHistory(1864, {
        timestamp,
        rangeMs: 24 * 60 * 60 * 1000,
        bucketMs: 60 * 60 * 1000
    });
    assert.deepStrictEqual(history.summary, {
        trades: 2,
        units: 3,
        adena: 400,
        items: 1,
        firstAt: timestamp - 23 * 60 * 60 * 1000,
        lastAt: timestamp - 21 * 60 * 60 * 1000,
        low: 100,
        high: 200,
        vwap: 133,
        median: 100
    });
    assert.strictEqual(history.buckets.length, 2);
    assert.deepStrictEqual(Object.keys(history.channels).sort(), ['wtb', 'wts']);

    const migration = await Database.execute(['SELECT version FROM schema_migrations WHERE version = 32'], 'test:market-migration');
    assert.strictEqual(migration.length, 1);
    await Database.close();
    Database.init();
    const restored = await Database.fetchMarketTradeHistory(1864, { timestamp, rangeMs: 7 * 24 * 60 * 60 * 1000 });
    assert.strictEqual(restored.summary.trades, 3, 'market history must survive a real SQLite close and reopen');
    const integrity = await Database.execute(['PRAGMA integrity_check'], 'test:market-integrity');
    assert.strictEqual(integrity[0].integrity_check, 'ok');
    await Database.close();
    clean();
    console.log('Persistent market trade history checks passed');
})().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) {}
    clean();
    process.exitCode = 1;
});
