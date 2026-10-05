// Persisted beliefs and bounded replay agree across DB restarts. Legacy
// knowledge is kept; ambiguous old evidence is checkpointed before trading.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const { ColdTableChannel } = require('../src/GameServer/Bot/Population/ColdTableChannel');
const TableMirror = require('../src/GameServer/Bot/Population/TableMirror');
const databasePath = path.join(process.cwd(), 'tmp', 'test-market-restart-cursors.sqlite');
const historyPath = databasePath.replace(/\.sqlite$/, '.history.sqlite');
const old = Date.now() - 48 * 3600000;
let owner;
let buyer;
function clean() {
    for (const file of [databasePath, historyPath]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}
async function bot(label) {
    const account = `bot_cursor_${label}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name: `Cursor${label}`, race: 0, classId: 0,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 83000, locY: 148000, locZ: -3466 })).insertId);
    await LifeState.upsertState({ characterId: id, accountName: account, name: `Cursor${label}`,
        phase: 'cold', activity: 'hunting', level: 40, adena: 0, inventory: {}, currentRegion: 'Giran',
        loc: { locX: 83000, locY: 148000, locZ: -3466 }, stats: { generatedCold: true }, timing: {},
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } }, 'cursor_seed');
    return id;
}
async function saveBook(id, book) {
    const state = LifeState.cachedState(id);
    await LifeState.upsertState({ ...state, stats: { ...state.stats, priceBeliefs: book, otherKnowledge: { marker: 17 } } }, 'market_cursor_save');
}
async function storedBook(id) {
    const row = (await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [id]]))[0];
    const stats = JSON.parse(row.statsJson);
    assert.deepStrictEqual(stats.otherKnowledge, { marker: 17 });
    return stats.priceBeliefs;
}
async function trade(eventKey, occurredAt, fields = {}) {
    return Database.recordMarketTrade({ eventKey, occurredAt, selfId: 1864, unitPrice: 100, quantity: 1,
        sourceType: 'afk_bot_store', channel: 'bot_wts', town: 'Giran', sellerCharacterId: 999, buyerCharacterId: 998, ...fields });
}
async function restart() {
    AfkTrade._resetForTests();
    await Database.close();
    Database.init();
    // Isolated startup barrier; no listeners or population workers.
    await AfkTrade.init();
    return Database.fetchRecentBoardDeals({ perItem: MarketCounters.REPLAY_DEALS });
}
function context(characterId, timestamp = old + 5000) {
    return { characterId, understanding: 0.5, timestamp, board: new BoardIndex({ groupOf: MarketCounters.counterOf }) };
}
function observe(saved, side, timestamp = old + 5000) {
    const book = PriceBelief.readBook({ priceBeliefs: saved });
    const belief = book.beliefs.get(1864);
    const result = side === 'sell'
        ? PriceBelief.lookObservations(book, belief, context(owner, timestamp), { ask: 100, lines: 1 })
        : PriceBelief.bidObservations(book, belief, context(buyer, timestamp), { bid: 100, lines: 1 });
    book.lookAt = timestamp;
    return { result, saved: PriceBelief.writeBook(book) };
}

function proveLegacyAmbiguity() {
    const histories = [true, false].map(alreadySeen => {
        MarketCounters.reset();
        const history = Array.from({ length: 100 }, (_, index) => ({ selfId: 1864, unitPrice: 100, quantity: 1,
            occurredAt: index === 99 ? old + 1000 : old - (100 - index) * 60000,
            sellerCharacterId: index === 99 ? 555001 : 999 }));
        MarketCounters.load((alreadySeen ? history : history.slice(0, 99)).slice(-32));
        MarketCounters.deal(123, 5000, 1, old - 1000, 999);
        const book = PriceBelief.readBook({});
        PriceBelief.ensure(book, 1864, context(555001, alreadySeen ? old + 2000 : old)).ask = 100;
        if (!alreadySeen) MarketCounters.deal(1864, 100, 1, old + 1000, 555001);
        PriceBelief.ensure(book, 123, context(555001, old + 5000)).ask = 5000;
        book.lookAt = old + 5000;
        const checkpointed = PriceBelief.writeBook(book);
        const legacy = structuredClone(checkpointed);
        legacy.b = legacy.b.map(row => row.slice(0, 13));
        return { legacy, observedA: alreadySeen ? old + 2000 : old, expectedUnseenA: alreadySeen ? 0 : 1 };
    });
    assert.deepStrictEqual(histories[0].legacy, histories[1].legacy, 'identical old books can require opposite unseen outcomes');
    assert.notStrictEqual(histories[0].observedA, histories[1].observedA);
    assert.notStrictEqual(histories[0].expectedUnseenA, histories[1].expectedUnseenA);
    MarketCounters.reset();
}
async function run() {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    invoke('GameServer/DataCache').init();
    proveLegacyAmbiguity();
    invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
    await LifeState.init();
    owner = await bot('Seller');
    buyer = await bot('Buyer');
    const inactive = await bot('Inactive');
    for (let index = 0; index < 100; index++) await trade(`cursor:old:${index}`, old - (100 - index) * 60000,
        { sellerCharacterId: owner, buyerCharacterId: buyer });
    await trade('cursor:other', Date.now(), { selfId: 1865 });
    const rows = await restart();
    assert.strictEqual(rows.filter(row => row.selfId === 1864).length, 32);
    assert.strictEqual(MarketCounters.itemDeals(1864).deals, 100);
    const book = PriceBelief.readBook({});
    PriceBelief.ensure(book, 1864, context(owner, old)).ask = 100;
    PriceBelief.ensure(book, 123, context(owner, old + 3000)).ask = 5000;
    book.lookAt = old + 3000;
    const legacy = PriceBelief.writeBook(book);
    legacy.b = legacy.b.map(row => row.slice(0, 13));
    legacy.b.find(row => row[0] === 1864)[10] = 32;
    legacy.b.find(row => row[0] === 1864)[11] = 33;
    const inactiveLegacy = { ...legacy, b: Array.from({ length: PriceBelief.BOUND }, (_, index) => {
        const row = [...legacy.b[0]];
        row[0] = 1864 + index;
        return row;
    }) };
    const legacyByOwner = new Map([[owner, legacy], [buyer, legacy], [inactive, inactiveLegacy]]);
    for (const [id, original] of legacyByOwner) await saveBook(id, original);
    // A later row failure aborts the whole startup checkpoint, so no owner
    // can be partially normalized and no worker cache sees a partial result.
    AfkTrade._resetForTests();
    await Database.execute([`CREATE TEMP TRIGGER cursor_migration_failure
        BEFORE UPDATE OF statsJson ON main.bot_life_state WHEN NEW.characterId = ${buyer}
        BEGIN SELECT RAISE(ABORT, 'injected cursor migration failure'); END`]);
    try { await assert.rejects(AfkTrade.init(), /injected cursor migration failure/); }
    finally { await Database.execute(['DROP TRIGGER temp.cursor_migration_failure']); }
    for (const id of [owner, buyer, inactive]) {
        assert.deepStrictEqual(await storedBook(id), legacyByOwner.get(id));
        assert.deepStrictEqual(LifeState.cachedState(id).stats.priceBeliefs, legacyByOwner.get(id));
    }
    // All legacy beliefs are saved before trading, including inactive ones.
    await restart();
    const checkpoint = await storedBook(owner);
    for (const id of [owner, buyer, inactive]) {
        const saved = await storedBook(id);
        const original = legacyByOwner.get(id);
        assert.deepStrictEqual([saved.t, saved.at, saved.n], [original.t, original.at, original.n]);
        for (let index = 0; index < saved.b.length; index++) {
            assert.deepStrictEqual(saved.b[index].slice(0, 10), original.b[index].slice(0, 10));
            assert.strictEqual(saved.b[index][12], original.b[index][12]);
            assert.strictEqual(saved.b[index][13], 2);
        }
        assert.strictEqual(saved.b.find(row => row[0] === 1864)[10], 100);
        assert.strictEqual(saved.b.find(row => row[0] === 1864)[11], 101);
        assert.deepStrictEqual(LifeState.cachedState(id).stats.priceBeliefs, saved, 'main cache follows durable migration');
    }
    const largeCheckpoint = await storedBook(inactive);
    assert.strictEqual(largeCheckpoint.b.length, 48);
    console.log(JSON.stringify({ case: '48 legacy beliefs payload', legacyBytes: JSON.stringify(inactiveLegacy).length,
        checkpointBytes: JSON.stringify(largeCheckpoint).length, deltaBytes: JSON.stringify(largeCheckpoint).length
            - JSON.stringify(inactiveLegacy).length, basisFieldBytes: 2 * 48 }));
    assert.deepStrictEqual(observe(checkpoint, 'sell').result, { observations: [], sales: 0 });
    assert.deepStrictEqual(observe(checkpoint, 'buy').result, { observations: [], fills: 0 });
    assert.deepStrictEqual((await Database.migrateBoardBeliefCursors()).rows, [], 'migration applies once');
    // Sale before the first legacy look; restart twice before observing it.
    await trade('cursor:unseen', old + 4000, { sellerCharacterId: owner, buyerCharacterId: buyer });
    await trade('cursor:unseen', old + 4000, { sellerCharacterId: owner, buyerCharacterId: buyer });
    await Database.flushHistory();
    await trade('cursor:unseen', old + 4000, { sellerCharacterId: owner, buyerCharacterId: buyer });
    for (let round = 0; round < 2; round++) {
        await restart();
        assert.strictEqual(MarketCounters.itemDeals(1864).deals, 101);
        assert.deepStrictEqual(await storedBook(owner), checkpoint, 'later startup cannot move the first checkpoint');
        assert.strictEqual(observe(await storedBook(owner), 'sell').result.sales, 1);
        assert.strictEqual(observe(await storedBook(buyer), 'buy').result.fills, 1);
    }
    // A later look at B cannot consume the still-unseen sale of A.
    const otherBook = PriceBelief.readBook({ priceBeliefs: checkpoint });
    const a = otherBook.beliefs.get(1864);
    const oldACursors = [a.seenItem, a.seenCounter, a.cursorBasis];
    PriceBelief.lookObservations(otherBook, otherBook.beliefs.get(123), context(owner, old + 4500), { ask: 5000, lines: 1 });
    otherBook.lookAt = old + 4500;
    assert.deepStrictEqual([a.seenItem, a.seenCounter, a.cursorBasis], oldACursors);
    assert.strictEqual(observe(PriceBelief.writeBook(otherBook), 'sell').result.sales, 1);
    const channel = new ColdTableChannel();
    const mirror = new TableMirror();
    channel.attach('cursor-worker', '1', payload => { mirror.apply(payload.tables); return true; });
    MarketCounters.publish(channel);
    channel.flush();
    const main = observe(checkpoint, 'sell');
    MarketCounters.useTable(() => mirror.rows('market'));
    const worker = observe(LifeState.cachedState(owner).stats.priceBeliefs, 'sell');
    assert.deepStrictEqual(worker.result, main.result);
    assert.deepStrictEqual(worker.saved, main.saved);
    const consumedSale = worker.saved;
    const consumedBuy = observe(await storedBook(buyer), 'buy').saved;
    await saveBook(owner, consumedSale);
    await saveBook(buyer, consumedBuy);
    for (let round = 0; round < 2; round++) {
        await restart();
        assert.deepStrictEqual(observe(await storedBook(owner), 'sell', old + 6000).result, { observations: [], sales: 0 });
        assert.deepStrictEqual(observe(await storedBook(buyer), 'buy', old + 6000).result, { observations: [], fills: 0 });
    }
    // Bootstrap history plus pending outbox, including a duplicate with a
    // different item. Only this fixture's metadata is removed.
    await Database.execute(["DELETE FROM world_meta WHERE key = 'boardDealCountsReady' OR key LIKE 'boardDealCount:%'"]);
    const pending = (eventKey, selfId = 1864) => ({ eventKey, occurredAt: old + 6500, selfId, unitPrice: 100,
        quantity: 1, sourceType: 'afk_bot_store', sellerCharacterId: owner, buyerCharacterId: buyer });
    await Database.execute(["INSERT INTO history_outbox (kind, payload) VALUES ('market_trade', ?), ('market_trade', ?)",
        [JSON.stringify(pending('cursor:unseen', 1872)), JSON.stringify(pending('cursor:pending'))]]);
    await trade('cursor:bootstrap-live', old + 6600, { sellerCharacterId: owner, buyerCharacterId: buyer });
    await restart();
    assert.strictEqual(MarketCounters.itemDeals(1864).deals, 103);
    assert.strictEqual(MarketCounters.itemDeals(1872).deals, 0);
    assert.strictEqual(observe(consumedSale, 'sell', old + 6800).result.sales, 2);
    const afterBootstrap = observe(consumedSale, 'sell', old + 6800).saved;
    await Database.close();
    const history = new DatabaseSync(historyPath);
    history.prepare("DELETE FROM market_trades WHERE eventKey LIKE 'cursor:old:%'").run();
    history.close();
    Database.init();
    await AfkTrade.init();
    assert.strictEqual(MarketCounters.itemDeals(1864).deals, 103);
    assert.strictEqual(MarketCounters.counter('material none').deals, 104);
    assert.deepStrictEqual(observe(afterBootstrap, 'sell', old + 6900).result, { observations: [], sales: 0 });
    await trade('cursor:after-prune', old + 7000, { sellerCharacterId: owner, buyerCharacterId: buyer });
    await restart();
    assert.strictEqual(MarketCounters.itemDeals(1864).deals, 104);
    assert.strictEqual(observe(afterBootstrap, 'sell', old + 8000).result.sales, 1);
    console.log('Market restart cursors: startup legacy checkpoint, preserved knowledge/cache, sale before first look, repeated restarts, worker mirror, bootstrap, retention and deduplication passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    AfkTrade._resetForTests();
    MarketCounters.reset();
    await Database.close();
    clean();
});
