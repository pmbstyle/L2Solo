// A player's AFK shop meets the bots' board records at once (step 3.3): a
// crossed bot buy ad fills the player's sell shop, a crossed bot sell ad
// fills the player's buy shop, at the ask. The bots' bags follow at their
// next save (here at once: the worker does not hold them).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const PrivateStore = invoke('GameServer/PrivateStore');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-afk-trade-bot-matching.sqlite');

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
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

async function coldBot(characterId, name) {
    return BotLifeState.upsertState({
        characterId, accountName: `bot_${name.toLowerCase()}`, name, level: 40,
        adena: 0, phase: 'cold', activity: 'hunting', currentRegion: 'Giran',
        loc: { locX: 83100, locY: 148100, locZ: -3400 },
        inventory: BotLifeState.inventorySummaryFromItems(await Database.fetchItems(characterId)),
        stats: { generatedCold: true }, timing: {}, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }
    }, 'test_seed');
}

async function amount(characterId, selfId) {
    return (await Database.fetchItems(characterId)).filter((row) => Number(row.selfId) === selfId)
        .reduce((sum, row) => sum + Number(row.amount), 0);
}

const VARNISH = 1865;
const ad = (kind, lines) => ({ kind, storeType: kind === 'sell_ad' ? 1 : 3, title: 'Varnish', town: 'Giran',
    locX: 0, locY: 0, locZ: 0, lines });

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
        selfId: VARNISH, name: 'Varnish', amount: 1, enchant: 0, equipped: false, slot: 0
    })).insertId);
    await Database.setItem(ownerId, { selfId: 57, name: 'Adena', amount: 20, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(buyerId, { selfId: 57, name: 'Adena', amount: 100, enchant: 0, equipped: false, slot: 0 });
    const sellerStockId = Number((await Database.setItem(sellerId, {
        selfId: VARNISH, name: 'Varnish', amount: 1, enchant: 0, equipped: false, slot: 0
    })).insertId);

    const ownerRow = (await Database.fetchCharacters('afk_match_owner'))[0];
    const owner = sessionFor('afk_match_owner', ownerRow, await Database.fetchItems(ownerId));
    World.user.sessions.push(owner);

    await BotLifeState.init();
    await AfkTrade.init();
    await coldBot(buyerId, 'BotBuyer');
    await coldBot(sellerId, 'BotSeller');
    await AfkTrade.publishBot(buyerId, ad('buy_ad', [{ selfId: VARNISH, name: 'Varnish', count: 1, price: 11, stackable: true }]));
    assert.strictEqual(BotLifeState.snapshot(buyerId).adena, 89, 'the buy ad holds its escrow');

    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.SELL), true);
    assert.strictEqual(PrivateStore.setTitle(owner, AfkTrade.SELL, 'Player first'), true);
    assert.strictEqual(await PrivateStore.publishSell(owner, false, [{
        objectId: ownerStockId, count: 1, price: 10
    }]), true);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId), null,
        'a crossed bot bid must fill the AFK player WTS immediately');
    const filledBuyer = BotLifeState.snapshot(buyerId);
    assert.strictEqual(filledBuyer.adena, 90, 'the deal is at the ask; the rest of the bid comes back');
    assert.strictEqual(filledBuyer.inventory[String(VARNISH)].amount, 1);
    assert.strictEqual(AfkTrade.ownerRecords(buyerId).length, 0, 'a filled ad is closed and deleted');
    assert.strictEqual(owner.actor.backpack.fetchTotalAdena(), 30, 'the player is paid in the same deal');

    await AfkTrade.publishBot(sellerId, ad('sell_ad', [{ objectId: sellerStockId, selfId: VARNISH, name: 'Varnish',
        count: 1, price: 9, stackable: true }]));
    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.BUY), true);
    assert.strictEqual(PrivateStore.setTitle(owner, AfkTrade.BUY, 'Player demand'), true);
    assert.strictEqual(await PrivateStore.publishBuy(owner, [{ selfId: VARNISH, enchant: 0, count: 1, price: 10 }]), true);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId), null,
        'a crossed bot ask must fill the AFK player WTB immediately');
    const filledSeller = BotLifeState.snapshot(sellerId);
    assert.strictEqual(filledSeller.adena, 9);
    assert.strictEqual(filledSeller.inventory[String(VARNISH)], undefined);
    assert.strictEqual(owner.actor.backpack.fetchItemFromSelfId(VARNISH).fetchAmount(), 1);
    assert.strictEqual(owner.actor.backpack.fetchTotalAdena(), 21,
        'the player sold at 10 and bought at the ask of 9');

    await AfkTrade.publishBot(buyerId, ad('buy_ad', [{ selfId: VARNISH, name: 'Varnish', count: 1, price: 9, stackable: true }]));
    const returnedStock = owner.actor.backpack.fetchItemFromSelfId(VARNISH);
    assert.strictEqual(await AfkTrade.begin(owner, AfkTrade.SELL), true);
    assert.strictEqual(PrivateStore.setTitle(owner, AfkTrade.SELL, 'No bad price'), true);
    assert.strictEqual(await PrivateStore.publishSell(owner, false, [{
        objectId: returnedStock.fetchId(), count: 1, price: 10
    }]), true);
    assert(AfkTrade.findOwnerProjection(ownerId),
        'a bot bid below the player ask must not force an unfavorable trade');

    const lowBid = AfkTrade.ownerRecords(buyerId)[0];
    await AfkTrade.repriceBot(buyerId, lowBid.lines[0].id, 11, lowBid.revision, null, { match: false });
    await AfkTrade._resetForTests();
    assert.strictEqual(await AfkTrade.init(), 2, 'the player shop and the bot ad come back on startup');
    const restoredMatch = await AfkTrade.matchBotDemand();
    assert.strictEqual(restoredMatch.matched, true,
        'a restored AFK shop must be matched after bot market state is ready');
    assert.strictEqual(restoredMatch.itemCount, 1);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId), null);

    const events = await Database.readHistory([
        'SELECT kind, selfId, amount, unitPrice, totalPrice FROM afk_trade_events WHERE ownerId = ? ORDER BY id ASC',
        [ownerId]
    ], 'test:afk-bot-matching-events');
    assert.deepStrictEqual(events, [{
        kind: 'sale', selfId: VARNISH, amount: 1, unitPrice: 10, totalPrice: 10
    }, {
        kind: 'purchase', selfId: VARNISH, amount: 1, unitPrice: 9, totalPrice: 9
    }, {
        kind: 'sale', selfId: VARNISH, amount: 1, unitPrice: 10, totalPrice: 10
    }]);
    assert.strictEqual(await amount(buyerId, VARNISH), 2);

    await AfkTrade._resetForTests();
    await Database.close();
    clean();
    console.log('AFK bot market matching checks passed');
})().catch(async (error) => {
    console.error(error);
    try { AfkTrade._resetForTests(); } catch (_) {}
    try { await Database.close(); } catch (_) {}
    clean();
    process.exitCode = 1;
});
