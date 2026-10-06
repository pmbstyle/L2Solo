// N79 line observations survive bounded history replay, backlog and retention.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const { shared: channel } = require('../src/GameServer/Bot/Population/ColdTableChannel');
const TableMirror = require('../src/GameServer/Bot/Population/TableMirror');
const databasePath = path.join(process.cwd(), 'tmp', 'test-market-restart-cursors.sqlite');
const historyPath = databasePath.replace(/\.sqlite$/, '.history.sqlite');
const old = Date.now() - 48 * 3600000;
const PRICING_COLUMNS = ['fills', 'pricingPrice', 'pricingSeenCounter', 'pricingSeenItem', 'pricingRival',
    'pricingWorth', 'pricingSeenFills'];

function clean() {
    for (const file of [databasePath, historyPath]) for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(file + suffix, { force: true });
    }
}
async function bot(label, { player = false } = {}) {
    const account = `${player ? 'player' : 'bot'}_cursor_${label}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name: `Cursor${label}`, race: 0, classId: 0,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 83000, locY: 148000, locZ: -3466 })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000, equipped: false, enchant: 0, slot: 0 });
    const stock = Number((await Database.setItem(id, { selfId: 1864, name: 'Stem', amount: 10,
        equipped: false, enchant: 0, slot: 0 })).insertId);
    if (!player) await LifeState.upsertState({ characterId: id, accountName: account, name: `Cursor${label}`,
        phase: 'cold', activity: 'hunting', level: 40, adena: 10000,
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)), currentRegion: 'Giran',
        loc: { locX: 83000, locY: 148000, locZ: -3466 }, stats: { generatedCold: true }, timing: {},
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } }, 'cursor_seed');
    return { id, stock };
}
async function storedStats(id) {
    const saved = JSON.parse((await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [id]]))[0].statsJson);
    const rows = await Database.execute(['SELECT counter,deals FROM bot_market_counts WHERE characterId=?', [id]]);
    return { ...saved, marketTrades: Object.fromEntries(rows.map(row => [row.counter, Number(row.deals)])) };
}
async function storedShop(id) { return (await Database.fetchAfkTradeShops(id))[0]; }
async function trade(eventKey, occurredAt, fields = {}) {
    return Database.recordMarketTrade({ eventKey, occurredAt, selfId: 1864, unitPrice: 100, quantity: 1,
        sourceType: 'afk_bot_store', channel: 'bot_wts', town: 'Giran', sellerCharacterId: 999, buyerCharacterId: 998, ...fields });
}
async function restart() {
    AfkTrade._resetForTests();
    await Database.close();
    Database.init();
    assert(Database.isReady());
    for (const row of await Database.execute(['SELECT * FROM bot_life_state'])) LifeState.acceptLifecycleRow(row);
    await AfkTrade.init();
    return Database.fetchRecentBoardDeals({ perItem: MarketCounters.REPLAY_DEALS });
}
async function run() {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    options.default.Database.historyPath = historyPath;
    Database.init();
    assert(Database.isReady());
    DataCache.init();
    invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
    await LifeState.init();
    const owner = await bot('Owner');
    const buyer = await bot('Buyer');
    const inactive = await bot('Inactive');
    const player = await bot('Player', { player: true });
    for (let i = 0; i < 100; i++) await trade(`cursor:old:${i}`, old - (100 - i) * 60000);
    await trade('cursor:other', old + 3000, { selfId: 1865 });
    const sell = await Database.createAfkTradeShop(owner.id, { storeType: 1, town: 'Giran',
        lines: [{ objectId: owner.stock, selfId: 1864, name: 'Stem', count: 10, price: 100, stackable: true }] });
    await Database.createAfkTradeShop(buyer.id, { kind: 'buy_ad', storeType: 3, town: 'Giran',
        lines: [{ selfId: 1864, name: 'Stem', count: 10, price: 90, stackable: true }] });
    await Database.createAfkTradeShop(player.id, { storeType: 1, town: 'Giran',
        lines: [{ objectId: player.stock, selfId: 1864, name: 'Stem', count: 10, price: 100, stackable: true }] });
    const legacy = { t: 48, at: old, n: 3, b: Array.from({ length: 48 }, (_, i) =>
        [1864 + i, 4.6, 5, 1, 48, 0, 0.1, 3, 100, 90, 32, 33, 120]) };
    for (const { id } of [owner, buyer, inactive]) await Database.execute([
        "UPDATE bot_life_state SET statsJson = json_set(statsJson, '$.priceBeliefs', json(?), '$.otherKnowledge', json(?)) WHERE characterId = ?",
        [JSON.stringify(legacy), JSON.stringify({ marker: 17 }), id]
    ]);
    await Database.close();
    // Only the disposable fixture returns to schema56 before migration57.
    const fixture = new DatabaseSync(databasePath);
    fixture.prepare('DELETE FROM schema_migrations WHERE version = 57').run();
    const columns = new Set(fixture.prepare('PRAGMA table_info(afk_trade_lines)').all().map(column => column.name));
    for (const column of PRICING_COLUMNS) if (columns.has(column)) fixture.exec(`ALTER TABLE afk_trade_lines DROP COLUMN ${column}`);
    fixture.exec(`CREATE TRIGGER cursor_migration_failure BEFORE UPDATE OF statsJson ON bot_life_state
        WHEN NEW.characterId = ${buyer.id} BEGIN SELECT RAISE(ABORT, 'injected N79 migration failure'); END`);
    fixture.close();
    // Keep the fatal reporter from exiting before the native rollback can be
    // inspected. The migration/connection cleanup itself runs unchanged.
    const fatal = utils.infoFail;
    utils.infoFail = (_prefix, message, error) => assert.match(`${message} ${error}`, /injected N79 migration failure/);
    try { Database.init(); } finally { utils.infoFail = fatal; }
    assert.strictEqual(Database.isReady(), false, 'numbered migration failure must close the connection');
    process.exitCode = 0;
    await Database.close();
    const rolledBack = new DatabaseSync(databasePath);
    assert.strictEqual(rolledBack.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 57').get().n, 0);
    assert(!rolledBack.prepare('PRAGMA table_info(afk_trade_lines)').all().some(column => column.name === 'fills'));
    for (const { id } of [owner, buyer, inactive]) {
        assert.deepStrictEqual(JSON.parse(rolledBack.prepare('SELECT statsJson FROM bot_life_state WHERE characterId = ?').get(id).statsJson).priceBeliefs,
            legacy, 'failed migration must not delete only some bot books');
    }
    rolledBack.exec('DROP TRIGGER cursor_migration_failure');
    rolledBack.close();
    Database.init();
    assert(Database.isReady());
    for (const row of await Database.execute(['SELECT * FROM bot_life_state'])) LifeState.acceptLifecycleRow(row);
    await AfkTrade.init();
    for (const { id } of [owner, buyer, inactive]) {
        const stats = await storedStats(id);
        assert.strictEqual(stats.priceBeliefs, undefined);
        assert.deepStrictEqual(stats.otherKnowledge, { marker: 17 });
        assert.strictEqual(LifeState.cachedState(id).stats.priceBeliefs, undefined);
    }
    const migrated = await storedShop(owner.id);
    assert.strictEqual(migrated.id, sell.shop.id);
    const checkpoint = { price: 100, seenCounter: 101, seenItem: 100, rival: 0, worth: 0, seenFills: 0 };
    assert.deepStrictEqual(migrated.lines[0].pricing, checkpoint);
    assert.strictEqual(migrated.revision, 1);
    assert.strictEqual((await storedShop(buyer.id)).escrowAdena, 900);
    assert.strictEqual((await storedShop(buyer.id)).lines[0].pricing.worth, 90,
        'migrated BUY keeps its authored bid as a conservative worth floor');
    assert.strictEqual((await storedShop(player.id)).lines[0].pricing, undefined);
    assert.strictEqual((await Database.initializeBoardPricing()).initialized, 0);
    assert.strictEqual((await Database.execute(["SELECT value FROM world_meta WHERE key = 'botMarketTradesInitialized'"]))[0].value, 'history',
        'startup explicitly seeds retained history before line pricing');
    console.log('schema57 rollback, single book removal, unrelated stats and durable line initialization: pass');
    await Database.buyFromAfkTradeShop(buyer.id, { shopId: migrated.id, ownerId: owner.id,
        lineId: migrated.lines[0].id, amount: 1, expectedPrice: 100, expectedRevision: 1 });
    await trade('cursor:unseen', old + 4000, { sellerCharacterId: owner.id, buyerCharacterId: buyer.id });
    await trade('cursor:unseen', old + 4000, { sellerCharacterId: owner.id, buyerCharacterId: buyer.id });
    await Database.flushHistory();
    await trade('cursor:unseen', old + 4000, { sellerCharacterId: owner.id, buyerCharacterId: buyer.id });
    for (let round = 0; round < 2; round++) {
        const replay = await restart();
        assert.strictEqual(replay.filter(row => Number(row.selfId) === 1864).length, MarketCounters.REPLAY_DEALS);
        assert.strictEqual(MarketCounters.itemDeals(1864).deals, 102);
        assert.strictEqual(MarketCounters.counter('material none').deals, 103);
        assert.deepStrictEqual((await storedShop(owner.id)).lines[0].pricing, checkpoint);
        assert.strictEqual((await storedShop(owner.id)).lines[0].fills, 1);
        assert.strictEqual((await storedStats(owner.id)).marketTrades['material none'], 1,
            'journal import/dedup must not fabricate actual own deals');
    }
    const worker = new BoardIndex();
    const mirror = new TableMirror();
    mirror.watch('board', worker.follower());
    channel.attach('cursor-worker', '1', payload => { mirror.apply(payload.tables); return true; });
    channel.flush();
    const line = AfkTrade.boardIndex().ownerLines(owner.id)[0];
    assert.deepStrictEqual(worker.ownerLines(owner.id)[0].pricing, line.pricing);
    assert.strictEqual(worker.ownerLines(owner.id)[0].fills, 1);
    const consumed = { ...checkpoint, seenCounter: 103, seenItem: 102, seenFills: 1 };
    const updated = await AfkTrade.repriceBotLines(owner.id, [], { updates: [{ recordId: line.recordId,
        lineId: line.lineId, expectedRevision: line.revision, previousPricing: line.pricing, pricing: consumed }] });
    assert.strictEqual(updated.changed, 0);
    assert.strictEqual(updated.updated, 1);
    const buyLine = AfkTrade.boardIndex().ownerLines(buyer.id)[0];
    const buyState = { ...buyLine.pricing, seenCounter: 103, seenItem: 102 };
    await AfkTrade.repriceBotLines(buyer.id, [], { updates: [{ recordId: buyLine.recordId, lineId: buyLine.lineId,
        expectedRevision: buyLine.revision, previousPricing: buyLine.pricing, pricing: buyState }] });
    assert.strictEqual((await storedShop(buyer.id)).lines[0].pricing.worth, 90);
    assert.strictEqual((await storedShop(buyer.id)).escrowAdena, 900, 'first counter observation cannot lose a migrated BUY escrow');
    channel.flush();
    assert.deepStrictEqual(worker.ownerLines(owner.id)[0].pricing, consumed, 'worker receives metadata-only change');
    channel.detach('cursor-worker');
    for (let round = 0; round < 2; round++) {
        await restart();
        assert.deepStrictEqual((await storedShop(owner.id)).lines[0].pricing, consumed);
        assert.strictEqual((await storedShop(owner.id)).lines[0].fills - consumed.seenFills, 0);
    }
    await Database.execute(["DELETE FROM world_meta WHERE key IN ('boardDealCountsReady', 'boardCounterCountsReady') OR key LIKE 'boardDealCount:%' OR key LIKE 'boardCounterDealCount:%'"]);
    // Readiness is cached until reopen; this fixture starts the next upgrade boundary.
    await Database.close();
    Database.init();
    const pending = (eventKey, selfId = 1864) => ({ eventKey, occurredAt: old + 6500, selfId, unitPrice: 100,
        quantity: 1, sourceType: 'afk_bot_store', sellerCharacterId: owner.id, buyerCharacterId: buyer.id });
    await Database.execute(["INSERT INTO history_outbox (kind, payload) VALUES ('market_trade', ?), ('market_trade', ?)",
        [JSON.stringify(pending('cursor:unseen', 1872)), JSON.stringify(pending('cursor:pending'))]]);
    await trade('cursor:bootstrap-live', old + 6600, { sellerCharacterId: owner.id, buyerCharacterId: buyer.id });
    await restart();
    assert.strictEqual(MarketCounters.itemDeals(1864).deals, 104);
    assert.strictEqual(MarketCounters.itemDeals(1872).deals, 0);
    assert.strictEqual(MarketCounters.counter('material none').deals, 105);
    assert.deepStrictEqual((await storedShop(owner.id)).lines[0].pricing, consumed);
    await Database.close();
    const history = new DatabaseSync(historyPath);
    history.prepare("DELETE FROM market_trades WHERE eventKey LIKE 'cursor:old:%'").run();
    history.close();
    Database.init();
    assert(Database.isReady());
    await AfkTrade.init();
    assert.strictEqual(MarketCounters.itemDeals(1864).deals, 104);
    assert.strictEqual(MarketCounters.counter('material none').deals, 105);
    await trade('cursor:after-prune', old + 7000, { sellerCharacterId: owner.id, buyerCharacterId: buyer.id });
    await restart();
    assert.strictEqual(MarketCounters.itemDeals(1864).deals, 105);
    assert.strictEqual(MarketCounters.counter('material none').deals, 106);
    assert.deepStrictEqual((await storedShop(owner.id)).lines[0].pricing, consumed);
    console.log('N79 restart cursors: bounded replay, line fills, worker metadata, backlog deduplication and retention: pass');

    // Seed policy is explicit and independent. These are two disposable
    // scenarios, not a choice for the running world.
    // This disposable scenario reopens the one-time initializer independently
    // of the startup choice already verified above. Existing learned owners stay.
    await Database.execute(["DELETE FROM world_meta WHERE key = 'botMarketTradesInitialized'"]);
    await Database.execute(['DELETE FROM bot_market_counts WHERE characterId=?', [inactive.id]]);
    const legacyOwner = await bot('HistorySeed');
    await trade('cursor:seed', old + 9000, { sellerCharacterId: legacyOwner.id, buyerCharacterId: player.id });
    await trade('cursor:seed', old + 9000, { sellerCharacterId: legacyOwner.id, buyerCharacterId: player.id });
    await Database.execute([`CREATE TEMP TRIGGER cursor_seed_failure BEFORE INSERT ON main.bot_market_counts
        WHEN NEW.characterId = ${legacyOwner.id} BEGIN SELECT RAISE(ABORT, 'injected seed failure'); END`]);
    try { await assert.rejects(Database.initializeBotMarketTrades('history'), /injected seed failure/); }
    finally { await Database.execute(['DROP TRIGGER temp.cursor_seed_failure']); }
    assert.deepStrictEqual((await storedStats(inactive.id)).marketTrades, {}, 'seed rollback must include earlier bot rows');
    assert.strictEqual((await Database.execute(["SELECT COUNT(*) AS n FROM world_meta WHERE key = 'botMarketTradesInitialized'"]))[0].n, 0);
    const seeded = await Database.initializeBotMarketTrades('history');
    assert.strictEqual(seeded.skipped, false);
    assert.strictEqual((await storedStats(legacyOwner.id)).marketTrades['material none'], 1, 'historical seed counts canonical deals once');
    assert.strictEqual((await storedStats(owner.id)).marketTrades['material none'], 1, 'seed cannot replace already committed own counts');
    assert.strictEqual((await Database.initializeBotMarketTrades('history')).skipped, true);
    assert.strictEqual((await Database.initializeBotMarketTrades('zero')).mode, 'history', 'later calls cannot silently change a chosen seed');
    await assert.rejects(Database.initializeBotMarketTrades(undefined), /invalid_market_trades_seed/);
    await Database.close();
    clean();
    Database.init();
    assert(Database.isReady());
    const zeroOwner = await bot('ZeroSeed');
    await trade('cursor:zero-seed', old, { sellerCharacterId: zeroOwner.id });
    assert.strictEqual((await Database.initializeBotMarketTrades('zero')).skipped, false);
    assert.deepStrictEqual((await storedStats(zeroOwner.id)).marketTrades, {}, 'zero seed deliberately ignores historical deals');
    assert.strictEqual((await Database.initializeBotMarketTrades('zero')).skipped, true);
    console.log('Explicit own-trade seed: history/zero, canonical identity, rollback and idempotency: pass');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    channel.detach('cursor-worker');
    AfkTrade._resetForTests();
    MarketCounters.reset();
    await Database.close();
    clean();
});
