'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('bot-afk-buy-shop');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const BuyShop = invoke('GameServer/Bot/Economy/BotBuyShopService');
const Places = invoke('GameServer/Bot/Economy/ShopPlaces');
const Native = require('./helpers/nativeMarketFixture');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Ready = require('../src/GameServer/Bot/Economy/ReadyTradeChoice');
const POINT = { locX: 83000, locY: 148000, locZ: -3400 };
const REQUESTS = [79, 1864, 1865, 1866, 1867, 1868, 1869, 1870].map((id, at) => [id, at ? 2 : 1, (at + 1) * 100]);
const cost = rows => rows.reduce((sum, row) => sum + row[1] * row[2], 0);
const wallet = async id => Native.amount(await DB.fetchItems(id), 57);
const records = id => Afk.ownerRecords(id);
const shop = id => Afk.findOwnerProjection(id)?.shop;
const apply = (id, rows = REQUESTS, priority = Afk.BUY) => Market.executePlan(Life.snapshot(id),
    { buyAds: rows, buyShop: priority }, { reviewGoal: false });

async function bot(id, town = 'Giran', loc = POINT) {
    await Native.character(DB, id, `Buyer${id}`, `bot_buy_shop_${id}`, loc);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
    return Life.upsertState({ characterId: id, accountName: `bot_buy_shop_${id}`, name: `Buyer${id}`,
        phase: 'cold', activity: 'shopping', level: 45, adena: 1000000, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        currentRegion: town, loc, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, money: [36000, 0, 0, 0] }, timing: {} }, 'buy_shop_fixture');
}

async function autonomousSale() {
    await bot(9110);
    await apply(9110, [[79, 1, 100], [1864, 5, 100000]]);
    await Life.upsertState({ ...Life.snapshot(9110), activity: 'hunting' }, 'buy_shop_hunt');
    await bot(9111);
    await DB.setItem(9111, { selfId: 1864, name: 'Stem', amount: 12, slot: 0 });
    const refreshed = await Life.refreshInventory(Life.snapshot(9111));
    const seller = await Life.upsertState({ ...refreshed,
        stats: { ...refreshed.stats, money: [36000, 1 / 36000, 0, 0] } }, 'buy_shop_seller_money');
    const economy = { ...Decision.economyFor(seller), network: { activity: null } };
    const plan = Plan.decide(seller, economy, { board: Afk.boardIndex(), now: Date.now(),
        decisionPoint: 'autonomous_buy_shop_sale', npcOffersFor: () => [], findSpot: () => null });
    assert.equal(plan.take?.[0], Afk.BUY, 'the native seller decision must execute a backed buy shop');
    assert.equal(plan.take[3], shop(9110).id);
    assert.equal(plan.take[2], 5);
    const line = Afk.boardIndex().records.get(plan.take[3]).find(row => row.lineId === plan.take[4]);
    assert.equal(Ready.sale([{ line, count: 5 }], { ...seller, currentRegion: 'Dion' }), null,
        'a physical shop cannot be filled remotely from another town');
    assert.equal(Ready.sale([{ line, count: 5 }], { ...seller, loc: { locX: 0, locY: 0, locZ: 0 } }), null,
        'the region label alone does not prove physical arrival');
    const cashBefore = await wallet(9110) + await wallet(9111) + Market.buyOrderEscrow(9110);
    const result = await Market.executePlan(seller, plan, { reviewGoal: false });
    assert.equal(result.pending, undefined);
    assert.equal(Native.amount(await DB.fetchItems(9111), 1864), 7);
    assert.equal(await wallet(9111), 1500000, 'the seller receives exactly five units at the shop price');
    assert.equal(shop(9110).escrowAdena, 100, 'only the unfilled weapon request remains reserved');
    assert.equal(await wallet(9110) + await wallet(9111) + Market.buyOrderEscrow(9110), cashBefore,
        'a native sale transfers Adena without creating or deleting money');
    await Afk.settleOwners([9110]);
    assert.equal(Native.amount(await DB.fetchItems(9110), 1864), 5, 'the buyer receives the five purchased items');
    await Market.executePlan(Life.snapshot(9111), plan, { reviewGoal: false });
    assert.equal(await wallet(9111), 1500000, 'an old quote cannot pay the seller twice');
    await DB.flushJournals(); await DB.flushHistory();
    const trades = await DB.readHistory([`SELECT quantity,totalPrice,sourceType FROM market_trades
        WHERE buyerCharacterId=? AND sellerCharacterId=?`, [9110, 9111]]);
    assert.deepEqual(trades.map(row => [row.quantity, row.totalPrice, row.sourceType]), [[5, 500000, 'afk_bot_buy_store']]);
    const flows = await DB.readHistory([`SELECT selfId,SUM(delta) delta FROM economy_flow_hour
        WHERE operation='afk-trade:sell-to-shop' GROUP BY selfId`, []]);
    assert(flows.every(row => row.delta === 0), 'the transfer journal conserves purchased goods and Adena');
    console.log('PASS autonomous buy-shop sale: native decision, escrow, seller receipt, buyer settlement, replay and conservation');
}

