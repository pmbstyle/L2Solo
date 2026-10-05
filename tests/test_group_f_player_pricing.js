const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const Configs = invoke('GameServer/Bot/MerchantStoreConfigs');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const MarketSnapshot = invoke('GameServer/Bot/Economy/MarketSnapshot');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const Purchase = invoke('GameServer/Network/Request/Purchase');
const Select = invoke('GameServer/Actor/Generics/Select');
const Sell = invoke('GameServer/Network/Request/Sell');
const ServerResponse = invoke('GameServer/Network/Response');
const TradeService = invoke('GameServer/Bot/TradeService');
const World = invoke('GameServer/World/World');
const BuyHtml = invoke('GameServer/World/Generics/NpcBypasses/BuyMerchantItem');
const SellHtml = invoke('GameServer/World/Generics/NpcBypasses/SellToMerchantItem');

const MATERIAL = 1864;
const SHOT = 1835;
const board = AfkTrade.boardIndex();
fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });
const fixtureDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'test-group-f-player-pricing-'));
const failures = [];
const cases = [];
const test = (name, run) => cases.push({ name, run });
const originals = { recordTrade: MarketTelemetry.recordTrade, update: Database.updateItemAmount,
    social: BotSocialMemory.recordTradeCompleted, sessions: BotManager.sessions, user: World.user };
const responseNames = ['actionFailed', 'speak', 'destSelected', 'relationChanged', 'privateStoreMsg', 'privateStoreBuyMsg',
    'purchaseList', 'privateStoreListBuy', 'sellList', 'itemsList', 'userInfo', 'npcHtml'];
const responses = Object.fromEntries(responseNames.map(name => [name, ServerResponse[name]]));
let records = [];
const allRecords = [];

function line(recordId, storeType, price, { kind = storeType === 3 ? 'buy_ad' : 'sell_ad', selfId = MATERIAL,
    count = 10, town = 'Giran' } = {}) {
    board.put({ id: recordId, kind, storeType, ownerId: recordId + 50000, town,
        lines: [{ lineId: recordId, selfId, enchant: 0, count, price }] });
}

function staticStore(config, id = MATERIAL) {
    const source = { ...config, items: config.items.filter(item => Number(item.selfId) === id) };
    return { storeType: source.storeType, title: source.title, town: source.town, revision: 1,
        items: TradeService.normalizeStoreItems(source, { staticStore: true }) };
}

function merchant(store, id = 82000, name = 'IslandMats') {
    return { fetchId: () => id, fetchName: () => name, fetchPrivateStore: () => store,
        fetchPrivateStoreType: () => store.storeType, fetchTitle: () => '', fetchLocX: () => 83000,
        fetchLocY: () => 148000, fetchLocZ: () => -3400 };
}

