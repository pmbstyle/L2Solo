const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-afk-sell-reprice.sqlite');
const originalEvaluate = ListingPolicy.evaluate;

// A kept line keeps its price through the main thread's review (group E):
// the bot's own look in the cold worker prices it again (MarketPricing.look)
// and the main thread applies that look (BotAfkMarketService.applyReview): a
// new ask in place, a line whose best outcome is the NPC leaves the board, a
// line a deal changed meanwhile waits for the next look.
const VARNISH = 1865;
const sellGoal = { type: 'sell_inventory', status: 'active', plan: { expectedBenefit: 'market_sale_inventory' } };
const item = { selfId: VARNISH, name: 'Varnish', kind: 'Other.Material', count: 25, basePrice: 100, rank: 'none' };

// The policy lists the item at `price` (what a new line would get).
function policy(price) {
    const listing = { ...item, price };
    ListingPolicy.evaluate = () => ({
        listings: [listing],
        decisions: [{ action: 'list', reason: 'expected_value', item: listing }],
        book: null
    });
}

async function review(ownerId) {
    // Review memory is per process; drop it so the call is a full review.
    BotAfkMarket._resetForTests();
    return BotAfkMarket.reconcile(LifeState.snapshot(ownerId), sellGoal);
}

const linePrice = (ownerId) => Number(AfkTrade.findOwnerProjection(ownerId).shop.lines[0].price);

async function run() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();

    await Database.createAccount('bot_afk_reprice_owner', 'pw');
    const ownerId = Number((await Database.createCharacter('bot_afk_reprice_owner', {
        name: 'RepriceTrader', race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: -84700, locY: 244200, locZ: -3730
    })).insertId);
    await Database.setItem(ownerId, { selfId: VARNISH, name: 'Varnish', amount: 30, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(ownerId, { selfId: 57, name: 'Adena', amount: 1000, enchant: 0, equipped: false, slot: 0 });
    const hunting = await LifeState.upsertState({
        characterId: ownerId, accountName: 'bot_afk_reprice_owner', name: 'RepriceTrader',
        phase: 'cold', activity: 'hunting', level: 45, adena: 1000,
        loc: { locX: -84700, locY: 244200, locZ: -3730 }, currentRegion: 'Talking Island',
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(ownerId)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true }, timing: {}
    }, 'test_bot_afk_reprice_hunting');

    // A shop opens at a market visit, in the town the bot chose (group C).
    policy(100);
    assert.strictEqual(BotAfkMarket.canTradeRemotely(hunting, sellGoal), false, 'no shop is opened from afar');
    await BotAfkMarket.listOnBoard({ ...hunting, activity: 'shopping',
        stats: { ...hunting.stats, shopTown: { town: 'Talking Island', at: 1 } } });
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId).shop.lines[0].price, 100);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId).shop.town, 'Talking Island');

    policy(100);
    assert.strictEqual((await review(ownerId)).changed, false, 'an unchanged shop is not republished');

    const lineId = Number(AfkTrade.findOwnerProjection(ownerId).shop.lines[0].id);
    policy(88);
    assert.strictEqual((await review(ownerId)).changed, false, 'the main review does not reprice a kept line');
    assert.strictEqual(linePrice(ownerId), 100, 'no fixed markdown: the kept line keeps its ask');

    const looked = await BotAfkMarket.applyReview(ownerId, { reprices: [{ lineId, price: 88 }] });
    assert.strictEqual(looked.changed, 1);
    assert.strictEqual(Number(AfkTrade.findOwnerProjection(ownerId).shop.lines[0].id), lineId, 'the look updates the line in place');
    assert.strictEqual(linePrice(ownerId), 88, 'the bot\'s own look sets its ask');
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId).shop.lines[0].count, 25);

    // A trade or a deal that changed the shop meanwhile wins.
    const originalReprice = AfkTrade.repriceBot;
    AfkTrade.repriceBot = async () => { throw new Error('afk_trade_shop_changed'); };
    try {
        assert.strictEqual((await BotAfkMarket.applyReview(ownerId, { reprices: [{ lineId, price: 80 }] })).changed, 0);
        assert.strictEqual(linePrice(ownerId), 88, 'a changed shop keeps its price until the next look');
    } finally {
        AfkTrade.repriceBot = originalReprice;
    }

    // The NPC is now the best outcome: the line leaves the board, the items
    // come back to the bag for the next town visit.
    const withdrawn = await BotAfkMarket.applyReview(ownerId, { withdrawals: [{ lineId }] });
    assert.strictEqual(withdrawn.changed, 1);
    assert.strictEqual(AfkTrade.findOwnerProjection(ownerId)?.shop || null, null, 'the shop of that one line closes');
    const bag = await Database.fetchItems(ownerId);
    assert.strictEqual(bag.filter((row) => Number(row.selfId) === VARNISH).reduce((sum, row) => sum + Number(row.amount), 0), 30);

    await AfkTrade._resetForTests();
    BotAfkMarket._resetForTests();
    console.log('Bot AFK sell reprice: kept asks, the bot\'s own look applied, withdrawal to the bag passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    ListingPolicy.evaluate = originalEvaluate;
});
