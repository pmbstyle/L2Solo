const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotAfkMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const World = invoke('GameServer/World/World');
const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-afk-listing-failure.sqlite');
const realNow = Date.now;

// No timer marks a line down (group E, the author's -5% per 20 minutes
// removed): a line that did not sell keeps its ask through any number of
// reviews over hours; only the bot's own look reprices it, when new evidence
// arrived (MarketPricing.look). No markdown memory is written.
const SOULFIRE_DIRK = 242;
const VARNISH = 1865;
const sellGoal = { type: 'sell_inventory', status: 'active', plan: { expectedBenefit: 'market_sale_inventory' } };

let clock = 0;
const at = (ms) => { clock = ms; };
const lineOf = (ownerId, selfId) => (AfkTrade.findOwnerProjection(ownerId)?.shop?.lines || [])
    .find((line) => Number(line.selfId) === selfId && Number(line.count) > 0);
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
    // Both items trade on the board, so both are worth a line.
    for (let deal = 0; deal < 20; deal++) {
        MarketCounters.deal(SOULFIRE_DIRK, 300000, 1, clock - (20 - deal) * 60000, 1);
        MarketCounters.deal(VARNISH, 2000, 20, clock - (20 - deal) * 60000, 1);
    }

    const opened = await BotAfkMarket.reconcile(hunting, sellGoal);
    assert.strictEqual(opened.changed, true, 'the bot opens an AFK sell shop');
    const listed = (opened.shop.lines || []).map((line) => [Number(line.selfId), Number(line.price)]);
    assert(listed.length, 'it lists what is worth more on the board than at the NPC');
    for (const minutes of [5, 20, 25, 45, 120, 600]) {
        at(10_000_000 + minutes * 60_000);
        BotAfkMarket._resetForTests();
        await review(ownerId);
        for (const [selfId, price] of listed) {
            assert.strictEqual(Number(lineOf(ownerId, selfId)?.price), price, `after ${minutes} min the ask stands`);
        }
    }
    assert.strictEqual(LifeState.snapshot(ownerId).stats?.marketPricing, undefined, 'no markdown memory');

    await AfkTrade._resetForTests();
    BotAfkMarket._resetForTests();
    MarketCounters.reset();
    console.log('Bot AFK listing: no timed markdown, asks stand until the bot looks, passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    Date.now = realNow;
});