async function player(name, { bot = false } = {}) {
    const account = `${bot ? 'bot_' : ''}f_player_${name}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name, race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    for (const [selfId, amount] of [[57, 1000000], [MATERIAL, 20], [SHOT, 20]]) {
        await Database.setItem(id, { selfId, amount, name: `Item ${selfId}`, equipped: false, slot: 0 });
    }
    const session = { accountId: account, botSession: bot, sent: [], socket: { write() {} },
        dataSendToMe(packet) { this.sent.push(packet); }, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    const row = (await Database.fetchCharacters(account))[0];
    const classInfo = DataCache.classTemplates.find(entry => Number(entry.classId) === 0);
    session.actor = new Actor(session, { ...row, ...utils.crushOb(classInfo), items: await Database.fetchItems(id),
        paperdoll: utils.tupleAlloc(16, {}) });
    return session;
}

function open(session, seller) {
    BotManager.sessions = [{ actor: seller, plan: 'merchant', accountId: 'bot_f_static' }];
    session.actor.setDestId(seller.fetchId());
    Select(session, session.actor, { id: seller.fetchId() });
}

function purchasePacket(selfId, amount) {
    const result = Buffer.alloc(17);
    [0, 1, selfId, amount].forEach((value, index) => result.writeInt32LE(value, 1 + index * 4));
    return result;
}

async function nativePurchase(session, selfId, amount) {
    const before = session.sent.length;
    Purchase(session, purchasePacket(selfId, amount));
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (session.sent.slice(before).some(packet => ['purchaseList', 'actionFailed'].includes(packet?.kind))) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('native purchase did not finish');
}

function wallet(session) { return session.actor.backpack.fetchTotalAdena(); }
function amount(session, selfId) { return session.actor.backpack.fetchItemFromSelfId(selfId)?.fetchAmount() || 0; }
function materialLine(config) { return config.items.find(item => Number(item.selfId) === MATERIAL); }

async function giveGear(session) {
    const row = await Database.setItem(session.actor.fetchId(), { selfId: 219, amount: 1,
        name: 'Sword Breaker', equipped: false, slot: 0 });
    session.actor.backpack.insertItem(Number(row.insertId), 219, { amount: 1 });
}

test('BUY follows current shared board, excludes orders, falls back to C4 buy-back', () => {
    const config = Configs['4manda'];
    const source = materialLine(config);
    const fallback = NpcSellRules.npcBuyPrice(TradeService.itemBasePrice(MATERIAL));
    assert.strictEqual(Pricing.priceFor(config, source), fallback);
    line(1, 3, 333, { kind: 'buy_ad' });
    line(2, 3, 444, { kind: 'shop', town: 'Gludio' });
    line(3, 3, 99999, { kind: 'order' });
    line(4, 3, 88888, { count: 0 });
    assert.strictEqual(Pricing.priceFor(config, source), 444);
    line(2, 3, 222, { kind: 'shop', town: 'Gludio' });
    assert.strictEqual(Pricing.priceFor(config, source), 333);
    board.remove(1); board.remove(2);
    assert.strictEqual(Pricing.priceFor(config, source), fallback);
});

test('SELL holds authored floor, follows asks, fixed observer rows are current', () => {
    const source = materialLine(Configs.IslandMats);
    const authored = TradeService.ratedPrice(MATERIAL, source.priceRate);
    assert.strictEqual(Pricing.priceFor(Configs.IslandMats, source), authored);
    line(10, 1, authored + 700);
    line(11, 1, authored + 500, { kind: 'shop', town: 'Gludio' });
    assert.strictEqual(Pricing.priceFor(Configs.IslandMats, source), authored + 500);
    assert.strictEqual(MarketSnapshot.fixedStores().find(row => row.ownerName === 'IslandMats')
        .items.find(item => item.selfId === MATERIAL).price, authored + 500);
    line(11, 1, 1, { kind: 'shop', town: 'Gludio' });
    assert.strictEqual(Pricing.priceFor(Configs.IslandMats, source), authored);
});

test('spawned and spread-cloned rows retain source identity through window and trade', async () => {
    const session = await player('FClone');
    const store = staticStore(Configs.IslandMats);
    store.items = store.items.map(item => ({ ...item }));
    const configured = Pricing.botPriceFor(Configs.IslandMats, materialLine(Configs.IslandMats));
    line(20, 1, configured + 100);
    open(session, merchant(store));
    assert.strictEqual(session.activeMerchantTrade.prices[MATERIAL], configured + 100);
    assert.strictEqual(session.sent.find(packet => packet.kind === 'purchaseList').args[0][0].fetchPrice(), configured + 100);
    assert.deepStrictEqual(Object.keys(JSON.parse(JSON.stringify(store.items[0]))).sort(),
        ['count', 'objectId', 'price', 'selfId']);
    line(20, 1, configured + 200);
    const money = wallet(session);
    await nativePurchase(session, MATERIAL, 1);
    assert.strictEqual(wallet(session), money, 'stale quote never charges the new price silently');
    assert.strictEqual(amount(session, MATERIAL), 20);
    assert.strictEqual(records.length, 0);
    open(session, merchant(store));
    await nativePurchase(session, MATERIAL, 1);
    assert.strictEqual(wallet(session), money - configured - 200);
    assert.strictEqual(amount(session, MATERIAL), 21);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].unitPrice, configured + 200);
    const history = await Database.fetchMarketTradeOverview();
    assert(history.recent.some(trade => trade.unitPrice === configured + 200), 'accepted native trade remains journaled');
});

test('native buyer window uses current bid and rejects stale native sale', async () => {
    const session = await player('FNativeBuyer');
    const store = staticStore(Configs['4manda']);
    const buyer = merchant(store, 82001, '4manda');
    line(30, 3, 501);
    open(session, buyer);
    assert.strictEqual(session.sent.find(packet => packet.kind === 'privateStoreListBuy').args[1][0].price, 501);
    const item = session.actor.backpack.fetchItemFromSelfId(MATERIAL);
    line(30, 3, 502);
    const money = wallet(session);
    await Sell.consumeMerchant(session, [{ objectId: item.fetchId(), selfId: MATERIAL, amount: 1, price: 501 }], { native: true });
    assert.strictEqual(wallet(session), money);
    assert.strictEqual(item.fetchAmount(), 20);
    assert.strictEqual(records.length, 0);
    open(session, buyer);
    await Sell.consumeMerchant(session, [{ objectId: item.fetchId(), selfId: MATERIAL, amount: 1, price: 502 }], { native: true });
    assert.strictEqual(wallet(session), money + 502);
    assert.strictEqual(item.fetchAmount(), 19);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].unitPrice, 502);
});

test('HTML windows and both trades read current prices and journal executed price once', async () => {
    const session = await player('FHtml');
    const store = staticStore(Configs.IslandMats);
    session.viewedPrivateStoreSeller = merchant(store);
    const configured = Pricing.botPriceFor(Configs.IslandMats, materialLine(Configs.IslandMats));
    line(40, 1, configured + 123);
    await BuyHtml(session, ['buy-merchant-item']);
    assert(session.sent.at(-1).args[1].includes(`${configured + 123}a`));
    const money = wallet(session);
    line(40, 1, configured + 124);
    await BuyHtml(session, ['buy-merchant-item', String(MATERIAL), '1']);
    assert.strictEqual(wallet(session), money - configured - 124);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].unitPrice, configured + 124);
    const buyerStore = staticStore(Configs['4manda']);
    session.viewedPrivateStoreSeller = merchant(buyerStore, 82001, '4manda');
    line(41, 3, 701);
    await SellHtml(session, ['sell-to-merchant-item']);
    assert(session.sent.at(-1).args[1].includes('701a'));
    line(41, 3, 702);
    await SellHtml(session, ['sell-to-merchant-item', String(MATERIAL), '1']);
    assert.strictEqual(wallet(session), money - configured - 124 + 702);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[1].unitPrice, 702);
});

test('bot shots retain authored price after player refresh; other static purchases are denied', async () => {
    const session = await player('FBotShots', { bot: true });
    const store = staticStore(Configs.IslandMats, SHOT);
    const source = Configs.IslandMats.items.find(item => item.selfId === SHOT);
    const configured = Pricing.botPriceFor(Configs.IslandMats, source);
    line(50, 1, configured + 400, { selfId: SHOT });
    TradeService.refreshStorePrices(store);
    assert.strictEqual(store.items[0].price, configured + 400);
    const money = wallet(session);
    const result = await TradeService.buyFromStore(session.actor, store, SHOT, 1, { expectedUnitPrice: configured });
    assert.strictEqual(result.totalAdena, configured);
    assert.strictEqual(wallet(session), money - configured);
    const materialStore = staticStore(Configs.IslandMats);
    await assert.rejects(TradeService.buyFromStore(session.actor, materialStore, MATERIAL, 1), /static.*unavailable/i);
    const ordinary = { storeType: 1, items: [{ selfId: MATERIAL, price: 7, count: 2 }] };
    assert.strictEqual((await TradeService.buyFromStore(session.actor, ordinary, MATERIAL, 1)).totalAdena, 7);
});

test('bot static buy-back remains old price; a failing player write restores stock and money', async () => {
    const session = await player('FRollback');
    const store = staticStore(Configs['4manda']);
    line(60, 3, 888);
    const item = session.actor.backpack.fetchItemFromSelfId(MATERIAL);
    const oldPrice = Pricing.botPriceFor(Configs['4manda'], materialLine(Configs['4manda']));
    const bot = await player('FBotLiquidation', { bot: true });
    const botMoney = wallet(bot);
    TradeService.refreshStorePrices(store);
    const botSale = await TradeService.sellToStore(bot.actor, store, MATERIAL, 1);
    assert.strictEqual(botSale.totalAdena, oldPrice);
    assert.strictEqual(wallet(bot), botMoney + oldPrice);
    const count = store.items[0].count;
    const money = wallet(session);
    Database.updateItemAmount = async (characterId, objectId, value) => {
        if (objectId === item.fetchId()) throw new Error('forced player write failure');
        return originals.update(characterId, objectId, value);
    };
    try { await assert.rejects(TradeService.sellToStore(session.actor, store, MATERIAL, 1), /forced player write failure/); }
    finally { Database.updateItemAmount = originals.update; }
    assert.strictEqual(wallet(session), money);
    assert.strictEqual(item.fetchAmount(), 20);
    assert.strictEqual(store.items[0].count, count);
});

test('fixed supply is cached by configuration/rate without world session reads', () => {
    const configModule = require.cache[require.resolve('../src/GameServer/Bot/MerchantStoreConfigs')];
    const config = configModule.exports;
    const profile = ProgressionRates.profile;
    const user = World.user;
    let reads = 0;
    const supply = rate => ({ get Probe() {
        reads += 1;
        return { storeType: 1, town: 'Giran', items: [{ selfId: 990001, count: 10, price: rate }] };
    } });
    try {
        World.user = { get sessions() { throw new Error('pricing must not scan sessions'); } };
        configModule.exports = supply(17);
        ProgressionRates.profile = () => ({ multiplier: 1, adena: 1 });
        assert.strictEqual(Pricing.cheapestPurchase(990001), 17);
        const offers = Pricing.sellersOf(990001);
        assert.strictEqual(offers[0].price, 17);
        assert.strictEqual(Pricing.sellersOf(990001), offers);
        assert.strictEqual(reads, 1, 'same config/rate is read once');
        configModule.exports = supply(19);
        assert.strictEqual(Pricing.cheapestPurchase(990001), 19);
        assert.strictEqual(reads, 2, 'a newly loaded config invalidates the supply table');
        ProgressionRates.profile = () => ({ multiplier: 1, adena: 2 });
        assert.strictEqual(Pricing.sellersOf(990001)[0].price, 19, 'explicit author price stays absolute');
        assert.strictEqual(reads, 3, 'effective Adena rate invalidates the supply table');
        line(70, 1, 1234);
        assert(Pricing.priceFor(Configs.IslandMats, materialLine(Configs.IslandMats)) >= 1234);
    } finally {
        configModule.exports = config;
        ProgressionRates.profile = profile;
        World.user = user;
    }
});

test('legacy HTML cannot trade an AFK projection around its record and escrow', async () => {
    const session = await player('FHtmlBoardGuard');
    const money = wallet(session);
    const units = amount(session, MATERIAL);
    const store = { afkTrade: true, storeType: 1, items: [{ selfId: MATERIAL, count: 3, price: 17 }] };
    session.viewedPrivateStoreSeller = merchant(store);
    await BuyHtml(session, ['buy-merchant-item', String(MATERIAL), '1']);
    assert.strictEqual(wallet(session), money);
    assert.strictEqual(amount(session, MATERIAL), units);
    assert.strictEqual(store.items[0].count, 3);
    store.storeType = 3;
    await SellHtml(session, ['sell-to-merchant-item', String(MATERIAL), '1']);
    assert.strictEqual(wallet(session), money);
    assert.strictEqual(amount(session, MATERIAL), units);
    assert.strictEqual(store.items[0].count, 3);
    assert.strictEqual(records.length, 0);
    assert.strictEqual(session.sent.filter(packet => packet.kind === 'actionFailed').length, 2);
});

test('bot gear sale to a static buyer is rejected before mutation; player and ordinary sales stay available', async () => {
    const bot = await player('FHotGearSeller', { bot: true });
    await giveGear(bot);
    const store = staticStore(Configs.Veteranas, 219);
    const count = store.items[0].count;
    const money = wallet(bot);
    const outcome = await TradeService.sellToStore(bot.actor, store, 219, 1)
        .then(result => ({ result }), error => ({ error }));
    assert(outcome.error, `static gear sale must reject: payout ${outcome.result?.totalAdena}, wallet ${wallet(bot)}, gear ${amount(bot, 219)}`);
    assert.match(outcome.error.message, /static.*unavailable/i);
    assert.strictEqual(wallet(bot), money);
    assert.strictEqual(amount(bot, 219), 1);
    assert.strictEqual(store.items[0].count, count);
    const persisted = await Database.fetchItems(bot.actor.fetchId());
    assert.strictEqual(persisted.find(item => item.selfId === 57).amount, money);
    assert.strictEqual(persisted.find(item => item.selfId === 219).amount, 1);

    const human = await player('FHumanGearSeller');
    await giveGear(human);
    const price = Pricing.priceFor(Configs.Veteranas, Configs.Veteranas.items.find(item => item.selfId === 219));
    const humanMoney = wallet(human);
    assert.strictEqual((await TradeService.sellToStore(human.actor, store, 219, 1)).totalAdena, price);
    assert.strictEqual(wallet(human), humanMoney + price);
    assert.strictEqual(amount(human, 219), 0);

    const ordinary = { storeType: 3, items: [{ selfId: 219, count: 2, price: 17 }] };
    assert.strictEqual((await TradeService.sellToStore(bot.actor, ordinary, 219, 1)).totalAdena, 17);
    assert.strictEqual(wallet(bot), money + 17);
    assert.strictEqual(amount(bot, 219), 0);
});

test('hot buyer selection and inventory sale keep only static materials at the old bot price', async () => {
    const bot = await player('FHotMixedSeller', { bot: true });
    await giveGear(bot);
    const gear = staticStore(Configs.Veteranas, 219);
    const gearBuyer = merchant(gear, 83001, 'Veteranas');
    assert.strictEqual(TradeService.findBestBuyerForActor(bot.actor, [{ actor: gearBuyer, plan: 'merchant',
        accountId: 'bot_f_static_gear' }]), null, 'a gear-only static buyer is not a hot bot destination');
    const materials = staticStore(Configs['4manda']);
    const store = { storeType: 3, items: [...gear.items, ...materials.items] };
    line(80, 3, 9999);
    TradeService.refreshStorePrices(store);
    const oldPrice = Pricing.botPriceFor(Configs['4manda'], materialLine(Configs['4manda']));
    const preview = TradeService.previewSaleToStore(bot.actor, store);
    assert.deepStrictEqual(preview.lines.map(item => item.selfId), [MATERIAL]);
    assert.strictEqual(preview.totalAdena, oldPrice * 20);
    const money = wallet(bot);
    const stock = gear.items[0].count;
    // This is ShoppingState's actual arrival executor for a non-AFK buyer.
    const result = await TradeService.sellInventoryToStore(bot.actor, store);
    assert.strictEqual(result.itemsSold, 20);
    assert.strictEqual(result.totalAdena, oldPrice * 20);
    assert.strictEqual(wallet(bot), money + oldPrice * 20);
    assert.strictEqual(amount(bot, MATERIAL), 0);
    assert.strictEqual(amount(bot, 219), 1);
    assert.strictEqual(gear.items[0].count, stock);
});

test('all four accepted native/HTML player trades persist once with executed prices', async () => {
    const history = await Database.fetchMarketTradeOverview();
    const playerTrades = history.recent.filter(trade => [
        'private_store_player_purchase', 'private_buy_store_player_sale'
    ].includes(trade.sourceType));
    const values = trades => trades.map(({ sourceType, unitPrice, quantity }) => ({ sourceType, unitPrice, quantity }))
        .sort((left, right) => left.unitPrice - right.unitPrice);
    assert.strictEqual(allRecords.length, 4);
    assert.deepStrictEqual(values(playerTrades), values(allRecords));
});

(async () => {
    options.default.Database.path = path.join(fixtureDir, 'world.sqlite');
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    BotSocialMemory.recordTradeCompleted = () => {};
    responseNames.forEach(name => { ServerResponse[name] = (...args) => ({ kind: name, args }); });
    MarketTelemetry.recordTrade = details => {
        records.push(details); allRecords.push(details);
        return originals.recordTrade(details);
    };
    for (const entry of cases) {
        board.clear(); records = [];
        try { await entry.run(); console.log(`PASS ${entry.name}`); }
        catch (error) { failures.push(entry.name); console.error(`FAIL ${entry.name}: ${error.stack}`); }
    }
    assert.deepStrictEqual(failures, [], 'Group F player price contracts');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Database.updateItemAmount = originals.update;
    MarketTelemetry.recordTrade = originals.recordTrade;
    BotSocialMemory.recordTradeCompleted = originals.social;
    BotManager.sessions = originals.sessions;
    World.user = originals.user;
    Object.assign(ServerResponse, responses);
    AfkTrade._resetForTests();
    await Database.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
});
