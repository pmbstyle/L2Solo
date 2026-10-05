const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const BotAfkTradeChat = invoke('GameServer/Bot/Economy/BotAfkTradeChat');
const BotManager = invoke('GameServer/Bot/BotManager');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const MarketBuyerActivity = invoke('GameServer/Bot/Economy/MarketBuyerActivity');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const Negotiation = invoke('GameServer/Bot/Economy/BotNegotiationService');
const RemoteChat = invoke('GameServer/Bot/AI/BotRemoteChat');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-afk-market-state.sqlite');
const originalEvaluate = ListingPolicy.evaluate;

function character(name) {
    return { name, race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: -84700, locY: 244200, locZ: -3730 };
}

function amount(rows, selfId) {
    return rows.filter((row) => Number(row.selfId) === Number(selfId))
        .reduce((sum, row) => sum + Number(row.amount), 0);
}

async function run() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();

    await Database.createAccount('bot_afk_state_owner', 'pw');
    await Database.createAccount('afk_state_customer', 'pw');
    const ownerId = Number((await Database.createCharacter('bot_afk_state_owner', character('RemoteTrader'))).insertId);
    const customerId = Number((await Database.createCharacter('afk_state_customer', character('Customer'))).insertId);
    const stockId = Number((await Database.setItem(ownerId, {
        selfId: 1865, name: 'Varnish', amount: 30, enchant: 0, equipped: false, slot: 0
    })).insertId);
    await Database.setItem(ownerId, { selfId: 57, name: 'Adena', amount: 10000000,
        enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(customerId, { selfId: 57, name: 'Adena', amount: 10000,
        enchant: 0, equipped: false, slot: 0 });
    const cWeapon = DataCache.items.find((item) => item?.etc?.rank === 'c'
        && item.template?.kind?.startsWith('Weapon.') && Number(item.template?.price || 0) > 1000);
    assert(cWeapon);
    const customerStockId = Number((await Database.setItem(customerId, {
        selfId: cWeapon.selfId, name: cWeapon.template.name, amount: 1,
        enchant: 0, equipped: false, slot: cWeapon.etc.slot
    })).insertId);
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(ownerId));
    const hunting = await LifeState.upsertState({
        characterId: ownerId, accountName: 'bot_afk_state_owner', name: 'RemoteTrader',
        phase: 'cold', activity: 'hunting', level: 45, adena: amount(await Database.fetchItems(ownerId), 57),
        loc: { locX: -84700, locY: 244200, locZ: -3730 },
        currentRegion: 'Talking Island', inventory,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true }, timing: {}
    }, 'test_bot_afk_hunting');
    assert(hunting);
    ListingPolicy.evaluate = () => ({ listings: [{ selfId: 1865, name: 'Varnish',
        count: 21, price: 100, rank: 'none' }] });
    const sellGoal = { type: 'sell_inventory', status: 'active',
        plan: { expectedBenefit: 'market_sale_inventory' } };
    assert.strictEqual(BotAfkMarket.canTradeRemotely(hunting, sellGoal), true);
    const opened = await BotAfkMarket.reconcile(hunting, sellGoal);
    assert.strictEqual(opened.changed, true);
    assert.strictEqual(opened.state.activity, 'hunting');
    assert.deepStrictEqual(opened.state.loc, hunting.loc);
    assert.strictEqual(opened.state.timing.nextResolveAt, hunting.timing.nextResolveAt);
    assert.strictEqual(opened.shop.storeType, AfkTrade.SELL);
    assert(Math.abs(Number(opened.shop.expiresAt) - (Date.now() + 12 * 60 * 60 * 1000)) < 60000,
        'the shop lives 12 hours of server uptime (the board)');
    assert.strictEqual(opened.shop.town, 'Talking Island');
    assert.strictEqual(MarketSnapshot.snapshot().dynamic.wts, 1,
        'world status should count bot AFK shops');
    assert.strictEqual(amount(await Database.fetchItems(ownerId), 1865), 9);
    assert.strictEqual(AfkTrade.offers(1865, AfkTrade.SELL)[0].sourceType, 'afk_bot_store');
    assert.strictEqual(AfkTrade.offers(1865, AfkTrade.SELL)[0].playerPriority, false);
    assert.strictEqual(MarketOpportunity.bestOffer(1865, { town: 'Talking Island',
        buyerCharacterId: customerId })?.sourceType, 'afk_bot_store',
    'bot purchase planning must see a persistent AFK listing');
    const remotePlayer = { accountId: 'afk_state_customer', dataSendToMe() {}, actor: {
        fetchId: () => customerId, fetchName: () => 'Customer', fetchIsOnline: () => true,
        fetchLocX: () => 900000, fetchLocY: () => 900000, fetchLocZ: () => 0
    } };
    const remoteQuote = Negotiation.quoteItem(AfkTrade.findOwnerProjection(ownerId).session,
        remotePlayer, 1865, 1, 100);
    assert.strictEqual(remoteQuote.ok, true, 'shop owner must negotiate without leaving the hunt');
    assert.strictEqual(Negotiation.declinePrice(AfkTrade.findOwnerProjection(ownerId).session,
        remotePlayer).ok, true);
    assert.strictEqual(await BotAfkMarket.reconcile(opened.state, sellGoal).then((result) => result.changed), false);

    await Database.setItem(ownerId, { selfId: 1865, name: 'Varnish', amount: 2,
        enchant: 0, equipped: false, slot: 0 });
    const withLoot = await LifeState.syncExternalInventory(ownerId, 'test_new_loot', LifeState.snapshot(ownerId));
    ListingPolicy.evaluate = () => ({ listings: [{ selfId: 1865, name: 'Varnish',
        count: 23, price: 100, rank: 'none' }] });
    const refreshed = await BotAfkMarket.reconcile(withLoot, sellGoal);
    assert.strictEqual(refreshed.changed, true, 'new loot should refresh the same persistent shop');
    assert.strictEqual(refreshed.shop.lines[0].count, 23);
    assert.strictEqual((await Database.fetchAfkTradeShops(ownerId)).length, 1);
    const originalFindHot = BotManager.findSessionByName;
    BotManager.findSessionByName = (name) => name === 'RemoteTrader'
        ? { actor: { fetchId: () => ownerId } } : null;
    try {
        const tooSmall = BotAfkTradeChat.parse(LifeState.snapshot(ownerId),
            'offer 90 Adena for Varnish x1', remotePlayer);
        assert.strictEqual((await BotAfkTradeChat.handle(remotePlayer,
            LifeState.snapshot(ownerId), tooSmall)).reason, 'resource_lot_too_small');
        assert.strictEqual(await World.messageBotByName(remotePlayer, remotePlayer.actor,
            'RemoteTrader', 'offer 2200 Adena for Varnish x22'), true);
        assert.strictEqual(await World.messageBotByName(remotePlayer, remotePlayer.actor,
            'RemoteTrader', 'accept'), true);
    } finally {
        BotManager.findSessionByName = originalFindHot;
    }
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId).actor.fetchPrivateStore().items[0].count, 22);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId).actor.fetchPrivateStore().items[0].price, 100);
    assert.strictEqual(LifeState.snapshot(ownerId).activity, 'hunting');

    const bought = await AfkTrade.buyFromShop(customerId,
        AfkTrade.findOwnerProjection(ownerId).actor.fetchPrivateStore(), 1865, 1);
    assert.strictEqual(bought.amount, 1);
    assert.strictEqual(LifeState.snapshot(ownerId).activity, 'hunting');
    assert.strictEqual(LifeState.snapshot(ownerId).adena, 10000100);

    const buyGoal = { type: 'upgrade_gear', status: 'active',
        target: { itemId: cWeapon.selfId, itemName: cWeapon.template.name },
        plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Giran' } };
    const switched = await BotAfkMarket.reconcile(LifeState.snapshot(ownerId), buyGoal);
    assert.strictEqual(switched.changed, true);
    assert.strictEqual(switched.state.activity, 'hunting');
    assert.strictEqual(switched.shop.storeType, AfkTrade.BUY);
    assert.strictEqual(switched.shop.town, 'Giran');
    assert.strictEqual(MarketSnapshot.snapshot().dynamic.wtb, 1);
    assert.strictEqual((await Database.fetchAfkTradeShops(ownerId)).length, 1);
    assert.strictEqual(amount(await Database.fetchItems(ownerId), 1865), 31,
        'switching side must return the unsold escrow');
    assert.strictEqual(AfkTrade.offers(cWeapon.selfId, AfkTrade.BUY)[0].sourceType, 'afk_bot_buy_store');
    assert.strictEqual(await BotAfkMarket.reconcile(switched.state, buyGoal).then((result) => result.changed), false);
    const walletBeforeReprice = LifeState.snapshot(ownerId).adena;
    const repriced = await AfkTrade.repriceBot(ownerId, switched.shop.lines[0].id,
        Number(switched.shop.lines[0].price) - 1, switched.shop.revision);
    assert.strictEqual(repriced.escrowAdena, switched.shop.escrowAdena - 1);
    assert.strictEqual(LifeState.snapshot(ownerId).adena, walletBeforeReprice + 1);
    await assert.rejects(AfkTrade.repriceBot(ownerId, repriced.lines[0].id,
        Number(repriced.lines[0].price) - 1, switched.shop.revision), /afk_trade_shop_changed/);
    const ask = Number(repriced.lines[0].price) + 1;
    const buyOfferReply = await RemoteChat.replyForState(remotePlayer, LifeState.snapshot(ownerId),
        `sell ${cWeapon.template.name} x1 for ${ask} Adena`);
    assert.strictEqual(buyOfferReply.ok, true);
    assert.strictEqual(buyOfferReply.action, 'shop_quote');
    const buyAcceptedReply = await RemoteChat.replyForState(remotePlayer, LifeState.snapshot(ownerId), 'accept');
    assert.strictEqual(buyAcceptedReply.ok, true);
    assert.strictEqual(buyAcceptedReply.action, 'shop_accept');
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId).actor.fetchPrivateStore().items[0].price, ask);
    assert.strictEqual(LifeState.snapshot(ownerId).activity, 'hunting');

    await assert.rejects(Database.createAfkTradeShop(ownerId, {
        replace: true, storeType: AfkTrade.SELL,
        lines: [{ objectId: stockId, selfId: 1865, count: 999, price: 1 }]
    }));
    assert.strictEqual((await Database.fetchAfkTradeShops(ownerId))[0].id, switched.shop.id,
        'failed remote update must leave the prior shop and escrow intact');

    AfkTrade._resetForTests();
    assert.strictEqual(await AfkTrade.init(), 1);
    assert(AfkTrade.findOwnerProjection(ownerId), 'shop state must restore after restart');
    await AfkTrade.sellToShop(customerId,
        AfkTrade.findOwnerProjection(ownerId).actor.fetchPrivateStore(), cWeapon.selfId, 1,
        { objectId: customerStockId });
    assert.strictEqual(LifeState.snapshot(ownerId).activity, 'hunting');
    assert.strictEqual(Number(LifeState.snapshot(ownerId).inventory[cWeapon.selfId]?.amount), 1);
    assert.strictEqual((await Database.fetchAfkTradeShops(ownerId)).length, 0, 'a filled record is closed and deleted');
    const history = await Database.readHistory([
        `SELECT channel, sourceType FROM market_trades ORDER BY id`, []
    ]);
    assert.deepStrictEqual(history.map((row) => row.sourceType), ['afk_bot_store', 'afk_bot_buy_store']);
    const redundantDemand = await BotAfkMarket.reconcile(LifeState.snapshot(ownerId), buyGoal);
    assert.strictEqual(redundantDemand.changed, false,
        'an owned gear target must not reopen a persistent buy order');
    assert.strictEqual((await Database.fetchAfkTradeShops(ownerId)).length, 0);

    const dGradeGoal = { type: 'upgrade_gear', status: 'active',
        target: { itemId: 45, itemName: 'Bone Helmet', adena: 1000000 },
        plan: { expectedBenefit: 'market_search_for_gear', marketTown: 'Giran', priceSource: 'offer' } };
    const dGradeBuyer = await BotAfkMarket.reconcile(LifeState.snapshot(ownerId), dGradeGoal);
    assert.strictEqual(dGradeBuyer.changed, true);
    assert.strictEqual(dGradeBuyer.shop.town, MarketTownPolicy.dGradeMarketFor(dGradeBuyer.state),
        'D-grade buy shops follow the item grade even when the shopping plan points to Giran');
    await BotAfkMarket.withdraw(ownerId);

    await Database.createAccount('bot_afk_second_seller', 'pw');
    await Database.createAccount('bot_afk_second_buyer', 'pw');
    const sellerId = Number((await Database.createCharacter('bot_afk_second_seller', character('SecondSeller'))).insertId);
    const buyerId = Number((await Database.createCharacter('bot_afk_second_buyer', character('SecondBuyer'))).insertId);
    const sellerStockId = Number((await Database.setItem(sellerId, { selfId: 1865, name: 'Varnish',
        amount: 1, enchant: 0, equipped: false, slot: 0 })).insertId);
    await Database.setItem(buyerId, { selfId: 57, name: 'Adena', amount: 200,
        enchant: 0, equipped: false, slot: 0 });
    const stall = { town: 'Giran', locX: 81000, locY: 148000, locZ: -3466,
        appearance: { model: character('SecondTrader') } };
    await AfkTrade.publishBot(buyerId, { ...stall, storeType: AfkTrade.BUY, title: 'WTB Varnish',
        lines: [{ selfId: 1865, name: 'Varnish', count: 1, price: 200, stackable: true }] });
    await AfkTrade.publishBot(sellerId, { ...stall, town: 'Dion', locX: 16308,
        locY: 143760, locZ: -2888, storeType: AfkTrade.SELL, title: 'Varnish',
        lines: [{ objectId: sellerStockId, selfId: 1865, name: 'Varnish',
            count: 1, price: 150, stackable: true }] });
    const peerMatch = await AfkTrade.matchAfkOrders(sellerId);
    assert.strictEqual(peerMatch.trades.length, 1,
        'a bot AFK ask in Dion must fill a crossed bid in Giran');
    assert.strictEqual((await Database.fetchAfkTradeShops(sellerId)).length, 0);
    assert.strictEqual((await Database.fetchAfkTradeShops(buyerId)).length, 0);
    assert.strictEqual(amount(await Database.fetchItems(sellerId), 57), 150);
    assert.strictEqual(amount(await Database.fetchItems(buyerId), 57), 50);
    assert.strictEqual(amount(await Database.fetchItems(buyerId), 1865), 1);
    const crossTownTrade = await Database.readHistory([
        'SELECT town, unitPrice FROM market_trades WHERE sellerCharacterId = ? AND buyerCharacterId = ? ORDER BY id DESC LIMIT 1',
        [sellerId, buyerId]
    ]);
    assert.deepStrictEqual(crossTownTrade, [{ town: 'Dion', unitPrice: 150 }],
        'the trade journal must record the seller town and executed ask');
    const secondVarnishId = Number((await Database.setItem(sellerId, { selfId: 1865,
        name: 'Varnish', amount: 1, enchant: 0, equipped: false, slot: 0 })).insertId);
    const stemId = Number((await Database.setItem(sellerId, { selfId: 1864,
        name: 'Stem', amount: 1, enchant: 0, equipped: false, slot: 0 })).insertId);
    await Database.setItem(buyerId, { selfId: 57, name: 'Adena', amount: 400,
        enchant: 0, equipped: false, slot: 0 });
    await AfkTrade.publishBot(buyerId, { ...stall, storeType: AfkTrade.BUY, title: 'WTB materials',
        lines: [{ selfId: 1865, name: 'Varnish', count: 1, price: 200, stackable: true },
            { selfId: 1864, name: 'Stem', count: 1, price: 200, stackable: true }] });
    await AfkTrade.publishBot(sellerId, { ...stall, storeType: AfkTrade.SELL, title: 'Materials',
        lines: [{ objectId: secondVarnishId, selfId: 1865, name: 'Varnish',
            count: 1, price: 150, stackable: true },
        { objectId: stemId, selfId: 1864, name: 'Stem', count: 1, price: 150, stackable: true }] });
    assert.strictEqual((await AfkTrade.matchAfkOrders(sellerId, 1)).trades.length, 1);
    for (let attempt = 0; attempt < 50 && AfkTrade.findOwnerProjection(sellerId); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.strictEqual(AfkTrade.findOwnerProjection(sellerId), null,
        'bounded matching must continue on the next event-loop turn');
    assert.strictEqual(amount(await Database.fetchItems(buyerId), 1864), 1);

    await Database.createAccount('bot_afk_fallback', 'pw');
    const fallbackId = Number((await Database.createCharacter('bot_afk_fallback', character('FallbackSeller'))).insertId);
    await Database.setItem(fallbackId, { selfId: 1865, name: 'Varnish', amount: 20,
        enchant: 0, equipped: false, slot: 0 });
    const fallbackState = await LifeState.upsertState({
        characterId: fallbackId, accountName: 'bot_afk_fallback', name: 'FallbackSeller',
        phase: 'cold', activity: 'hunting', level: 45, adena: 0,
        loc: { locX: -84700, locY: 244200, locZ: -3730 },
        currentRegion: 'Talking Island',
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(fallbackId)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true }, timing: {}
    }, 'test_bot_afk_fallback');
    ListingPolicy.evaluate = () => ({ listings: [] });
    const fallback = await BotAfkMarket.reconcile(fallbackState, sellGoal);
    assert.strictEqual(fallback.changed, false, 'material fallback must not bypass listing policy');
    assert.strictEqual(AfkTrade.findOwnerProjection(fallbackId), null);
    assert.strictEqual(amount(await Database.fetchItems(fallbackId), 1865), 20);

    ListingPolicy.evaluate = originalEvaluate;
    await Database.createAccount('bot_afk_surplus_gear', 'pw');
    const surplusOwnerId = Number((await Database.createCharacter('bot_afk_surplus_gear',
        character('SurplusSeller'))).insertId);
    const surplusItemId = Number((await Database.setItem(surplusOwnerId, {
        selfId: 45, name: 'Bone Helmet', amount: 1, enchant: 0,
        equipped: false, slot: 0
    })).insertId);
    await Database.setItem(surplusOwnerId, {
        selfId: 45, name: 'Bone Helmet', amount: 1, enchant: 0,
        equipped: true, slot: 6
    });
    await LifeState.upsertState({
        characterId: surplusOwnerId, accountName: 'bot_afk_surplus_gear', name: 'SurplusSeller',
        phase: 'cold', activity: 'hunting', level: 40, adena: 0,
        loc: { locX: -84700, locY: 244200, locZ: -3730 },
        currentRegion: 'Talking Island',
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(surplusOwnerId)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true }, timing: {}
    }, 'test_bot_afk_surplus');
    await AfkTrade.publishBot(surplusOwnerId, {
        storeType: AfkTrade.SELL, title: 'Bone Helmet', town: 'Gludio',
        locX: -14900, locY: 123000, locZ: -3100,
        appearance: { model: character('SurplusSeller') },
        lines: [{ objectId: surplusItemId, selfId: 45, name: 'Bone Helmet',
            count: 1, price: 23223, stackable: false }]
    });
    assert.strictEqual(amount(await Database.fetchItems(surplusOwnerId), 45), 1,
        'the equipped helmet remains with the bot while its duplicate is for sale');
    const originalBuyerActivity = Database.fetchMarketBuyerActivity;
    try {
        MarketBuyerActivity._resetForTests();
        Database.fetchMarketBuyerActivity = () => Promise.resolve([{ selfId: 45, buyers: 2 }]);
        const retained = await BotAfkMarket.reconcile(LifeState.snapshot(surplusOwnerId), null);
        assert.strictEqual(retained.changed, false,
            'a recent buyer with room in the book should keep a persistent gear listing');
        assert(AfkTrade.findOwnerProjection(surplusOwnerId));
    } finally {
        Database.fetchMarketBuyerActivity = originalBuyerActivity;
        MarketBuyerActivity._resetForTests();
        BotAfkMarket._resetForTests();
    }
    const retired = await BotAfkMarket.reconcile(LifeState.snapshot(surplusOwnerId), null);
    assert.strictEqual(retired.withdrawn, true, 'obsolete gear offer must be withdrawn');
    assert.strictEqual(AfkTrade.findOwnerProjection(surplusOwnerId), null);
    assert.strictEqual(amount(await Database.fetchItems(surplusOwnerId), 45), 2,
        'withdrawal must return the item from escrow');
    await Database.createAccount('bot_afk_legacy_fragment', 'pw');
    const fragmentOwnerId = Number((await Database.createCharacter('bot_afk_legacy_fragment',
        character('FragmentSeller'))).insertId);
    const fragmentItemId = Number((await Database.setItem(fragmentOwnerId, { selfId: 1962,
        name: 'Karmian Tunic Pattern', amount: 2, enchant: 0,
        equipped: false, slot: 0 })).insertId);
    const skinId = Number((await Database.setItem(fragmentOwnerId, { selfId: 1867,
        name: 'Animal Skin', amount: 20, enchant: 0, equipped: false, slot: 0 })).insertId);
    const boneId = Number((await Database.setItem(fragmentOwnerId, { selfId: 1872,
        name: 'Animal Bone', amount: 20, enchant: 0, equipped: false, slot: 0 })).insertId);
    const legacyFragment = await Database.createAfkTradeShop(fragmentOwnerId, {
        storeType: AfkTrade.SELL, town: 'Elven Village',
        locX: 46600, locY: 50000, locZ: -3060,
        appearance: { model: character('FragmentSeller') },
        lines: [{ objectId: fragmentItemId, selfId: 1962,
            name: 'Karmian Tunic Pattern', count: 2, price: 48750, stackable: true },
        { objectId: skinId, selfId: 1867, name: 'Animal Skin',
            count: 20, price: 1200, stackable: true },
        { objectId: boneId, selfId: 1872, name: 'Animal Bone',
            count: 20, price: 1215, stackable: true }]
    });
    await AfkTrade._resetForTests();
    assert.strictEqual(await AfkTrade.init(), 1);
    // A restart moves nothing on the board: the old world's bot records
    // closed once at the board's first start (Database.migrateBoardWorld).
    const restoredFragment = (await Database.fetchAfkTradeShops(fragmentOwnerId))[0];
    assert.strictEqual(restoredFragment.id, legacyFragment.shop.id, 'a restart keeps a record as it is');
    assert.strictEqual(restoredFragment.town, 'Elven Village');
    assert.strictEqual(restoredFragment.lines.find((line) => line.selfId === 1962).count, 2);
    assert.strictEqual(amount(await Database.fetchItems(fragmentOwnerId), 1962), 0);
    const fragmentState = { characterId: fragmentOwnerId, name: 'FragmentSeller' };
    const casualOffer = BotAfkTradeChat.parse(fragmentState,
        '47k for karmian?', remotePlayer);
    assert.strictEqual(casualOffer?.action, 'quote', 'natural price shorthand must reach the shop tool');
    assert.strictEqual(casualOffer.itemId, 1962, 'partial item name must resolve one listed line');
    assert.strictEqual(casualOffer.totalPrice, 47000);
    assert.strictEqual((await BotAfkTradeChat.handle(remotePlayer, fragmentState, casualOffer)).ok, true);
    const clarifiedOffer = BotAfkTradeChat.parse(fragmentState,
        'karmian tunic pattern for 47k?', remotePlayer);
    assert.strictEqual(clarifiedOffer?.action, 'counter');
    assert.strictEqual((await BotAfkTradeChat.handle(remotePlayer, fragmentState, clarifiedOffer)).ok, true);
    assert(Negotiation.activeSummary(AfkTrade.findOwnerProjection(fragmentOwnerId).session),
        'the natural offer must create a negotiation owned by the shop');
    assert.strictEqual(Negotiation.activeSummary(AfkTrade.findOwnerProjection(fragmentOwnerId).session).playerName,
        remotePlayer.actor.fetchName());
    const casualAccept = BotAfkTradeChat.parse(fragmentState, 'yes, for one', remotePlayer);
    assert.strictEqual(casualAccept?.action, 'accept');
    assert.strictEqual((await BotAfkTradeChat.handle(remotePlayer, fragmentState, casualAccept)).ok, true);
    assert.strictEqual((await Database.fetchAfkTradeShops(fragmentOwnerId))[0].lines
        .find((line) => line.selfId === 1962).price, 47000,
        'agreement must update the real persistent shop');
    const updateRequest = BotAfkTradeChat.parse(fragmentState, 'update the shop', remotePlayer);
    assert.strictEqual(updateRequest?.action, 'status');
    assert.match((await BotAfkTradeChat.handle(remotePlayer, fragmentState, updateRequest)).reply,
        /47000 Adena/, 'after the shop changed, a status request must report its actual price');

    const originalRate = process.env.L2NODE_PROGRESSION_RATE;
    try {
        process.env.L2NODE_PROGRESSION_RATE = 'x1';
        const x1Minimum = BotAfkMarket.minimumResourceLotValue();
        process.env.L2NODE_PROGRESSION_RATE = 'x10';
        assert.strictEqual(BotAfkMarket.minimumResourceLotValue(), x1Minimum * 10);
        assert.strictEqual(BotAfkMarket.viableSellLine({ selfId: 1865, count: 19, price: 1000 }), false);
        assert.strictEqual(BotAfkMarket.viableSellLine({ selfId: 1865, count: 20, price: 1000 }), true);
        assert.strictEqual(BotAfkMarket.viableSellLine({ selfId: 1875, count: 1, price: 25000 }), false,
            'even an expensive common resource must have at least five units');
        assert.strictEqual(BotAfkMarket.viableSellLine({ selfId: 1875, count: 5, price: 25000 }), true);
        assert.strictEqual(BotAfkMarket.viableSellLine({ selfId: 2508, count: 4, price: 5000 }), false);
        assert.strictEqual(BotAfkMarket.viableSellLine({ selfId: 1962, count: 1, price: 48750 }), true);
        assert.strictEqual(BotAfkMarket.viableSellLine({ selfId: 2095, count: 1, price: 333305 }), true,
            'a weapon blade is a crafting piece, not a bulk resource');
        assert.strictEqual(BotAfkMarket.viableSellLine({ selfId: cWeapon.selfId, count: 1, price: 1 }), true);
        process.env.L2NODE_PROGRESSION_RATE = 'x50';
        assert.strictEqual(BotAfkMarket.minimumResourceLotValue(), x1Minimum * 50);
        process.env.L2NODE_PROGRESSION_RATE = 'x10';

        await Database.createAccount('bot_afk_lot_seller', 'pw');
        const lotOwnerId = Number((await Database.createCharacter('bot_afk_lot_seller',
            character('LotSeller'))).insertId);
        const lotStockId = Number((await Database.setItem(lotOwnerId, { selfId: 1865,
            name: 'Varnish', amount: 19, enchant: 0, equipped: false, slot: 0 })).insertId);
        const lotState = await LifeState.upsertState({
            characterId: lotOwnerId, accountName: 'bot_afk_lot_seller', name: 'LotSeller',
            phase: 'cold', activity: 'hunting', level: 45, adena: 0,
            loc: { locX: -84700, locY: 244200, locZ: -3730 },
            currentRegion: 'Talking Island',
            inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(lotOwnerId)),
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
            stats: { generatedCold: true }, timing: {}
        }, 'test_bot_afk_lot');
        ListingPolicy.evaluate = (state) => ({ listings: [{ selfId: 1865, name: 'Varnish',
            kind: 'Other.Material', count: Number(state.inventory?.['1865']?.amount || 0), price: 1000 }] });
        const premature = await BotAfkMarket.reconcile(lotState, sellGoal);
        assert.strictEqual(premature.changed, false);
        assert.strictEqual(AfkTrade.findOwnerProjection(lotOwnerId), null);
        assert.strictEqual(amount(await Database.fetchItems(lotOwnerId), 1865), 19);
        await Database.updateItemAmount(lotOwnerId, lotStockId, 20);
        const accumulated = await LifeState.syncExternalInventory(lotOwnerId,
            'test_lot_accumulated', LifeState.snapshot(lotOwnerId));
        const bulk = await BotAfkMarket.reconcile(accumulated, sellGoal);
        assert.strictEqual(bulk.changed, true);
        assert.strictEqual(bulk.shop.lines[0].count, 20);
        assert.strictEqual(bulk.shop.lines[0].price, 1000);
        await AfkTrade.buyFromShop(customerId,
            AfkTrade.findOwnerProjection(lotOwnerId).actor.fetchPrivateStore(), 1865, 1);
        assert.strictEqual(AfkTrade.findOwnerProjection(lotOwnerId), null);
        assert.strictEqual(amount(await Database.fetchItems(lotOwnerId), 1865), 19,
            'a sub-threshold remainder must return to the bot in the trade commit');
        assert.strictEqual((await BotAfkMarket.reconcile(LifeState.snapshot(lotOwnerId), sellGoal)).changed, false,
            'the returned remainder must not reopen an underpriced shop');

        await Database.createAccount('bot_afk_old_small_lot', 'pw');
        const oldOwnerId = Number((await Database.createCharacter('bot_afk_old_small_lot',
            character('OldLotSeller'))).insertId);
        const oldResourceId = Number((await Database.setItem(oldOwnerId, { selfId: 1875,
            name: 'Stone of Purity', amount: 1, enchant: 0, equipped: false, slot: 0 })).insertId);
        const oldPatternId = Number((await Database.setItem(oldOwnerId, { selfId: 1962,
            name: 'Karmian Tunic Pattern', amount: 1, enchant: 0,
            equipped: false, slot: 0 })).insertId);
        await AfkTrade.publishBot(oldOwnerId, {
            storeType: AfkTrade.SELL, title: 'Old materials', town: 'Giran',
            locX: 81100, locY: 148000, locZ: -3466,
            appearance: { model: character('OldLotSeller') },
            lines: [{ objectId: oldResourceId, selfId: 1875,
                name: 'Stone of Purity', count: 1, price: 25000, stackable: true },
            { objectId: oldPatternId, selfId: 1962,
                name: 'Karmian Tunic Pattern', count: 1, price: 48750, stackable: true }]
        });
        AfkTrade._resetForTests();
        assert.strictEqual(await AfkTrade.init(), 2);
        assert.deepStrictEqual(AfkTrade.findOwnerProjection(oldOwnerId).shop.lines.map((line) => Number(line.selfId)), [1875, 1962],
            'a restart keeps a record as it is; the owner\'s next review prunes its lots');
    } finally {
        if (originalRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
        else process.env.L2NODE_PROGRESSION_RATE = originalRate;
    }

    await Database.createAccount('bot_afk_gear_seller', 'pw');
    await Database.createAccount('bot_afk_gear_buyer', 'pw');
    const gearSellerId = Number((await Database.createCharacter('bot_afk_gear_seller',
        character('GearSeller'))).insertId);
    const gearBuyerId = Number((await Database.createCharacter('bot_afk_gear_buyer',
        character('GearBuyer'))).insertId);
    const helmetObjectId = Number((await Database.setItem(gearSellerId, {
        selfId: 45, name: 'Bone Helmet', amount: 1, enchant: 0, equipped: false, slot: 0
    })).insertId);
    await Database.setItem(gearBuyerId, {
        selfId: 57, name: 'Adena', amount: 100000, enchant: 0, equipped: false, slot: 0
    });
    const gearBuyer = await LifeState.upsertState({
        characterId: gearBuyerId, accountName: 'bot_afk_gear_buyer', name: 'GearBuyer',
        phase: 'cold', activity: 'shopping', level: 40, adena: 100000,
        loc: { locX: -84700, locY: 244200, locZ: -3730 },
        currentRegion: 'Gludio',
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(gearBuyerId)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, classId: 0,
            equipmentPlan: { status: 'active', strategy: 'market',
                target: { selfId: 45, name: 'Bone Helmet', slot: 6 } } }, timing: {}
    }, 'test_afk_gear_buyer');
    await AfkTrade.publishBot(gearSellerId, {
        storeType: AfkTrade.SELL, title: 'Bone Helmet', town: 'Gludio',
        locX: -14900, locY: 123000, locZ: -3100,
        appearance: { model: character('GearSeller') },
        lines: [{ objectId: helmetObjectId, selfId: 45, name: 'Bone Helmet',
            count: 1, price: 25000, stackable: false }]
    });
    const gearTrade = await AfkTrade.buyFromShop(gearBuyerId,
        AfkTrade.findOwnerProjection(gearSellerId).actor.fetchPrivateStore(), 45, 1,
        { coldState: gearBuyer });
    assert.strictEqual(gearTrade.coldState.inventory[45].equipped, true,
        'AFK market gear should be equipped during the committed trade sync');
    assert.strictEqual(gearTrade.coldState.stats.equipmentPlan, undefined,
        'equipping the purchased target completes the acquisition plan');
    assert.strictEqual((await Database.fetchItems(gearBuyerId))
        .find((item) => Number(item.selfId) === 45)?.equipped, 1,
        'the physical inventory must keep the equipped slot after a restart');

    ListingPolicy.evaluate = originalEvaluate;
    await Database.createAccount('bot_afk_recipe_seller', 'pw');
    await Database.createAccount('bot_afk_recipe_buyer', 'pw');
    const recipeSellerId = Number((await Database.createCharacter('bot_afk_recipe_seller',
        character('RecipeSeller'))).insertId);
    const recipeBuyerId = Number((await Database.createCharacter('bot_afk_recipe_buyer',
        character('RecipeBuyer'))).insertId);
    const materialRows = [];
    for (const selfId of [1864, 1865, 1866]) {
        const inserted = await Database.setItem(recipeSellerId, { selfId, name: `Material ${selfId}`,
            amount: 10, equipped: false, slot: 0 });
        materialRows.push({ objectId: Number(inserted.insertId), selfId,
            name: `Material ${selfId}`, count: 10, price: 100000, stackable: true });
    }
    await Database.setItem(recipeSellerId, { selfId: 3033, name: 'Recipe: Spiritshot C',
        amount: 1, equipped: false, slot: 0 });
    await Database.setItem(recipeBuyerId, { selfId: 57, name: 'Adena', amount: 1000000,
        equipped: false, slot: 0 });
    await LifeState.upsertState({ characterId: recipeSellerId, accountName: 'bot_afk_recipe_seller',
        name: 'RecipeSeller', phase: 'cold', activity: 'hunting', level: 45, adena: 0,
        currentRegion: 'Giran', loc: { locX: 81100, locY: 148000, locZ: -3466 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(recipeSellerId)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, classId: 28 }, timing: {} }, 'recipe_seller_ready');
    await LifeState.upsertState({ characterId: recipeBuyerId, accountName: 'bot_afk_recipe_buyer',
        name: 'RecipeBuyer', phase: 'cold', activity: 'hunting', level: 60, adena: 1000000,
        currentRegion: 'Giran', loc: { locX: 81100, locY: 148000, locZ: -3466 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(recipeBuyerId)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, classId: 57,
            shotRecipeDemand: { itemId: 3033, amount: 1, maxSpend: 1000000, at: Date.now() } },
        timing: {} }, 'recipe_buyer_ready');
    await AfkTrade.publishBot(recipeSellerId, { storeType: AfkTrade.SELL, title: 'Materials',
        town: 'Giran', locX: 81100, locY: 148000, locZ: -3466,
        appearance: { model: character('RecipeSeller') }, lines: materialRows });
    const recipeShop = await BotAfkMarket.reconcile(LifeState.snapshot(recipeSellerId), sellGoal);
    assert.strictEqual(recipeShop.changed, true,
        'funded recipe demand should refresh a full three-line AFK shop');
    assert(recipeShop.shop.lines.some((line) => Number(line.selfId) === 3033),
        'the demanded recipe must take one slot while displaced materials return to inventory');
    await Database.setItem(recipeSellerId, { selfId: 2511, name: 'Spiritshot: C-grade',
        amount: 1000, equipped: false, slot: 0 });
    const shotSeller = await LifeState.syncExternalInventory(recipeSellerId,
        'test_shots_crafted', LifeState.snapshot(recipeSellerId));
    await LifeState.upsertState({ ...shotSeller, stats: { ...shotSeller.stats,
        shotCraft: { productId: 2511, amount: 1000, at: Date.now() }
    } }, 'shot_seller_ready');
    const shotBuyer = LifeState.snapshot(recipeBuyerId);
    await LifeState.upsertState({ ...shotBuyer, stats: { ...shotBuyer.stats,
        shotDemand: { itemId: 2511, amount: 1000, maxSpend: 1000000, at: Date.now() }
    } }, 'shot_buyer_ready');
    const shotShop = await BotAfkMarket.reconcile(LifeState.snapshot(recipeSellerId), sellGoal);
    assert(shotShop.shop.lines.some((line) => Number(line.selfId) === 2511),
        'funded crafted shots must take a slot in a full AFK shop');
    assert(shotShop.shop.lines.some((line) => Number(line.selfId) === 3033),
        'a shot listing must retain the funded recipe listing');
    await Database.setItem(recipeSellerId, { selfId: 3032, name: 'Recipe: Spiritshot D',
        amount: 1, equipped: false, slot: 0 });
    await LifeState.syncExternalInventory(recipeSellerId,
        'test_d_recipe_drop', LifeState.snapshot(recipeSellerId));
    const scarceRecipeShop = await BotAfkMarket.reconcile(LifeState.snapshot(recipeSellerId), sellGoal);
    assert(scarceRecipeShop.shop.lines.some((line) => Number(line.selfId) === 3032),
        'a scarce D-grade shot recipe must enter a full shop without an explicit buyer');
    await AfkTrade._resetForTests();
    BotAfkMarket._resetForTests();
    console.log('Bot AFK market state checks passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    ListingPolicy.evaluate = originalEvaluate;
});
