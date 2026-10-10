// The unchanged actors cannot fund a native purchase or sale decision.
// A separate public DAO execution verifies buy-record escrow and settlement:
// a player's AFK buy shop pays the escrow from its wallet and a bot seller
// fills it through its own sale decision. Bot buy ads are funded-only and
// settle at meetings (tests/test_board_trade_meeting.js).
const assert = require('assert');
const fs = require('fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
require('../src/Global');
fixture.assertConfigured(options.default);
const nativeChoice = require('./helpers/nativeMarketChoice');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const World = invoke('GameServer/World/World');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');

function clean() { fs.rmSync(fixture.directory, { recursive: true, force: true }); }

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

// A player character (no `bot_` account, no cold life state).
async function makePlayer(account, name, items) {
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, {
        name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 82000, locY: 148500, locZ: -3466
    })).insertId);
    for (const item of items) await Database.setItem(id, { enchant: 0, equipped: false, slot: 0, ...item });
    return id;
}

async function run() {
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();
    await AfkTrade.init();
    MarketTelemetry.reset();

    // ARCH-NOTE: E1 removed the flat500/level/10% reserve. E3 requires
    // an actual funded gain; the original2000/level2/Stem5 has none.
    const buyerOriginal = await makeBot('bot_budget_buyer', 'BudgetBuyer', 2, [{ selfId: 57, name: 'Adena', amount: 2000 }]);
    const goal = { type: 'buy_craft_material', target: { itemId: 1864, itemName: 'Stem', amount: 5 }, plan: {} };
    const buyerNative = await nativeChoice.capture(buyerOriginal, { now: 1791000000000 }, 'original_dynamic_buyer');
    const buyerSeed = buyerNative.state;
    assert.strictEqual(Funding.spendable(buyerSeed, 0, { itemId: 1864 }), 0);
    assert.strictEqual(BuyStoreService.bidFor(buyerSeed, goal), null, 'the original unfunded Stem request cannot bid');
    const deferred = await BuyStoreService.open(buyerSeed, goal);
    assert.strictEqual(deferred.opened, false);
    assert.strictEqual(await bagAmount(buyerSeed.characterId, 57), 2000);
    assert.deepStrictEqual(AfkTrade.ownerRecords(buyerSeed.characterId), []);
    assert.strictEqual(await bagAmount(buyerSeed.characterId, 1864), 0);

    // Independent execution seam: original wallet2000, requested Stem5,
    // native DAO and authored catalogue reference quote. This is not an
    // invented wish, MarketPricing bid or native BuyStore approval.
    // A bot's buy ad is now funded-only and settles at a meeting (custody
    // policy 1, tests/test_board_trade_meeting.js); the escrow-held buy record
    // that a seller fills in person is a player's AFK buy shop (the same
    // Database.createAfkTradeShop and projection steps as AfkTrade.activate).
    // The seller is made first so the bots keep their character ids (and rolls).
    const sellerOriginal = await makeBot('bot_material_seller', 'MaterialSeller', 20, [{ selfId: 1864, name: 'Stem', amount: 2 }]);
    const seller = (await nativeChoice.capture(sellerOriginal, { now: 1791000000000 }, 'original_dynamic_seller')).state;
    const stemBuyer = await makePlayer('player_stem_buyer', 'StemBuyer', [{ selfId: 57, name: 'Adena', amount: 2000 }]);
    const template = DataCache.items.find(item => Number(item.selfId) === 1864);
    const executionQuote = { price: Number(template.template.price), count: goal.target.amount };
    assert.strictEqual(executionQuote.price, 100, 'authored Stem template reference, fixed before publication');
    assert.strictEqual(executionQuote.count, 5);
    assert(executionQuote.price * executionQuote.count <= 2000, 'the original physical wallet covers the entire execution quote');
    const record = await AfkTrade.publishBot(stemBuyer, { kind: 'shop', storeType: AfkTrade.BUY,
        title: 'WTB Stem', town: 'Giran', locX: 82000, locY: 148500, locZ: -3466,
        lines: [{ selfId: 1864, name: 'Stem', count: executionQuote.count, price: executionQuote.price,
            enchant: 0, slot: 0, stackable: template.etc.stackable === true }] });
    assert(Number.isSafeInteger(Number(record.id)) && Number(record.id) > 0, 'the actual native publication returned a durable record ID');
    assert.strictEqual(record.storeType, 3);
    assert.strictEqual(record.kind, 'shop');
    assert.notStrictEqual(record.custodyPolicy, 1, 'a player buy shop holds its bid, it needs no meeting');
    const escrow = Number(record.escrowAdena);
    assert.strictEqual(escrow, executionQuote.price * executionQuote.count, 'the shop holds the whole bid as escrow');
    assert.strictEqual(await bagAmount(stemBuyer, 57), 2000 - escrow, 'the escrow left the wallet');
    assert.strictEqual(await bagAmount(buyerSeed.characterId, 57), 2000, 'the unfunded bot keeps its wallet');
    assert(AfkTrade.findOwnerProjection(stemBuyer), 'a player shop stands in the world');
    assert.deepStrictEqual(MarketOpportunity.activeBuyDemandSelfIds(), [1864],
        'a funded buy ad is demand the warehouse circulation can see');
    const marketSnapshot = MarketSnapshot.snapshot();
    assert.strictEqual(marketSnapshot.dynamic.wtb, 0, 'the snapshot counts only bot-owned stores as dynamic; a player shop is not one');
    assert(Number.isFinite(marketSnapshot.activity.dynamicBuyerSales), 'market snapshot must expose non-mutating trade totals to Observer');
    assert(marketSnapshot.byTown['Elven Village'].fixedWtb > 0, 'starter market coverage must be visible in the market snapshot');

    const town = record.town;
    // One decision point for the seller's sale decision (its rolls stand still).
    const decided = { now: 1791000000000 };
    // Since 71143511 (finite economy planning) the seller standing in Giran
    // answers the local bid itself: no trip, 2 x 100 beats the NPC buy-back.
    assert.deepStrictEqual(BuyStoreService.bestTownFor(seller, decided), { town, value: 2 * executionQuote.price },
        'the seller\'s own native sale decision answers the local public bid');
    const publicOffer = MarketOpportunity.bestBuyOffer(1864, { town, sellerCharacterId: seller.characterId });
    assert.strictEqual(publicOffer.recordId, record.id);
    assert.strictEqual(publicOffer.price, executionQuote.price);
    assert.strictEqual(Number(AfkTrade.ownerRecords(stemBuyer)[0].escrowAdena), escrow);
    const sale = await BuyStoreService.sellToBestBuyer(seller, town, decided);
    assert.strictEqual(sale.sold, true, 'positive is a real SQLite settlement through the bot\'s sale path');
    assert.strictEqual(sale.itemCount, 2);
    assert.strictEqual(sale.adena, 2 * executionQuote.price);
    assert.strictEqual(await bagAmount(seller.characterId, 57), 2 * executionQuote.price, 'the seller is paid from the escrow');
    assert.strictEqual(await bagAmount(seller.characterId, 1864), 0);
    assert.strictEqual(await bagAmount(stemBuyer, 1864), 2, 'the player buyer receives the stems');
    assert.strictEqual(await bagAmount(buyerSeed.characterId, 1864), 0);
    const ad = AfkTrade.ownerRecords(stemBuyer)[0];
    assert.strictEqual(Number(ad.lines[0].count), executionQuote.count - 2);
    assert.strictEqual(Number(ad.escrowAdena), escrow - 2 * executionQuote.price);
    const trade = MarketSnapshot.snapshot().transactions.recentPeerTrades[0];
    assert.strictEqual(trade.channel, 'wtb', 'Observer telemetry must distinguish a buy-ad settlement');
    assert.strictEqual(trade.itemName, 'Stem');
    assert.strictEqual(trade.quantity, 2);

    // An NPC-only skill book never goes to a peer, even into an open ad.
    const chantOfRevenge = DataCache.items.find((item) => item.template?.name === 'Amulet: Chant of Revenge');
    assert(chantOfRevenge);
    const bookBuyer = await makeBot('bot_book_buyer', 'BookBuyer', 40, [{ selfId: 57, name: 'Adena', amount: 100000 }]);
    const bookAsker = await makePlayer('player_book_buyer', 'BookAsker', [{ selfId: 57, name: 'Adena', amount: 100000 }]);
    await AfkTrade.publishBot(bookAsker, { kind: 'shop', storeType: 3, title: 'WTB book', town,
        locX: 82100, locY: 148500, locZ: -3466, lines: [{ selfId: chantOfRevenge.selfId, name: chantOfRevenge.template.name,
            count: 1, price: 5000, stackable: false }] });
    const bookSeller = await makeBot('bot_book_seller', 'BookSeller', 20,
        [{ selfId: chantOfRevenge.selfId, name: chantOfRevenge.template.name, amount: 1 }]);
    assert.strictEqual(BuyStoreService.bestTownFor(bookSeller), null,
        'NPC-only skill books must ignore peer buy-ad demand');
    // A bag with nothing the buy ads ask for makes no sale decision for its trip.
    const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
    const evaluate = ListingPolicy.evaluate;
    let evaluated = 0;
    ListingPolicy.evaluate = (...args) => { evaluated += 1; return evaluate(...args); };
    try {
        assert.strictEqual(BuyStoreService.bestTownFor(bookBuyer), null);
        assert.strictEqual(evaluated, 0, 'no buy ad for the bag: no sale decision');
    } finally {
        ListingPolicy.evaluate = evaluate;
    }
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
    assert.strictEqual(combinedTrades.byItem[0].adena, 2 * executionQuote.price + 150, 'all-channel totals should retain both peer and static turnover');
    assert.strictEqual(combinedTrades.byPeerItem[0].adena, 2 * executionQuote.price, 'peer item totals must exclude static-buyer turnover');

    // The unchanged1000/Stem20 remains a native unfunded negative.
    const poorOriginal = await makeBot('bot_poor_buyer', 'PoorBuyer', 2, [{ selfId: 57, name: 'Adena', amount: 1000 }]);
    const poorBuyer = (await nativeChoice.capture(poorOriginal, { now: 1791000000000 }, 'original_dynamic_poor_buyer')).state;
    const poorBid = BuyStoreService.bidFor(poorBuyer,
        { type: 'buy_craft_material', target: { itemId: 1864, itemName: 'Stem', amount: 20 }, plan: {} });
    assert.strictEqual(Funding.spendable(poorBuyer, 0, { itemId: 1864 }), 0);
    assert.strictEqual(poorBid, null, 'a short wallet without the genuine funded gain posts no partial ad');
    assert.strictEqual(await bagAmount(poorBuyer.characterId, 57), 1000);
    assert.deepStrictEqual(AfkTrade.ownerRecords(poorBuyer.characterId), []);
    const remainingEscrow = Number(AfkTrade.ownerRecords(stemBuyer)[0].escrowAdena);
    assert.strictEqual((await bagAmount(stemBuyer, 57)) + (await bagAmount(seller.characterId, 57)) + remainingEscrow, 2000,
        'the original buyer/seller cash plus the remaining physical ad escrow is conserved');
    assert.strictEqual(await bagAmount(stemBuyer, 1864), 2);
    assert.strictEqual(await bagAmount(seller.characterId, 1864), 0);
    const closed = await AfkTrade.closeBotRecord(stemBuyer, record.id);
    assert.strictEqual(closed.closed, true);
    assert.strictEqual(await bagAmount(stemBuyer, 57), 2000 - 2 * executionQuote.price);
    assert.strictEqual((await bagAmount(stemBuyer, 57)) + (await bagAmount(seller.characterId, 57)), 2000);
    assert.strictEqual((await AfkTrade.closeBotRecord(stemBuyer, record.id)).closed, false,
        'the native remaining escrow is refunded only once');
    assert.deepStrictEqual(Economy.summary().mainColdForState, {});
    console.log(JSON.stringify({ boundary: 'genuine no-funded-bid plus independent native public DAO settlement',
        buyerOriginalWallet: 2000, goalItem: 1864, goalAmount: 5, authoredQuote: executionQuote,
        peerQuantity: 2, peerPaid: 2 * executionQuote.price, remainingEscrow,
        buyerFinal: await bagAmount(stemBuyer, 57), sellerFinal: await bagAmount(seller.characterId, 57),
        nativeMoney: buyerSeed.stats.money, selectedBuyApprovalClaim: false }));

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
