const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex, rowOf, recordOf } = require('../src/GameServer/AfkTrade/BoardIndex');
const databasePath = path.join(process.cwd(), 'tmp', 'test-n79-board-price-state.sqlite');
const STEM = 1864;
let sequence = 0;
const failures = [];

function clean() {
    for (const file of [databasePath, databasePath.replace(/\.sqlite$/, '.history.sqlite')]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}

async function makeBot(items, { player = false } = {}) {
    const account = `${player ? 'player' : 'bot'}_n79_storage_${++sequence}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, {
        name: `N79Storage${sequence}`, race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 83000, locY: 148000, locZ: -3400
    })).insertId);
    for (const item of items) await Database.setItem(id, { equipped: false, enchant: 0, slot: 0, ...item });
    if (!player) {
        const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
        await LifeState.upsertState({ characterId: id, accountName: account, name: `N79Storage${sequence}`,
            phase: 'cold', activity: 'hunting', level: 40, adena: Number(inventory[57]?.amount || 0), inventory,
            currentRegion: 'Giran', loc: { locX: 83000, locY: 148000, locZ: -3400 },
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
            stats: { generatedCold: true }, timing: {} }, 'n79_storage_seed');
    }
    return id;
}

const adena = amount => ({ selfId: 57, name: 'Adena', amount });
const stem = amount => ({ selfId: STEM, name: 'Stem', amount });
const pricing = (price, seenCounter = 0, seenItem = 0) => ({ price, seenCounter, seenItem, rival: 90, worth: 0, seenFills: 0 });

async function sell(owner, { count = 10, price = 100, state = pricing(price), kind = 'shop' } = {}) {
    const source = (await Database.fetchItems(owner)).find(item => Number(item.selfId) === STEM);
    return (await Database.createAfkTradeShop(owner, { kind, storeType: 1, town: 'Giran',
        lines: [{ objectId: source.id, selfId: STEM, name: 'Stem', count, price, stackable: true,
            ...(state ? { pricing: state } : {}) }] })).shop;
}

const getShop = async owner => (await Database.fetchAfkTradeShops(owner))[0];
const getStats = async id => JSON.parse((await Database.execute([
    'SELECT statsJson FROM bot_life_state WHERE characterId = ?', [id]
]))[0].statsJson);
const getCounts = async id => Object.fromEntries((await Database.execute([
    'SELECT counter,deals FROM bot_market_counts WHERE characterId=?', [id]
])).map(row => [row.counter, Number(row.deals)]));
async function publishCounts(result) {
    for (const [id, counts] of Object.entries(result.marketTrades || {})) LifeState.acceptMarketTrades(id, counts);
    return result;
}
const buy = async (...args) => publishCounts(await Database.buyFromAfkTradeShop(...args));
const sellInto = async (...args) => publishCounts(await Database.sellToAfkTradeShop(...args));
const balance = async id => (await Database.fetchItems(id)).filter(item => Number(item.selfId) === 57)
    .reduce((sum, item) => sum + Number(item.amount), 0);
const move = (shop, line = shop.lines[0]) => ({ recordId: shop.id, lineId: line.id,
    expectedRevision: shop.revision, previousPricing: line.pricing });

async function run() {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    assert(Database.isReady());
    DataCache.init();
    invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
    await LifeState.init();

    await check('unchanged escrow, partial fill and stale quote contracts', async () => {
        const owner = await makeBot([stem(10)]);
        const buyer = await makeBot([adena(2000)]);
        const shop = await sell(owner);
        await buy(buyer, { shopId: shop.id, ownerId: owner, lineId: shop.lines[0].id,
            amount: 3, expectedPrice: 100, expectedRevision: shop.revision });
        assert.strictEqual((await getShop(owner)).lines[0].count, 7);
        assert.strictEqual(await balance(buyer), 1700);
        await assert.rejects(buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 3, expectedPrice: 100, expectedRevision: shop.revision }),
        /afk_trade_shop_changed/);
        assert.strictEqual((await Database.settleBoardOwner(owner)).settled, true);
        assert.strictEqual((await Database.settleBoardOwner(owner)).settled, false);
        assert.strictEqual(await balance(owner), 300);
    });

    await check('publication and main-worker board round trip retain line pricing', async () => {
        const owner = await makeBot([stem(10)]);
        const state = pricing(100, 12, 7);
        const shop = await sell(owner, { state });
        assert.deepStrictEqual(shop.lines[0].pricing, state, 'publication discarded line observation state');
        const record = recordOf(rowOf({ ...shop, botOwned: true }));
        const board = new BoardIndex();
        board.put(record);
        assert.deepStrictEqual(board.first(STEM, 1, { excludeOwner: -1 }).pricing, state);
    });

    await check('same-price observations persist without invalidating a native quote', async () => {
        const owner = await makeBot([stem(10)]);
        const shop = await sell(owner);
        const next = { ...pricing(100, 4, 2), rival: 80 };
        await Database.repriceBoardLines(owner, [], { updates: [{ ...move(shop), pricing: next }] });
        const reviewed = await getShop(owner);
        assert.deepStrictEqual(reviewed.lines[0].pricing, next, 'same-price review dropped its seen cursors');
        assert.strictEqual(reviewed.revision, shop.revision, 'metadata must leave executable quote revision unchanged');
        assert.strictEqual(reviewed.lines[0].count, 10);
        const newest = { ...next, seenCounter: 6, rival: 70 };
        await Database.repriceBoardLines(owner, [], { updates: [{ ...move(reviewed), pricing: newest }] });
        const stale = await Database.repriceBoardLines(owner, [], { updates: [{ ...move(shop), pricing: next }] });
        assert.strictEqual(stale.updated, 0);
        assert.deepStrictEqual((await getShop(owner)).lines[0].pricing, newest, 'stale unchanged-price review rewound evidence');
    });

    await check('metadata observation fences stale withdrawals while a fresh withdrawal returns stock', async () => {
        const owner = await makeBot([stem(10)]);
        const shop = await sell(owner);
        await Database.repriceBoardLines(owner, [], { updates: [{ ...move(shop),
            pricing: { ...shop.lines[0].pricing, seenCounter: 10, seenItem: 4 } }] });
        const current = await getShop(owner);
        assert.strictEqual(current.revision, shop.revision);
        const staleReprice = await Database.repriceBoardLines(owner, [{ ...move(shop), price: 90 }]);
        assert.strictEqual(staleReprice.changed, 0, 'old price-only worker review bypassed the newer line observation');
        const old = await Database.repriceBoardLines(owner, [], { withdrawals: [move(shop)] });
        assert.strictEqual(old.changed, 0, 'stale withdrawal consumed a newer line observation at the same public revision');
        assert.deepStrictEqual(await getShop(owner), current);
        const incomplete = { ...move(current) };
        delete incomplete.previousPricing;
        assert.strictEqual((await Database.repriceBoardLines(owner, [{ ...incomplete, price: 90 }])).changed, 0,
            'an old worker without line pricing cannot safely reprice it');
        assert.strictEqual((await Database.repriceBoardLines(owner, [], { withdrawals: [incomplete] })).changed, 0,
            'an old worker without line pricing cannot safely withdraw it');
        const fresh = await Database.repriceBoardLines(owner, [], { withdrawals: [move(current)] });
        assert.strictEqual(fresh.changed, 1);
        assert.strictEqual(await getShop(owner), undefined);
        assert.strictEqual((await Database.fetchItems(owner)).find(item => Number(item.selfId) === STEM).amount, 10);
    });

    await check('an agreed quote starts a fresh checkpoint while a worker keeps its authored pricing', async () => {
        const owner = await makeBot([stem(10)]);
        const buyer = await makeBot([adena(2000)]);
        const shop = await sell(owner, { kind: 'sell_ad' });
        await buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 1 });
        const before = await getShop(owner);
        const key = MarketCounters.counterOf(STEM);
        const totals = new Map((await Database.execute(['SELECT key, value FROM world_meta WHERE key IN (?, ?)',
            [`boardCounterDealCount:${key}`, `boardDealCount:${STEM}`]])).map(row => [row.key, Number(row.value)]));
        const rivalOwner = await makeBot([stem(5)]);
        AfkTrade.refreshRecord(await sell(rivalOwner, { count: 5, price: 95, kind: 'sell_ad' }));
        AfkTrade.refreshRecord(before);
        await AfkTrade.repriceBot(owner, shop.lines[0].id, 110, before.revision);
        const agreed = await getShop(owner);
        assert.deepStrictEqual(agreed.lines[0].pricing, { ...shop.lines[0].pricing, price: 110,
            seenCounter: totals.get(`boardCounterDealCount:${key}`), seenItem: totals.get(`boardDealCount:${STEM}`),
            rival: 95, seenFills: 1 }, 'external agreed quote kept evidence attributed to its old price');
        await buy(buyer, { shopId: agreed.id, ownerId: owner,
            lineId: agreed.lines[0].id, amount: 1, expectedPrice: 110, expectedRevision: agreed.revision });
        const filled = await getShop(owner);
        assert.strictEqual(filled.lines[0].fills, 2);
        assert.strictEqual(filled.lines[0].pricing.price, 110);
        assert.strictEqual(filled.lines[0].pricing.seenFills, 1, 'new fill must remain observable at its agreed price');
        await Database.repriceAfkTradeShop(owner, filled.lines[0].id, 110, filled.revision, 5);
        const trimmed = await getShop(owner);
        assert.deepStrictEqual(trimmed.lines[0].pricing, filled.lines[0].pricing,
            'changing stock at the same quote must retain unconsumed line observations');
        const authored = { ...trimmed.lines[0].pricing, price: 120, seenCounter: 30, seenItem: 18,
            rival: 115, seenFills: 2 };
        await Database.repriceBoardLines(owner, [{ ...move(trimmed), price: 120, pricing: authored }]);
        assert.deepStrictEqual((await getShop(owner)).lines[0].pricing, authored,
            'batch worker checkpoint must survive the shared external-price fallback');

        const bidOwner = await makeBot([adena(3000)]);
        const bid = (await Database.createAfkTradeShop(bidOwner, { kind: 'buy_ad', storeType: 3, town: 'Giran',
            lines: [{ selfId: STEM, name: 'Stem', count: 10, price: 100, stackable: true,
                pricing: { ...pricing(100), worth: 5000.375 } }] })).shop;
        await Database.repriceAfkTradeShop(bidOwner, bid.lines[0].id, 110, bid.revision);
        const agreedBid = await getShop(bidOwner);
        assert.strictEqual(agreedBid.lines[0].pricing.price, 110);
        assert.strictEqual(agreedBid.lines[0].pricing.worth, 5000.375);
        assert.strictEqual(agreedBid.escrowAdena, 1100);
    });

    await check('each bot participant learns one counter deal per actual transaction', async () => {
        const owner = await makeBot([stem(10)]);
        const buyer = await makeBot([adena(2000)]);
        const shop = await sell(owner);
        const key = MarketCounters.counterOf(STEM);
        await buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 3 });
        assert.strictEqual((await getCounts(owner))[key], 1, 'seller own-deal count missing at trade commit');
        assert.strictEqual((await getCounts(buyer))[key], 1, 'buyer own-deal count missing at trade commit');
        await Database.flushJournals();
        await Database.settleBoardOwner(owner);
        await Database.settleBoardOwner(owner);
        assert.strictEqual((await getCounts(owner))[key], 1, 'journal/settlement replay learned twice');
        await buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 1 });
        assert.strictEqual((await getCounts(owner))[key], 2, 'partial fills count deals, not sold units');
    });

    await check('leased cold owner retains learning when stale worker commits settlement', async () => {
        const owner = await makeBot([stem(10), adena(100)]);
        const buyer = await makeBot([adena(2000)], { player: true });
        const shop = await sell(owner);
        const leased = LifeState.cachedState(owner);
        const token = await Owner.claim(leased, { timestamp: Date.now(), leaseMs: 30000 });
        assert(token.ok);
        await buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 3 });
        const next = structuredClone(leased);
        next.stats.workerAfterDeal = true;
        const [commit] = await Owner.commitAndReleaseBatch([{ token, nextState: next,
            proposal: { baseState: { inventory: leased.inventory } } }], { timestamp: Date.now() });
        assert(commit.ok, 'a record fill must keep the owner worker lease valid');
        assert(commit.settled);
        assert.strictEqual(await balance(owner), 400);
        const stats = await getStats(owner);
        assert.strictEqual((await getCounts(owner))[MarketCounters.counterOf(STEM)], 1,
            'worker stats overwrote its committed own deal');
        assert.strictEqual(stats.workerAfterDeal, true);
        assert.strictEqual((await Database.execute(['SELECT COUNT(*) AS n FROM bot_life_state WHERE characterId = ?',
            [buyer]]))[0].n, 0, 'a player trade must not require/create bot state');
    });

    await check('free player line and close preserve player-only and deletion boundaries', async () => {
        const owner = await makeBot([stem(2)], { player: true });
        const buyer = await makeBot([adena(1)], { player: true });
        const shop = await sell(owner, { count: 2, price: 0, state: null });
        assert.strictEqual(shop.lines[0].pricing, undefined, 'player line should carry no bot observation state');
        await buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 1 });
        assert.strictEqual((await getShop(owner)).lines[0].fills, 1, 'free fill still counts an actual line deal');
        await buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 1 });
        assert.strictEqual(await getShop(owner), undefined);
        assert.strictEqual((await Database.execute(['SELECT COUNT(*) AS n FROM afk_trade_lines WHERE shopId = ?',
            [shop.id]]))[0].n, 0);
    });

    await check('exact line fill counts survive beyond the recent deal tail', async () => {
        const owner = await makeBot([stem(40), { ...stem(40), enchant: 1 }]);
        const buyer = await makeBot([adena(10000)]);
        const sources = (await Database.fetchItems(owner)).filter(item => Number(item.selfId) === STEM);
        const shop = (await Database.createAfkTradeShop(owner, { storeType: 1, town: 'Giran',
            lines: sources.map(source => ({ objectId: source.id, selfId: STEM, name: 'Stem', count: 40,
                enchant: source.enchant, price: 100, stackable: true, pricing: pricing(100) })) })).shop;
        for (let i = 0; i < 25; i++) await buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 1 });
        const after = await getShop(owner);
        assert.deepStrictEqual(after.lines.map(line => line.fills), [25, 0], 'same-owner item tail cannot identify the exact line');
        const consumed = { ...after.lines[0].pricing, seenFills: 25 };
        await Database.repriceBoardLines(owner, [], { updates: [{ ...move(after), pricing: consumed }] });
        assert.strictEqual((await getShop(owner)).lines[0].pricing.seenFills, 25);
        const afterReview = await getShop(owner);
        const replacement = await Database.createAfkTradeShop(owner, { storeType: 1, town: 'Giran', replace: true,
            expectedRevision: afterReview.revision, lines: afterReview.lines.map(line => ({ selfId: line.selfId,
                sourceObjectId: line.sourceObjectId, name: line.name, count: line.count, price: line.price,
                enchant: line.enchant, stackable: true, pricing: line.pricing, fills: line.fills })) });
        assert.deepStrictEqual(replacement.shop.lines.map(line => [line.fills, line.pricing.seenFills]), [[25, 25], [0, 0]],
            'authored kept-line replacement preserves supplied continuity');
        await Database.closeAfkTradeShop(owner);
        const fresh = await sell(owner);
        assert.strictEqual(fresh.lines[0].fills, 0);
        assert.strictEqual(fresh.lines[0].pricing.seenFills, 0);
    });

    await check('knowledge switch disables own counts but retains actual line/world deals', async () => {
        const Config = invoke('GameServer/Bot/Population/PopulationConfig');
        const enabled = Config.knowledgeErrorsEnabled;
        const owner = await makeBot([stem(10)]);
        const buyer = await makeBot([adena(2000)]);
        const shop = await sell(owner);
        const before = (await Database.fetchRecentBoardDeals()).dealCounts.find(row => row.selfId === STEM)?.deals || 0;
        Config.knowledgeErrorsEnabled = false;
        try { await buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 3 }); }
        finally { Config.knowledgeErrorsEnabled = enabled; }
        assert.strictEqual(Object.keys(await getCounts(owner)).length, 0);
        assert.strictEqual(Object.keys(await getCounts(buyer)).length, 0);
        assert.strictEqual((await getShop(owner)).lines[0].fills, 1);
        assert.strictEqual((await Database.fetchRecentBoardDeals()).dealCounts.find(row => row.selfId === STEM).deals, before + 1);
    });

    await check('Adena and free bot fills do not fabricate personal/world learning', async () => {
        const owner = await makeBot([stem(10)]);
        const buyer = await makeBot([adena(2000)]);
        const free = await sell(owner, { price: 0 });
        await buy(buyer, { shopId: free.id, ownerId: owner, lineId: free.lines[0].id, amount: 1 });
        assert.strictEqual((await getShop(owner)).lines[0].fills, 1);
        assert.strictEqual(Object.keys(await getCounts(owner)).length, 0);
        await Database.closeAfkTradeShop(owner);
        const legacy = await sell(owner, { count: 5 });
        // New publication still refuses Adena. A legacy row exercises the
        // settlement boundary itself instead of relying on producer validation.
        await assert.rejects(Database.createAfkTradeShop(buyer, { storeType: 3,
            lines: [{ selfId: 57, name: 'Adena', count: 1, price: 100 }] }), /invalid_afk_trade_line/);
        await Database.execute(["UPDATE afk_trade_lines SET selfId = 57, name = 'Adena' WHERE id = ?", [legacy.lines[0].id]]);
        const totals = (await Database.fetchRecentBoardDeals()).dealCounts;
        await buy(buyer, { shopId: legacy.id, ownerId: owner, lineId: legacy.lines[0].id, amount: 1 });
        assert.strictEqual((await getShop(owner)).lines[0].fills, 1);
        assert.strictEqual(Object.keys(await getCounts(owner)).length, 0);
        assert.strictEqual(Object.keys(await getCounts(buyer)).length, 0);
        assert.deepStrictEqual((await Database.fetchRecentBoardDeals()).dealCounts, totals);
    });

    await check('legacy/hot stale stats save preserves durable learning and returned cache', async () => {
        const owner = await makeBot([stem(10)]);
        const buyer = await makeBot([adena(2000)]);
        const oldState = structuredClone(LifeState.cachedState(owner));
        const shop = await sell(owner);
        await buy(buyer, { shopId: shop.id, ownerId: owner,
            lineId: shop.lines[0].id, amount: 3 });
        const saved = await LifeState.upsertState({ ...oldState, stats: { ...oldState.stats, anotherStat: 17 } }, 'n79_stale_stats');
        assert(saved);
        assert.strictEqual(saved.marketTrades[MarketCounters.counterOf(STEM)], 1);
        assert.strictEqual(LifeState.cachedState(owner).marketTrades[MarketCounters.counterOf(STEM)], 1);
        assert.strictEqual((await getCounts(owner))[MarketCounters.counterOf(STEM)], 1);
        assert.strictEqual(saved.stats.anotherStat, 17);
    });

    await check('BUY exact worth and original batch revision stay atomic with escrow', async () => {
        const owner = await makeBot([adena(1000)]);
        const state = { ...pricing(100), worth: 5000.375 };
        const shop = (await Database.createAfkTradeShop(owner, { storeType: 3, town: 'Giran',
            lines: [STEM, 1865].map(selfId => ({ selfId, name: `Item ${selfId}`, count: 2, price: 100,
                stackable: true, pricing: state })) })).shop;
        assert.strictEqual(shop.lines[0].pricing.worth, 5000.375);
        const reprices = shop.lines.map((line, i) => ({ ...move(shop, line), price: 200 + i * 100,
            pricing: { ...line.pricing, price: 200 + i * 100, seenCounter: 1 } }));
        const result = await Database.repriceBoardLines(owner, reprices);
        assert.strictEqual(result.changed, 2);
        assert.strictEqual(result.updated, 2);
        const after = await getShop(owner);
        assert.strictEqual(after.revision, shop.revision + 2);
        assert.strictEqual(after.escrowAdena, 1000);
        assert.strictEqual(await balance(owner), 0);
        assert.strictEqual(after.lines[0].pricing.worth, 5000.375);
        const before = structuredClone(after);
        const failed = await Database.repriceBoardLines(owner, [{ ...move(after), price: 1000,
            pricing: { ...after.lines[0].pricing, price: 1000, worth: 6000.875 } }]);
        assert.strictEqual(failed.changed, 0);
        assert.strictEqual(failed.updated, 0);
        assert.deepStrictEqual(await getShop(owner), before, 'insufficient escrow must leave price and decision state together');
        const seller = await makeBot([stem(5)]);
        const objectId = (await Database.fetchItems(seller)).find(item => Number(item.selfId) === STEM).id;
        await sellInto(seller, { ownerId: owner, shopId: after.id,
            lineId: after.lines[0].id, objectId, amount: 1 });
        const key = MarketCounters.counterOf(STEM);
        assert.strictEqual((await getCounts(owner))[key], 1, 'BUY record owner learns as buyer');
        assert.strictEqual((await getCounts(seller))[key], 1, 'acting seller learns in the same transaction');
        assert.strictEqual((await getShop(owner)).lines[0].fills, 1);
    });

    await check('failure after evidence and deferred COMMIT roll back all trade state', async () => {
        const owner = await makeBot([stem(10)]);
        const buyer = await makeBot([adena(2000)]);
        const shop = await sell(owner);
        const totals = (await Database.fetchRecentBoardDeals()).dealCounts;
        const purchase = { shopId: shop.id, ownerId: owner, lineId: shop.lines[0].id, amount: 3 };
        const unchanged = async () => {
            assert.strictEqual(await balance(buyer), 2000);
            assert.strictEqual((await getShop(owner)).lines[0].count, 10);
            assert.strictEqual((await getShop(owner)).lines[0].fills, 0);
            assert.strictEqual(Object.keys(await getCounts(owner)).length, 0);
            assert.strictEqual(Object.keys(await getCounts(buyer)).length, 0);
            assert(!Database.boardSettlementOwners().includes(owner));
            assert.deepStrictEqual((await Database.fetchRecentBoardDeals()).dealCounts, totals);
        };
        await Database.execute([`CREATE TEMP TRIGGER n79_after_learning_failure
            BEFORE INSERT ON main.bot_market_counts WHEN NEW.characterId = ${buyer}
            BEGIN SELECT RAISE(ABORT, 'injected learning failure'); END`]);
        try { await assert.rejects(buy(buyer, purchase), /injected learning failure/); }
        finally { await Database.execute(['DROP TRIGGER temp.n79_after_learning_failure']); }
        await unchanged();
        await Database.execute(['CREATE TABLE n79_deferred (id INTEGER REFERENCES characters(id) DEFERRABLE INITIALLY DEFERRED)']);
        await Database.execute([`CREATE TEMP TRIGGER n79_commit_failure
            AFTER INSERT ON main.bot_market_counts WHEN NEW.characterId = ${buyer}
            BEGIN INSERT INTO n79_deferred VALUES (99999999); END`]);
        try { await assert.rejects(buy(buyer, purchase), /FOREIGN KEY constraint failed/); }
        finally {
            await Database.execute(['DROP TRIGGER temp.n79_commit_failure']);
            await Database.execute(['DROP TABLE n79_deferred']);
        }
        await unchanged();
        await buy(buyer, purchase);
        assert.strictEqual((await getCounts(owner))[MarketCounters.counterOf(STEM)], 1);
        assert.strictEqual((await getShop(owner)).lines[0].fills, 1);
    });

    if (failures.length) throw new Error(`${failures.length} N79 storage contracts failed: ${failures.join('; ')}`);
    console.log('N79 native line pricing and transaction learning: pass');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    AfkTrade._resetForTests();
    MarketCounters.reset();
    await Database.close();
    clean();
});
