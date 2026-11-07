const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Listing = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const id = 730093;

// E304 (a): a bot sells in Gludin, its shop opens in Talking Island, and it
// cannot pay the gatekeeper there. The fallback sale trip of
// GoalExecutor.beginMarketTravel would land it in Gludin again; the visit
// must end behind the sale retry instead of a new sale trip each resolve.
(async () => {
    await createWorld([{ id, classId: 0, level: 23 }], 'shop-town-unreached');
    await Life.init();
    const gludin = Listing.townCenter('Gludin');
    const now = Date.now();
    const visitor = (adena) => ({ characterId: id, accountName: 'bot_pop_shoptown', name: 'ShopTownSeller',
        phase: 'cold', activity: 'shopping', level: 23, adena, currentRegion: 'Gludin',
        loc: { locX: gludin.locX, locY: gludin.locY, locZ: gludin.locZ },
        vitals: { hp: 300, maxHp: 300, mp: 100, maxMp: 100 },
        inventory: { 1864: { selfId: 1864, amount: 5, kind: 'Other.Material', stackable: true } },
        stats: { classId: 0, generatedCold: true, shopTown: { town: 'Talking Island', at: now - 1000 },
            townVisit: { town: 'Gludin', startedAt: now - 1000, reason: 'sell_inventory', completed: true },
            marketReturn: { loc: { locX: -52612, locY: 195042, locZ: -3664 },
                regionName: 'Ratman Warrior fields', spotId: '-9_32' } } });
    const board = { shopTown: 'Talking Island', listed: 2 };

    const poor = await Listing.travelToShopTown(visitor(0), board, now);
    assert.equal(poor.reason, 'shop_town_unreached', 'no Adena for the gatekeeper: the shop town is not reached');
    assert.deepEqual(poor.state.stats.marketSellSeen?.items, [1864],
        'the unreached shop town ends the visit behind the sale retry on the goods it carries');
    assert.notEqual(poor.state.stats.travel?.arrivalActivity, 'shopping', 'no sale trip back into a town: the bot returns to its spot');

    const rich = await Listing.travelToShopTown(visitor(1000000), board, now);
    assert.equal(rich.reason, 'shop_town_trip', 'a bot that can pay travels to its shop town');
    assert.equal(rich.state.stats.travel?.townName, 'Talking Island');
    assert.equal(rich.state.stats.marketSellSeen, null,
        'the trip to the shop town keeps no retry: the visit there opens the shop');

    // The sale visit saves its retry before answering buy ads in the reached
    // town; a sale there must still lead on to the shop town.
    const answered = visitor(1000000);
    answered.stats.marketSellSeen = { items: [1864], buyers: null };
    const onward = await Listing.travelToShopTown(answered, board, now);
    assert.equal(onward.reason, 'shop_town_trip', 'the saved sale retry does not stop the trip to the shop town');
    assert.equal(onward.state.stats.travel?.townName, 'Talking Island');
    assert.equal(onward.state.stats.marketSellSeen, null, 'the trip carries no retry');
    console.log('test_shop_town_unreached_retry: ok');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
