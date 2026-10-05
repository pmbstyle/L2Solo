// A bot that finds nothing to buy in town asks for it on the board (step 3.3):
// ColdMarketBuyStoreService.open opens a buy ad whose escrow leaves the wallet;
// the author's budget-backed stall (money left in the wallet, the bot waiting
// in town as a merchant) is gone. A seller fills the ad in one deal.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const World = invoke('GameServer/World/World');

const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-dynamic-buy-store.sqlite');

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

async function bagAmount(characterId, selfId) {
    const [row] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS amount FROM items WHERE characterId = ? AND selfId = ?',
        [characterId, selfId]]);
    return Number(row.amount);
}

async function makeBot(account, name, level, items) {
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, {
        name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 82000, locY: 148500, locZ: -3466
    })).insertId);
    for (const item of items) await Database.setItem(id, { enchant: 0, equipped: false, slot: 0, ...item });
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
    return LifeState.upsertState({
        characterId: id, accountName: account, name, level, adena: Number(inventory[57]?.amount || 0),
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
        loc: { locX: 82000, locY: 148500, locZ: -3466 }, inventory,
        stats: { generatedCold: true, marketReturn: { loc: { locX: 100, locY: 200, locZ: 0 }, regionName: 'Field', spotId: 'field' } },
        timing: {}, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }
    }, 'test_seed');
}

