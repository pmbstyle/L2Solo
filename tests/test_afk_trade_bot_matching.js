const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const PrivateStore = invoke('GameServer/PrivateStore');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-afk-trade-bot-matching.sqlite');

function clean() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
}

function character(name) {
    return {
        name,
        race: 0,
        classId: 0,
        maxHp: 100,
        maxMp: 100,
        sex: 0,
        face: 0,
        hair: 0,
        hairColor: 0,
        locX: 83000,
        locY: 148000,
        locZ: -3400
    };
}

function sessionFor(accountId, row, items) {
    const session = {
        accountId,
        socket: { write() {} },
        fetchAccountId() { return this.accountId; },
        dataSendToMe() {},
        dataSendToOthers() {},
        dataSendToMeAndOthers() {}
    };
    const classInfo = DataCache.classTemplates.find((entry) => Number(entry.classId) === Number(row.classId));
    session.actor = new Actor(session, {
        ...row,
        ...utils.crushOb(classInfo),
        items,
        paperdoll: utils.tupleAlloc(16, {})
    });
    session.actor.setIsOnline(true);
    return session;
}

function coldState(characterId, name, inventory, store) {
    return {
        characterId,
        accountName: `bot_${name.toLowerCase()}`,
        name,
        level: 40,
        adena: Number(inventory['57']?.amount || 0),
        phase: 'cold',
        activity: 'merchant',
        currentRegion: 'Giran',
        loc: { locX: 83100, locY: 148100, locZ: -3400 },
        inventory,
        stats: {
            marketStore: store,
            marketWanted: Number(store.storeType) === 3
                ? { itemId: 1865, itemName: 'Varnish', amount: 1, maxPrice: store.items[0].price, lastMissingAt: Date.now() }
                : null
        },
        timing: { activityStartedAt: Date.now(), nextResolveAt: store.expiresAt },
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }
    };
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };

    for (const account of ['afk_match_owner', 'bot_market_buyer', 'bot_market_seller']) {
        await Database.createAccount(account, 'pw');
    }
    const ownerId = Number((await Database.createCharacter('afk_match_owner', character('PlayerMerchant'))).insertId);
    const buyerId = Number((await Database.createCharacter('bot_market_buyer', character('BotBuyer'))).insertId);
    const sellerId = Number((await Database.createCharacter('bot_market_seller', character('BotSeller'))).insertId);
    const ownerStockId = Number((await Database.setItem(ownerId, {
        selfId: 1865, name: 'Varnish', amount: 1, enchant: 0, equipped: false, slot: 0
    })).insertId);
    await Database.setItem(ownerId, { selfId: 57, name: 'Adena', amount: 20, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(buyerId, { selfId: 57, name: 'Adena', amount: 100, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(sellerId, { selfId: 57, name: 'Adena', amount: 0, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(sellerId, { selfId: 1865, name: 'Varnish', amount: 1, enchant: 0, equipped: false, slot: 0 });

    const ownerRow = (await Database.fetchCharacters('afk_match_owner'))[0];
    const owner = sessionFor('afk_match_owner', ownerRow, await Database.fetchItems(ownerId));
    World.user.sessions.push(owner);

    await BotLifeState.init();
    const expiresAt = Date.now() + 20 * 60 * 1000;
    const buyer = await BotLifeState.upsertState(coldState(buyerId, 'BotBuyer', {
        57: { selfId: 57, name: 'Adena', amount: 100 }
    }, {
        storeType: 3,
        budgetBacked: true,
        town: 'Giran',
        expiresAt,
        items: [{ selfId: 1865, name: 'Varnish', count: 1, price: 11 }]
    }), 'test_afk_matching_buyer');
    const seller = await BotLifeState.upsertState(coldState(sellerId, 'BotSeller', {
        57: { selfId: 57, name: 'Adena', amount: 0 },
        1865: { selfId: 1865, name: 'Varnish', amount: 1, equipped: false, stackable: true, slot: 0, kind: 'Other.Material' }
    }, {
        storeType: 1,
        town: 'Giran',
        expiresAt,
        items: [{ selfId: 1865, name: 'Varnish', count: 1, price: 9 }]
    }), 'test_afk_matching_seller');
    MarketOpportunity.resetColdStores();
    MarketOpportunity.indexColdStore(buyer);
    MarketOpportunity.indexColdStore(seller);

    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.SELL), true);
    assert.strictEqual(PrivateStore.setTitle(owner, AfkTrade.SELL, 'Player first'), true);
    assert.strictEqual(await PrivateStore.publishSell(owner, false, [{
        objectId: ownerStockId, count: 1, price: 10
    }]), true);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId), null,
        'a crossed bot bid must fill the AFK player WTS immediately');
    const filledBuyer = BotLifeState.snapshot(buyerId);
    assert.strictEqual(filledBuyer.adena, 90);
    assert.strictEqual(filledBuyer.inventory['1865'].amount, 1);
    assert.strictEqual(filledBuyer.stats.marketStore, null);
    assert.strictEqual(BotLifeState.snapshot(sellerId).inventory['1865'].amount, 1,
        'the player WTS must take priority over a cheaper bot WTS when the bot bid crosses the player ask');

    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.BUY), true);
    assert.strictEqual(PrivateStore.setTitle(owner, AfkTrade.BUY, 'Player demand'), true);
    assert.strictEqual(await PrivateStore.publishBuy(owner, [{ selfId: 1865, enchant: 0, count: 1, price: 10 }]), true);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId), null,
        'a crossed bot ask must fill the AFK player WTB immediately');
    const filledSeller = BotLifeState.snapshot(sellerId);
    assert.strictEqual(filledSeller.adena, 10);
    assert.strictEqual(filledSeller.inventory['1865'], undefined);
    assert.strictEqual(filledSeller.stats.marketStore, null);
    assert.strictEqual(owner.actor.backpack.fetchItemFromSelfId(1865).fetchAmount(), 1);
    assert.strictEqual(owner.actor.backpack.fetchTotalAdena(), 20,
        'the completed sell and buy must preserve the player wallet');

    const lowBidBuyer = await BotLifeState.upsertState({
        ...filledBuyer,
        activity: 'merchant',
        stats: {
            ...(filledBuyer.stats || {}),
            marketStore: {
                storeType: 3,
                budgetBacked: true,
                town: 'Giran',
                expiresAt,
                items: [{ selfId: 1865, name: 'Varnish', count: 1, price: 9 }]
            },
            marketWanted: { itemId: 1865, itemName: 'Varnish', amount: 1, maxPrice: 9, lastMissingAt: Date.now() }
        }
    }, 'test_afk_matching_low_bid');
    MarketOpportunity.indexColdStore(lowBidBuyer);
    const returnedStock = owner.actor.backpack.fetchItemFromSelfId(1865);
    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.SELL), true);
    assert.strictEqual(PrivateStore.setTitle(owner, AfkTrade.SELL, 'No bad price'), true);
    assert.strictEqual(await PrivateStore.publishSell(owner, false, [{
        objectId: returnedStock.fetchId(), count: 1, price: 10
    }]), true);
    assert(AfkTrade.findOwnerProjection(ownerId),
        'a bot bid below the player ask must not force an unfavorable trade');

    await BotLifeState.upsertState({
        ...lowBidBuyer,
        stats: {
            ...(lowBidBuyer.stats || {}),
            marketStore: {
                ...lowBidBuyer.stats.marketStore,
                items: [{ selfId: 1865, name: 'Varnish', count: 1, price: 11 }]
            },
            marketWanted: { itemId: 1865, itemName: 'Varnish', amount: 1, maxPrice: 11, lastMissingAt: Date.now() }
        }
    }, 'test_afk_matching_restored_bid');
    await AfkTrade._resetForTests();
    MarketOpportunity.resetColdStores();
    assert.strictEqual(await AfkTrade.init(), 1, 'the active AFK shop must be restored on startup');
    const restoredMatch = await AfkTrade.matchBotDemand();
    assert.strictEqual(restoredMatch.matched, true,
        'a restored AFK shop must be matched after bot market state is ready');
    assert.strictEqual(restoredMatch.shops, 1);
    assert.strictEqual(restoredMatch.itemCount, 1);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId), null);

    const events = await Database.execute([
        'SELECT kind, selfId, amount, unitPrice, totalPrice FROM afk_trade_events WHERE ownerId = ? ORDER BY id ASC',
        [ownerId]
    ], 'test:afk-bot-matching-events');
    assert.deepStrictEqual(events, [{
        kind: 'sale', selfId: 1865, amount: 1, unitPrice: 10, totalPrice: 10
    }, {
        kind: 'purchase', selfId: 1865, amount: 1, unitPrice: 10, totalPrice: 10
    }, {
        kind: 'sale', selfId: 1865, amount: 1, unitPrice: 10, totalPrice: 10
    }]);

    await AfkTrade._resetForTests();
    MarketOpportunity.resetColdStores();
    await Database.close();
    clean();
    console.log('AFK bot market matching checks passed');
})().catch(async (error) => {
    console.error(error);
    try { AfkTrade._resetForTests(); } catch (_) {}
    try { MarketOpportunity.resetColdStores(); } catch (_) {}
    try { await Database.close(); } catch (_) {}
    clean();
    process.exitCode = 1;
});
