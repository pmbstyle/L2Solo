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
        const result = await execute({ sell: [[1786, 2, 100, 'Giran']] });
        state = result.state;
        const ads = Afk.ownerRecords(id);
        assert.equal(ads.length, 1);
        assert.equal(ads[0].kind, 'sell_ad', 'the first selected item becomes a WTS, not a shop reservation');
        assert.equal(ads[0].custodyPolicy, 1, 'an unaccepted advertisement holds no physical inventory');
        assert.equal(ads[0].town, 'Giran');
        assert.equal(ads[0].lines[0].count, 2);
        assert.equal(state.activity, 'hunting'); assert.equal(state.currentRegion, 'Talking Island');
        assert.deepEqual(await Database.fetchItems(id), before, 'publishing WTS consumes no stock or money');
        await execute({ sell: [[1786, 2, 100, 'Giran']] });
        assert.equal(Afk.ownerRecords(id).filter(row => row.kind === 'sell_ad').length, 1,
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
