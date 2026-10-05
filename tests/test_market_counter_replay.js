// The market counters replayed at start (AfkTradeService.init ->
// Database.fetchRecentBoardDeals -> MarketCounters.load) see what the running
// server counted: the board's own deals only (E57).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const databasePath = path.join(process.cwd(), 'tmp', 'test-market-counter-replay.sqlite');
const historyPath = databasePath.replace(/\.sqlite$/, '.history.sqlite');

function clean() {
    for (const file of [databasePath, historyPath]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

const HOUR = 60 * 60 * 1000;
let sequence = 0;
function trade(at, fields) {
    return Database.recordMarketTrade({
        eventKey: `replay:${++sequence}`, at, selfId: 1864, itemName: 'Stem', town: 'Giran', quantity: 1,
        seller: { characterId: 10, name: 'Seller' }, buyer: { characterId: 11, name: 'Buyer' }, ...fields
    });
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    invoke('GameServer/DataCache').init();
    const now = Date.now();
    // A board sale and a buy-ad fill: the board's own deals.
    await trade(now - 3 * HOUR, { channel: 'bot_wts', sourceType: 'afk_bot_store', unitPrice: 100 });
    await trade(now - 2 * HOUR, { channel: 'wtb', sourceType: 'afk_bot_buy_store', unitPrice: 90 });
    // A private store and a configured merchant store write the same channels.
    await trade(now - HOUR, { channel: 'wts', sourceType: 'private_store', unitPrice: 5000 });
    await trade(now - HOUR, { channel: 'wtb', sourceType: 'private_buy_store', unitPrice: 5000 });
    await trade(now - HOUR, { channel: 'wts', sourceType: 'cold_store', unitPrice: 5000 });
    await trade(now - HOUR, { channel: 'static_wtb', sourceType: 'static_buy_store', unitPrice: 5000 });

    const rows = await Database.fetchRecentBoardDeals({ timestamp: now });
    assert.deepStrictEqual(rows.map((row) => row.unitPrice), [100, 90], 'only board deals are replayed');
    MarketCounters.reset();
    MarketCounters.load(rows);
    assert.deepStrictEqual(MarketCounters.itemDeals(1864).prices, [100, 90]);
    assert.strictEqual(MarketCounters.counter('material none', now).deals, 2);

    MarketCounters.reset();
    await Database.close();
    clean();
    console.log('Market counter replay checks passed');
})().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) { /* cleanup only */ }
    clean();
    process.exitCode = 1;
});
