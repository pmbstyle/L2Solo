// The market counters replayed at start (AfkTradeService.init ->
// Database.fetchRecentBoardDeals -> MarketCounters.load) see what the running
// server counted: the board's own deals only (E57), however long the server
// was stopped (E58: the counters decay on uptime; a wall-clock window of the
// last day emptied them after a long stop).
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
const replay = () => Database.fetchRecentBoardDeals({ perItem: MarketCounters.REPLAY_DEALS });

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    invoke('GameServer/DataCache').init();
    const now = Date.now();
    // The server stopped ten days ago.
    const stoppedAt = now - 10 * 24 * HOUR;

    // A board sale and a buy-ad fill are the board's own deals; a private
    // store, a configured merchant store and a static buyer write the same
    // or similar channels and are not.
    await trade(stoppedAt - 3 * HOUR, { channel: 'bot_wts', sourceType: 'afk_bot_store', unitPrice: 100 });
    await trade(stoppedAt - 2 * HOUR, { channel: 'wtb', sourceType: 'afk_bot_buy_store', unitPrice: 90 });
    await trade(stoppedAt - 2 * HOUR, { channel: 'wts', sourceType: 'private_store', unitPrice: 5000 });
    await trade(stoppedAt - 2 * HOUR, { channel: 'wtb', sourceType: 'private_buy_store', unitPrice: 5000 });
    await trade(stoppedAt - 2 * HOUR, { channel: 'wts', sourceType: 'cold_store', unitPrice: 5000 });
    await trade(stoppedAt - 2 * HOUR, { channel: 'static_wtb', sourceType: 'static_buy_store', unitPrice: 5000 });
    let rows = await replay();
    assert.deepStrictEqual(rows.map((row) => row.unitPrice), [100, 90], 'only board deals are replayed, however old');
    MarketCounters.reset();
    MarketCounters.load(rows);
    assert.deepStrictEqual(MarketCounters.itemDeals(1864).prices, [100, 90]);
    assert.strictEqual(MarketCounters.counter('material none', now).deals, 2);

    // Animal Bone sold 40 times three days before the stop: the replay takes
    // its last REPLAY_DEALS (as many as an item keeps prices and a counter's
    // index weighs), oldest first.
    for (let deal = 0; deal < 40; deal++) {
        await trade(stoppedAt - 3 * 24 * HOUR - (40 - deal) * 60000, { selfId: 1872, itemName: 'Animal Bone',
            channel: 'bot_wts', sourceType: 'afk_bot_store', unitPrice: 1000 + deal });
    }
    rows = await replay();
    const bones = rows.filter((row) => row.selfId === 1872);
    assert.strictEqual(MarketCounters.REPLAY_DEALS, 32);
    assert.deepStrictEqual(bones.map((row) => row.unitPrice), Array.from({ length: 32 }, (_, at) => 1008 + at),
        'the last deals of an item, however old');
    MarketCounters.reset();
    MarketCounters.load(bones);
    assert.strictEqual(MarketCounters.itemDeals(1872).prices.length, 21, 'the item keeps its last prices');
    assert.strictEqual(MarketCounters.itemDeals(1872).prices[20], 1039);
    const counter = MarketCounters.counter(MarketCounters.counterOf(1872), now);
    assert.strictEqual(counter.deals, 40, 'bounded price replay preserves the durable observation count');
    assert(counter.index !== null, 'the counter keeps its market index');

    // The day before the last board deal comes back whole: the buyers per
    // hour of a busy item need more than its last deals. 60 Stem deals in
    // the hour before the stop.
    for (let deal = 0; deal < 60; deal++) {
        await trade(stoppedAt - 4 * HOUR - (60 - deal) * 60000, { channel: 'bot_wts', sourceType: 'afk_bot_store',
            unitPrice: 100 });
    }
    rows = await replay();
    assert.strictEqual(rows.filter((row) => row.selfId === 1864).length, 62, 'every deal of the day before the last one');
    const all = await Database.readHistory([`SELECT selfId, unitPrice, quantity, occurredAt, sellerCharacterId,
        buyerCharacterId, town FROM market_trades WHERE sourceType LIKE 'afk%' ORDER BY occurredAt, id`]);
    MarketCounters.reset();
    MarketCounters.load(all);
    const live = MarketCounters.counter('material none', now).perHour;
    MarketCounters.reset();
    MarketCounters.load(rows);
    assert(live > 1 && Math.abs(MarketCounters.counter('material none', now).perHour - live) < 1e-9,
        'the buyers per hour stand as the running server had them at the stop');

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
