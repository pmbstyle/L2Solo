'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Goals = invoke('GameServer/Bot/Goals/GoalService');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const id = 730062;
(async () => {
    const world = await createWorld([{ id, classId: 0, level: 5 }], 'field-trade-ads');
    const review = Goals.review;
    try {
        await Life.init();
        await Database.createAccount('bot_field_trade_ads', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_field_trade_ads', id]]);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
        await Database.setItem(id, { selfId: 1786, name: 'Recipe: Broad Sword', amount: 2, slot: 0 });
        await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 500, slot: 0 });
        await Database.setItem(id, { selfId: 79, name: 'D spear', amount: 1, slot: 7 });
        await Database.setItem(id, { selfId: 1835, name: 'Soulshot: No Grade', amount: 500, slot: 0 });
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_field_trade_ads', name: 'FieldTrader',
            level: 5, exp: Number(DataCache.experience[4]), phase: 'cold', activity: 'hunting', adena: 100000,
            loc: { locX: -84700, locY: 244200, locZ: -3730 }, currentRegion: 'Talking Island',
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            stats: { classId: 0, generatedCold: true, money: [1000, .001, 0, 0] }, timing: {} }, 'field_ad_fixture');
        assert(Disposition.saleCandidates(state, { unlimited: true }).some(item => item.selfId === 1786),
            'a young generated holder enters the shared sale evaluation');
        Goals.review = async () => null; // This fixture executes an already selected, separately valued plan.
        const before = await Database.fetchItems(id);
        const execute = plan => Market.executePlan(state, { withdraw: [], travel: null, ...plan },
            { step: work => work() });
        const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
        const options = { board: Afk.boardIndex(), now: 1800000000000, findSpot: () => null,
            npcOffersFor: () => [], onTownDecision: () => {} };
        const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
        // Public completed prices are price evidence, not a pending buyer.
        for (const itemId of [1786, 1867, 79, 1835]) Counters.deal(itemId, 1000, 1, options.now - 1, id + 1);
        const economy = { ...Decision.economyFor(state, options), moneyPrice: .001 };
        const Roll = invoke('GameServer/Bot/AI/TendencyRoll'), roll = Roll.roll;
        // Fix this one character decision, not a buyer or a sale outcome.
        Roll.roll = (...key) => key[0] === 'dispose' ? .999 : roll(...key);
        let prepared;
        try {
            const iterator = Plan.prepare(state, economy, options);
            do { prepared = iterator.next(); } while (!prepared.done);
            const visible = Plan.prepare({ ...state, phase: 'hot' }, economy, options);
            let hot;
            do { hot = visible.next(); } while (!hot.done);
            assert.deepEqual(hot.value.sell, prepared.value.sell, 'visible and far owners quote the same physical stock');
        } finally { Roll.roll = roll; }
        assert(prepared.value.sell.length > 0, 'the native field owner selects WTS without a supplied buyer forecast');
        const nativeBefore = await Database.fetchItems(id);
        await execute(prepared.value);
        const nativeAds = Afk.ownerRecords(id).filter(row => row.kind === 'sell_ad');
        assert(nativeAds.length > 0 && nativeAds.every(row => row.custodyPolicy === 1));
        assert.deepEqual(await Database.fetchItems(id), nativeBefore, 'first quotes retain actual stock');
        assert.equal((Life.cachedState(id) || state).activity, 'hunting', 'quoting starts no trip');
        for (const ad of nativeAds) await Afk.closeBotRecord(id, ad.id);
        const sell = [[1786, 2, 100, 'Giran'], [1867, 500, 100, 'Dion'], [79, 1, 1000, 'Giran'], [1835, 500, 10, 'Dion']];
        const result = await execute({ sell });
        state = result.state;
        const ads = Afk.ownerRecords(id);
        assert.equal(ads.length, 4, 'recipe, material, gear and shots become WTS, including the first three rows');
        assert(ads.every(ad => ad.kind === 'sell_ad' && ad.custodyPolicy === 1));
        assert.equal(ads[0].custodyPolicy, 1, 'an unaccepted advertisement holds no physical inventory');
        assert.equal(ads[0].town, 'Giran');
        assert.equal(ads[0].lines[0].count, 2);
        assert.equal(state.activity, 'hunting'); assert.equal(state.currentRegion, 'Talking Island');
        assert.deepEqual(await Database.fetchItems(id), before, 'publishing WTS consumes no stock or money');
        await execute({ sell });
        assert.equal(Afk.ownerRecords(id).filter(row => row.kind === 'sell_ad').length, 4,
            'a repeated prepared WTS creates no duplicate advertisement');
        state = Life.cachedState(id) || state;
        state = await Life.upsertState({ ...state, stats: { ...state.stats,
            money: [10000, .0001, 100, 0, .001, 2000, 1864] } }, 'field_bid_funding');
        await execute({ buyAds: [[1864, 1, 10]] });
        const bid = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        assert(bid); assert.equal(bid.custodyPolicy, 1);
        assert.equal(bid.escrowAdena, 0, 'an unaccepted WTB reserves no adena');
        assert.deepEqual(await Database.fetchItems(id), before, 'publishing WTB consumes no stock or money');
        assert.equal(Afk.ownerRecords(id).filter(row => row.kind === 'shop').length, 0);
        assert.equal((Life.cachedState(id) || state).activity, 'hunting');
        console.log('PASS low-level field WTS/WTB: no shop, town trip, custody, escrow or duplicate ad');
    } finally { Goals.review = review; await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