async function run() {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();
    await AfkTrade.init();
    MarketTelemetry.reset();

    // Level 2: the operating reserve every purchase keeps (PurchaseFunding:
    // 500, 250 per level or 10%) leaves 1,500 of the 2,000 adena spendable,
    // enough for the five stems at the bot's own belief of their price.
    const buyerSeed = await makeBot('bot_budget_buyer', 'BudgetBuyer', 2, [{ selfId: 57, name: 'Adena', amount: 2000 }]);
    const goal = { type: 'buy_craft_material', target: { itemId: 1864, itemName: 'Stem', amount: 5 }, plan: {} };
    const bid = BuyStoreService.bidFor(buyerSeed, goal);
    assert(bid && bid.count > 0);
    assert(bid.price * bid.count <= 1500, 'a buy ad must preserve its operating reserve');

    const opened = await BuyStoreService.open(buyerSeed, goal);
    assert.strictEqual(opened.opened, true);
    assert.strictEqual(opened.state.activity, 'shopping', 'the bot does not stand in town: its ad waits on the board');
    assert.strictEqual(opened.store.storeType, 3);
    assert.strictEqual(opened.store.kind, 'buy_ad');
    const escrow = Number(opened.store.escrowAdena);
    assert.strictEqual(escrow, bid.price * bid.count, 'the ad holds the whole bid as escrow');
    assert.strictEqual(await bagAmount(buyerSeed.characterId, 57), 2000 - escrow, 'the escrow left the wallet');
    assert.strictEqual(opened.state.adena, 2000 - escrow);
    assert.strictEqual(AfkTrade.findOwnerProjection(buyerSeed.characterId), null, 'an ad has no stall in the world');
    assert.deepStrictEqual(MarketOpportunity.activeBuyDemandSelfIds(), [1864],
        'a funded buy ad is demand the warehouse circulation can see');
    const marketSnapshot = MarketSnapshot.snapshot();
    assert.strictEqual(marketSnapshot.dynamic.wtb, 1);
    assert(Number.isFinite(marketSnapshot.activity.dynamicBuyerSales), 'market snapshot must expose non-mutating trade totals to Observer');
    assert(marketSnapshot.byTown['Elven Village'].fixedWtb > 0, 'starter market coverage must be visible in the market snapshot');

    const seller = await makeBot('bot_material_seller', 'MaterialSeller', 20, [{ selfId: 1864, name: 'Stem', amount: 2 }]);
    const town = opened.store.town;
    assert.strictEqual(BuyStoreService.bestTownFor(seller).town, town, 'a seller must discover the ad in its town');
    const sale = await BuyStoreService.sellToBestBuyer(seller, town);
    assert.strictEqual(sale.sold, true);
    assert.strictEqual(sale.itemCount, 2);
    assert.strictEqual(sale.adena, 2 * bid.price);
    assert.strictEqual(await bagAmount(seller.characterId, 57), 2 * bid.price, 'the seller is paid from the escrow');
    assert.strictEqual(await bagAmount(seller.characterId, 1864), 0);
    assert.strictEqual(await bagAmount(buyerSeed.characterId, 1864), 2, 'the buyer\'s next save brings the stems');
    assert.strictEqual(LifeState.snapshot(buyerSeed.characterId).inventory['1864'].amount, 2);
    const ad = AfkTrade.ownerRecords(buyerSeed.characterId)[0];
    assert.strictEqual(Number(ad.lines[0].count), bid.count - 2);
    assert.strictEqual(Number(ad.escrowAdena), escrow - 2 * bid.price);
    const trade = MarketSnapshot.snapshot().transactions.recentPeerTrades[0];
    assert.strictEqual(trade.channel, 'wtb', 'Observer telemetry must distinguish a buy-ad settlement');
    assert.strictEqual(trade.itemName, 'Stem');
    assert.strictEqual(trade.quantity, 2);

    // An NPC-only skill book never goes to a peer, even into an open ad.
    const chantOfRevenge = DataCache.items.find((item) => item.template?.name === 'Amulet: Chant of Revenge');
    assert(chantOfRevenge);
    const bookBuyer = await makeBot('bot_book_buyer', 'BookBuyer', 40, [{ selfId: 57, name: 'Adena', amount: 100000 }]);
    await AfkTrade.publishBot(bookBuyer.characterId, { kind: 'buy_ad', storeType: 3, title: 'WTB book', town,
        locX: 0, locY: 0, locZ: 0, lines: [{ selfId: chantOfRevenge.selfId, name: chantOfRevenge.template.name,
            count: 1, price: 5000, stackable: false }] });
    const bookSeller = await makeBot('bot_book_seller', 'BookSeller', 20,
        [{ selfId: chantOfRevenge.selfId, name: chantOfRevenge.template.name, amount: 1 }]);
    assert.strictEqual(BuyStoreService.bestTownFor(bookSeller), null,
        'NPC-only skill books must ignore peer buy-ad demand');
    const bookSale = await BuyStoreService.sellToBestBuyer(bookSeller, town);
    assert.strictEqual(bookSale.sold, false, 'Amulet: Chant of Revenge must wait for NPC liquidation');

    MarketTelemetry.staticBuyerSale([{
        selfId: 1864,
        name: 'Stem',
        count: 3,
        npcPrice: 50,
        buyerName: 'Material Broker',
        buyerTown: 'Giran'
    }], 150, { sellerCharacterId: seller.characterId, sellerName: seller.name, town: 'Giran' });
    const staticTrade = MarketTelemetry.transactions().recentStaticTrades[0];
    assert.strictEqual(staticTrade.channel, 'static_wtb');
    assert.strictEqual(staticTrade.quantity, 3);
    assert.strictEqual(staticTrade.adena, 150);
    const combinedTrades = MarketTelemetry.transactions();
    assert.strictEqual(combinedTrades.byItem[0].adena, 2 * bid.price + 150, 'all-channel totals should retain both peer and static turnover');
    assert.strictEqual(combinedTrades.byPeerItem[0].adena, 2 * bid.price, 'peer item totals must exclude static-buyer turnover');

    // A bot short of the whole amount asks for fewer units, never for none.
    const poorBuyer = await makeBot('bot_poor_buyer', 'PoorBuyer', 2, [{ selfId: 57, name: 'Adena', amount: 1000 }]);
    const poorBid = BuyStoreService.bidFor(poorBuyer,
        { type: 'buy_craft_material', target: { itemId: 1864, itemName: 'Stem', amount: 20 }, plan: {} });
    assert(poorBid && poorBid.count > 0 && poorBid.count < 20, 'a short wallet bids for the units it can pay');
    assert(poorBid.price * poorBid.count <= 500, 'a smaller bid still keeps the operating reserve');

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log('Bot dynamic buy-store checks passed');
}

run().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) { /* cleanup only */ }
    clean();
    process.exitCode = 1;
}).finally(() => {
    MarketTelemetry.reset();
});
