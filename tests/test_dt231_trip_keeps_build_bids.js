'use strict';
// A bot with two bids the economy build posted goes on a buy trip for a third item at an
// NPC: the trip pays from the wallet, and the bids it does not need stand (a player does
// not cancel his WTB ads to walk to a shop).
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('dt231-trip-bids');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Native = require('./helpers/nativeMarketFixture');
const POINT = { locX: 83000, locY: 148000, locZ: -3400 };
const ID = 9122, A = 1864, B = 1865, C = 1866;
const posted = () => Afk.ownerRecords(ID).map(record => [record.id, record.revision,
    record.lines.map(line => [line.selfId, line.count, line.price])]);

async function run() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init();
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
    const Town = invoke('GameServer/Bot/Economy/ColdMarketService');
    const needs = Needs.needs, errands = Town.finishTownErrands;
    const goal = { type: 'buy_craft_material', status: 'active', target: { itemId: C, amount: 3 },
        plan: { expectedBenefit: 'market_buy_craft_material', estimatedCost: 5000, wishKey: 'power:101:7',
            sourceType: 'npc', marketTown: 'Giran' } };
    Needs.needs = () => [goal];
    Town.finishTownErrands = async state => state;
    try {
        await Native.character(DB, ID, `Buyer${ID}`, `bot_dt231_${ID}`, POINT);
        await DB.setItem(ID, { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
        await Life.upsertState({ characterId: ID, accountName: `bot_dt231_${ID}`, name: `Buyer${ID}`,
            phase: 'cold', activity: 'shopping', level: 45, adena: 1000000,
            inventory: Life.inventorySummaryFromItems(await DB.fetchItems(ID)),
            currentRegion: 'Giran', loc: POINT, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
            stats: { generatedCold: true, money: [36000, 0, 0, 0] }, timing: {} }, 'dt231_fixture');
        await Market.executePlan(Life.snapshot(ID), { buyAds: [[A, 2, 100], [B, 2, 200]], buyShop: Afk.BUY },
            { reviewGoal: false });
        const held = posted();
        assert.deepEqual(held.flatMap(row => row[2].map(line => line[0])).sort((a, b) => a - b), [A, B],
            'fixture: the build\'s two bids stand');
        const state = Life.snapshot(ID);
        await Population.finishColdMarketStep(state, null, false, { state, closed: true },
            { state, purchased: false }, goal);
        assert.deepEqual(posted(), held, 'a trip to an NPC for another item leaves both bids posted');
    } finally {
        Needs.needs = needs; Town.finishTownErrands = errands;
    }
    console.log('PASS buy trip keeps the build\'s bids');
}
run().then(async () => { Afk._resetForTests(); await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true }); })
    .catch(async error => { console.error(error); await DB.close(); process.exitCode = 1; });