async function run() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init();
    await bot(9101);
    await apply(9101);
    assert.equal(shop(9101)?.storeType, Afk.BUY);
    assert.equal(shop(9101).custodyPolicy, 0);
    assert.deepEqual(shop(9101).lines.map(line => line.selfId), REQUESTS.slice(0, 3).map(row => row[0]), 'highest priority requests own the shop');
    assert.deepEqual(records(9101).filter(row => row.kind === 'buy_ad').map(row => row.lines[0].selfId), REQUESTS.slice(3).map(row => row[0]), 'five remaining requests use meetings');
    assert.equal(Afk.findOwnerProjection(9101).actor.fetchPrivateStoreType(), Afk.BUY);
    assert.equal(shop(9101).escrowAdena, cost(REQUESTS.slice(0, 3)));
    assert.equal(await wallet(9101) + shop(9101).escrowAdena, 1000000);
    const original = shop(9101);
    await apply(9101);
    assert.equal(shop(9101).id, original.id, 'unchanged requests retain the physical shop and line identities');
    assert.deepEqual(shop(9101).lines.map(row => row.id), original.lines.map(row => row.id));
    assert.equal(await wallet(9101) + Market.buyOrderEscrow(9101), 1000000, 'repeated publication cannot reserve twice');
    Afk._resetForTests();
    await Afk.init();
    assert.equal(shop(9101).id, original.id, 'restart restores the purchase projection and its reserved money');

    // A player sells into the visible purchase shop without a meeting.
    await Native.character(DB, 9201, 'Supplier', 'buy_shop_supplier', POINT);
    const source = Number((await DB.setItem(9201, { selfId: 1864, name: 'Stem', amount: 1, slot: 0 })).insertId);
    const sale = await Afk.sellToShop(9201, Afk.recordStore(shop(9101).id), 1864, 1, { objectId: source });
    assert.equal(sale.pending, undefined);
    assert.equal(await wallet(9201), 200);
    await Afk.settleOwners([9101]);
    assert.equal(Native.amount(await DB.fetchItems(9101), 1864), 1);
    assert.equal(shop(9101).lines.find(row => row.selfId === 1864).count, 1);
    const remaining = REQUESTS.map(row => row[0] === 1864 ? [1864, 1, row[2]] : row);
    await apply(9101, remaining);
    assert.equal(await wallet(9101) + Market.buyOrderEscrow(9101), 1000000 - 200);

    await Market.withdrawBuyAds(9101, 79);
    assert(shop(9101), 'fulfilling one item keeps other purchase lines open');
    assert.equal(shop(9101).lines.filter(row => row.count > 0).length, 2);
    await apply(9101, remaining.slice(1));
    assert.deepEqual(shop(9101).lines.map(row => row.selfId), [1864, 1865, 1866], 'a free line promotes the next meeting request');
    assert(!records(9101).filter(row => row.kind === 'buy_ad').some(row => row.lines[0].selfId === 1866), 'promotion retires the duplicate meeting offer atomically');
    await apply(9101, []);
    assert.equal(records(9101).length, 0);
    assert.equal(await wallet(9101), 1000000 - 200, 'closing refunds every remaining purchase reservation');

    // A full square leaves all affordable requests as meeting adverts.
    await bot(9102);
    const take = Places.take;
    try {
        Places.take = () => null;
        await apply(9102, REQUESTS.slice(0, 5));
    } finally { Places.take = take; }
    assert.equal(shop(9102), undefined);
    assert.equal(records(9102).length, 5);
    assert(records(9102).every(row => row.kind === 'buy_ad' && row.custodyPolicy === 1));
    assert.equal(await wallet(9102), 1000000);
    await apply(9102, REQUESTS.slice(0, 5));
    assert.equal(shop(9102).lines.length, 3, 'the next decision promotes requests when a place becomes available');

    // A more important purchase replaces a sale at the same reserved place.
    await bot(9103);
    const stock = Number((await DB.setItem(9103, { selfId: 1871, name: 'Charcoal', amount: 20, slot: 0 })).insertId);
    const place = Places.take('Giran', Places.afkOwner(9103));
    await Afk.publishBot(9103, { storeType: Afk.SELL, town: 'Giran', ...place,
        lines: [{ objectId: stock, selfId: 1871, count: 20, price: 150, stackable: true }] });
    await apply(9103, REQUESTS.slice(0, 2), 0);
    assert.equal(shop(9103).storeType, Afk.SELL, 'secondary wishes cannot evict the sale shop');
    await apply(9103, REQUESTS.slice(0, 2), Afk.BUY);
    assert.equal(shop(9103).storeType, Afk.BUY);
    assert.deepEqual([shop(9103).locX, shop(9103).locY], [place.locX, place.locY]);
    assert.equal(Native.amount(await DB.fetchItems(9103), 1871), 20, 'displaced sale stock returns to its owner');
    const before = await DB.fetchItems(9103), beforeShop = shop(9103);
    await assert.rejects(DB.replaceBoardRecords(9103, 'buy_ad', [], { expected: {}, buyShop: {
        expected: { id: beforeShop.id, revision: beforeShop.revision - 1 }, config: null
    } }), /afk_trade_shop_changed/);
    assert.deepEqual(await DB.fetchItems(9103), before, 'a stale shop decision changes no custody');
    assert.equal(shop(9103).id, beforeShop.id);
    await Market.executePlan(Life.snapshot(9103), { sell: [[1871, 20, 150, 'Giran', 0]],
        shop: 'Giran', buyShop: Afk.SELL }, { reviewGoal: false });
    assert.equal(shop(9103).storeType, Afk.SELL, 'a newly selected sale priority can recover the shop');
    assert.equal(Market.buyOrderEscrow(9103), 0, 'sale priority refunds the purchase reservation');

    // Failure after withdrawing a sale must roll back both its stock and the old ads.
    await bot(9104);
    const itemId = Number((await DB.setItem(9104, { selfId: 1871, name: 'Charcoal', amount: 20, slot: 0 })).insertId);
    await Afk.publishBot(9104, { storeType: Afk.SELL, town: 'Giran', ...Places.take('Giran', Places.afkOwner(9104)),
        lines: [{ objectId: itemId, selfId: 1871, count: 20, price: 150, stackable: true }] });
    const old = shop(9104), oldBag = await DB.fetchItems(9104);
    await assert.rejects(DB.replaceBoardRecords(9104, 'buy_ad', [], { expected: {}, buyShop: {
        expected: { id: old.id, revision: old.revision },
        config: { ...old, storeType: Afk.BUY,
            lines: [{ selfId: 79, count: 1, price: 2000000 }] }
    } }), /not_enough_adena|economy_funding_changed/);
    assert.equal(shop(9104).id, old.id);
    assert.deepEqual(await DB.fetchItems(9104), oldBag);

    await bot(9105);
    const alternatives = REQUESTS.slice(0, 3).map(([selfId, count, price]) =>
        [selfId, count, price, 1, 79, 7, 0, 100, 1]);
    await Market.executePlan(Life.snapshot(9105), { buyAds: alternatives, buyShop: Afk.BUY }, { reviewGoal: false });
    assert.equal(shop(9105).lines.length, 1, 'alternatives for one root cannot reserve both product and materials');
    assert.equal(records(9105).filter(row => row.kind === 'buy_ad').length, 2);

    // A kept purchase shop's escrow stays locked: it cannot back a new meeting bid.
    await bot(9106);
    await apply(9106, REQUESTS.slice(0, 3));
    const kept = shop(9106);
    assert.equal(records(9106).length, 1);
    const cash = (await DB.fetchItems(9106)).find(item => Number(item.selfId) === 57);
    await DB.updateItemAmount(9106, cash.id, 1000);
    const keptLines = kept.lines.map(line => ({ selfId: line.selfId, enchant: line.enchant, count: line.count,
        price: line.price, name: line.name }));
    await assert.rejects(DB.replaceBoardRecords(9106, 'buy_ad', [{ storeType: Afk.BUY, title: 'WTB', town: 'Giran', ...POINT,
        lines: [{ selfId: 1867, count: 1, price: 1500, name: 'Item 1867' }] }], { expected: {}, buyShop: {
        expected: { id: kept.id, revision: kept.revision },
        config: { storeType: Afk.BUY, title: kept.title, town: kept.town, locX: kept.locX, locY: kept.locY, locZ: kept.locZ, lines: keptLines }
    } }), /not_enough_adena/, 'the free wallet (1000) cannot back a 1500 bid while 1100 stays in the kept shop');
    assert.equal(shop(9106).id, kept.id);
    assert.equal(shop(9106).escrowAdena, kept.escrowAdena);
    assert.equal(records(9106).length, 1);

    // An unchanged order keeps its records as they stand: a cheaper quote
    // within the prepared cap keeps the held bids, no record is rewritten.
    await bot(9107);
    await apply(9107);
    const standing = shop(9107);
    const standingAds = records(9107).filter(row => row.kind === 'buy_ad').map(row => [row.id, row.revision]);
    const quoted = REQUESTS.map(([selfId, count, price]) => ({ selfId, count, price: price - 50, purchaseCap: price,
        enchant: 0, name: `Item ${selfId}` }));
    const published = await BuyShop.publish(Life.snapshot(9107), quoted, 'Giran', { priority: Afk.BUY, appearance: async () => ({}) });
    assert.equal(published.changed, false);
    assert.equal(published.shop?.id, standing.id);
    assert.equal(shop(9107).id, standing.id, 'the standing purchase shop is kept');
    assert.equal(shop(9107).revision, standing.revision);
    assert.deepEqual(shop(9107).lines.map(line => line.price), standing.lines.map(line => line.price), 'held bids keep their price');
    assert.deepEqual(records(9107).filter(row => row.kind === 'buy_ad').map(row => [row.id, row.revision]), standingAds);
    assert.equal(await wallet(9107) + Market.buyOrderEscrow(9107), 1000000);

    const batch = Plan.buyBatch(REQUESTS.map(([selfId, count, price]) => ({ selfId, count, price })));
    assert.equal(batch.buyAds.length, 8, 'worker transport carries the shop and meeting slots');
    const captured = Decision.capture({ inputKey: 'eight-purchase-requests', network: {
        activity: { activity: 'shopping', kind: 'buy', rootKey: 'power:79:7', itemId: 79, amount: 1, price: 100 },
        queue: [{ key: 'power:79:7', object: { itemId: 79 }, price: 100 }]
    }, watchList: REQUESTS.map(([itemId, amount, worth]) => ({ itemId, amount, worth, kind: 'improvement' })) }, Life.snapshot(9104));
    assert.equal(captured.watch.length, 8, 'hot/cold decision cards retain the overflow needs');
    assert.equal(captured.activity.itemId, 79, 'the extended watch does not corrupt activity offsets');
    assert(captured.data.byteLength < Decision.MAX_BYTES);
    await bot(9112);
    const Policy = invoke('GameServer/Bot/Economy/BuyAdPolicy');
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const previousBid = Pricing.bid;
    const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const watch = [1864, 1864, 1865, 1866, 1867].map((itemId, at) => ({ itemId, amount: 1, worth: 100,
        key: at === 0 ? 'power:79:7' : at === 1 ? 'power:80:7' : `resale:${itemId}`,
        recipeId: 0, valueHours: 1, valueRate: 1 }));
    let planned;
    try {
        Pricing.bid = () => ({ price: 100, count: 1, purchaseCap: 100, pricing: { price: 100 } });
        planned = Policy.linesFor(Life.snapshot(9112), null, { watchList: watch, board: Afk.boardIndex(),
            townFor: () => 'Giran', npcOffersFor: () => [], economy: { moneyPrice: .001, hourAdena: 1000,
                worth: () => 100, trip, persona: { traits: {} }, network: { moneyPrice: .001 } } });
    } finally { Pricing.bid = previousBid; }
    assert.deepEqual(planned.map(row => row.selfId), [1864, 1865, 1866, 1867]);
    const deduplicatedPlan = { ...Plan.buyBatch(planned), buyShop: Afk.BUY };
    await Market.executePlan(Life.snapshot(9112), deduplicatedPlan, { reviewGoal: false });
    const once = records(9112).flatMap(record => record.lines.map(line => line.selfId));
    assert.deepEqual(once.sort((a, b) => a - b), [1864, 1865, 1866, 1867],
        'the real transaction publishes each physical item once');
    await Market.executePlan(Life.snapshot(9112), deduplicatedPlan, { reviewGoal: false });
    assert.deepEqual(records(9112).flatMap(record => record.lines.map(line => line.selfId)).sort((a, b) => a - b), once,
        'replaying the prepared unique batch does not create duplicate ads');
    await autonomousSale();
    console.log('PASS bot AFK buy shops: priority, escrow, overflow, fill, refund, promotion, full square and atomic replacement');
}
run().then(async () => { Afk._resetForTests(); await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); })
    .catch(async error => { console.error(error); await DB.close(); process.exitCode = 1; });
