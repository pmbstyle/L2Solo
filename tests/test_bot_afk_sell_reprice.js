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

// A reviewed AFK ask is re-priced as a physical store's review re-prices its
// stall: the kept price is the preferred price, a cheaper competitor pulls it
// to 2% under that competitor, and it is never raised above the kept price.
const VARNISH = 1865;
const sellGoal = { type: 'sell_inventory', status: 'active', plan: { expectedBenefit: 'market_sale_inventory' } };
const item = { selfId: VARNISH, name: 'Varnish', kind: 'Other.Material', count: 25, basePrice: 100, rank: 'none' };

// The policy lists the item at `price` (what a new line would get) against
// a cheapest other ask of `cheapest`.
function policy(price, cheapest = Infinity) {
    const listing = { ...item, price };
    ListingPolicy.evaluate = () => ({
        listings: [listing],
        decisions: [{ action: 'list', reason: 'material_liquidity', item: listing,
            market: { supply: { minimumPrice: cheapest, units: 1 }, demand: {} } }]
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

    policy(100);
    const opened = await BotAfkMarket.reconcile(hunting, sellGoal);
    assert.strictEqual(opened.shop.lines[0].price, 100);

    policy(100);
    assert.strictEqual((await review(ownerId)).changed, false, 'an unchanged price must not republish the shop');

    policy(88, 90);
    const undercut = await review(ownerId);
    assert.strictEqual(undercut.changed, true);
    assert.strictEqual(linePrice(ownerId), 88, 'a cheaper competitor pulls the ask to 2% under it');
    assert.strictEqual(undercut.shop.lines[0].count, 25);

    policy(95);
    assert.strictEqual((await review(ownerId)).changed, false, 'the ask is not raised when the competitor is gone');
    assert.strictEqual(linePrice(ownerId), 88);

    policy(70);
    assert.strictEqual((await review(ownerId)).changed, false,
        'without a cheaper competitor a lower policy price does not lower the kept ask');
    assert.strictEqual(linePrice(ownerId), 88);

    await AfkTrade._resetForTests();
    BotAfkMarket._resetForTests();
    console.log('Bot AFK sell reprice checks passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    ListingPolicy.evaluate = originalEvaluate;
});
