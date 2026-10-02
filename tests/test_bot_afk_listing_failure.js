const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-afk-listing-failure.sqlite');
const realNow = Date.now;

// A physical stall lives for a fixed period; when it ends unsold the bot
// remembers the failure (ColdMarketListingService.pricingAfterReview): the
// next price is 5% lower and a speculative line is not tried again. An AFK
// shop has no lifetime, so its review measures each line against the same
// periods.
const SOULFIRE_DIRK = 242;
const VARNISH = 1865;
const sellGoal = { type: 'sell_inventory', status: 'active', plan: { expectedBenefit: 'market_sale_inventory' } };

let clock = 0;
const at = (ms) => { clock = ms; };
const lineOf = (ownerId, selfId) => (AfkTrade.findOwnerProjection(ownerId)?.shop?.lines || [])
    .find((line) => Number(line.selfId) === selfId && Number(line.count) > 0);
const pricing = (ownerId, selfId) => LifeState.snapshot(ownerId).stats?.marketPricing?.[selfId] || {};
const review = (ownerId) => BotAfkMarket.reconcile(LifeState.snapshot(ownerId), sellGoal);

async function run() {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();
    Date.now = () => clock;
    at(10_000_000);

    await Database.createAccount('bot_afk_failure_owner', 'pw');
    const ownerId = Number((await Database.createCharacter('bot_afk_failure_owner', {
        name: 'FailureTrader', race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 82700, locY: 148600, locZ: -3470
    })).insertId);
    await Database.setItem(ownerId, { selfId: SOULFIRE_DIRK, name: 'Soulfire Dirk', amount: 1, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(ownerId, { selfId: VARNISH, name: 'Varnish', amount: 60, enchant: 0, equipped: false, slot: 0 });
    await Database.setItem(ownerId, { selfId: 57, name: 'Adena', amount: 1000, enchant: 0, equipped: false, slot: 0 });
    const hunting = await LifeState.upsertState({
        characterId: ownerId, accountName: 'bot_afk_failure_owner', name: 'FailureTrader',
        phase: 'cold', activity: 'hunting', level: 45, adena: 1000,
        loc: { locX: 82700, locY: 148600, locZ: -3470 }, currentRegion: 'Giran',
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(ownerId)),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true }, timing: {}
    }, 'test_bot_afk_failure_hunting');
    // Another bot plans to farm the dirk: latent demand, the case for one speculative line.
    await Database.createAccount('bot_afk_failure_buyer', 'pw');
    const buyerId = Number((await Database.createCharacter('bot_afk_failure_buyer', {
        name: 'LatentBuyer', race: 0, classId: 0, maxHp: 100, maxMp: 100,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 82700, locY: 148600, locZ: -3470
    })).insertId);
    await LifeState.upsertState({
        characterId: buyerId, accountName: 'bot_afk_failure_buyer', name: 'LatentBuyer',
        phase: 'cold', activity: 'hunting', level: 45, adena: 0,
        loc: { locX: 82700, locY: 148600, locZ: -3470 }, currentRegion: 'Giran', inventory: {},
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, equipmentPlan: { status: 'active', strategy: 'drop',
            target: { selfId: SOULFIRE_DIRK, name: 'Soulfire Dirk' } } },
        timing: {}
    }, 'test_bot_afk_failure_buyer');

    const opened = await BotAfkMarket.reconcile(hunting, sellGoal);
    assert.strictEqual(opened.changed, true, 'the bot opens an AFK sell shop');
    assert(lineOf(ownerId, SOULFIRE_DIRK), 'a C weapon nobody asks for is listed as a speculative line');
    const varnishPrice = Number(lineOf(ownerId, VARNISH)?.price || 0);
    assert(varnishPrice > 0, 'the material is listed as an ordinary line');

    at(10_000_000 + ListingService.SPECULATIVE_LISTING_MS - 1);
    await review(ownerId);
    assert(lineOf(ownerId, SOULFIRE_DIRK), 'a speculative line keeps its whole try');

    at(10_000_000 + ListingService.SPECULATIVE_LISTING_MS);
    await review(ownerId);
    assert.strictEqual(lineOf(ownerId, SOULFIRE_DIRK), undefined, 'an unsold speculative line leaves after its try');
    assert(pricing(ownerId, SOULFIRE_DIRK).speculativeFailedAt > 0, 'the failed try is remembered');
    assert.strictEqual(pricing(ownerId, SOULFIRE_DIRK).percent, 95, 'the failed item will be offered 5% cheaper');
    assert.strictEqual(Number(lineOf(ownerId, VARNISH).price), varnishPrice, 'an ordinary line is still inside its period');

    at(10_000_000 + ListingService.DEFAULT_LISTING_MS + ListingService.SPECULATIVE_LISTING_MS);
    await review(ownerId);
    assert.strictEqual(lineOf(ownerId, SOULFIRE_DIRK), undefined, 'a failed speculative item is not tried again');
    assert.strictEqual(pricing(ownerId, VARNISH).percent, 95, 'an unsold ordinary listing is remembered as a failure');
    const cheaper = Number(lineOf(ownerId, VARNISH).price);
    assert(cheaper < varnishPrice, 'the ordinary line is offered at the lower price');

    // A review within 5 minutes of the last one is skipped (SHOP_REVIEW_MS),
    // so this one comes 15 minutes into the new period.
    at(10_000_000 + 2 * ListingService.DEFAULT_LISTING_MS);
    await review(ownerId);
    assert.strictEqual(pricing(ownerId, VARNISH).percent, 95, 'a new period starts at the lower price');

    at(10_000_000 + 2 * ListingService.DEFAULT_LISTING_MS + ListingService.SPECULATIVE_LISTING_MS);
    await review(ownerId);
    assert.strictEqual(pricing(ownerId, VARNISH).percent, 90, 'each unsold period lowers the price again');
    assert(Number(lineOf(ownerId, VARNISH).price) < cheaper);

    // A shop closed elsewhere (sold out, pruned) and listed again starts a
    // new period: the old listing's age is not a failure of the new one.
    // Listed again 16 minutes into the old period, reviewed 5 minutes later.
    const relistAt = 10_000_000 + 2 * ListingService.DEFAULT_LISTING_MS + ListingService.SPECULATIVE_LISTING_MS + 16 * 60_000;
    at(relistAt);
    await AfkTrade.stop(ownerId);
    await review(ownerId);
    assert(lineOf(ownerId, VARNISH), 'the material is listed again');
    at(relistAt + ListingService.SPECULATIVE_LISTING_MS);
    await review(ownerId);
    assert.strictEqual(pricing(ownerId, VARNISH).percent, 90, 'a fresh listing is not marked down for an old one');

    // At the 50% minimum a failure changes nothing: the period restarts
    // without a state write.
    await LifeState.upsertState({ ...LifeState.snapshot(ownerId), stats: { ...LifeState.snapshot(ownerId).stats,
        marketPricing: { ...LifeState.snapshot(ownerId).stats.marketPricing, [VARNISH]: { percent: 50 } } } }, 'test_floor');
    const originalUpsert = LifeState.upsertState;
    let expiryWrites = 0;
    LifeState.upsertState = (state, reason) => {
        if (reason === 'afk_market_listing_expired') expiryWrites++;
        return originalUpsert.call(LifeState, state, reason);
    };
    try {
        at(relistAt + ListingService.DEFAULT_LISTING_MS);
        await review(ownerId);
        assert.strictEqual(expiryWrites, 0, 'a failure at the minimum percent writes nothing');
        assert(lineOf(ownerId, VARNISH), 'the line stays listed');
    } finally {
        LifeState.upsertState = originalUpsert;
    }

    await AfkTrade._resetForTests();
    BotAfkMarket._resetForTests();
    console.log('Bot AFK listing failure checks passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    Date.now = realNow;
});
