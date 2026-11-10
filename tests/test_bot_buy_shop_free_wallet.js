'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('buy-shop-free-wallet');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const BuyShop = invoke('GameServer/Bot/Economy/BotBuyShopService');
const Places = invoke('GameServer/Bot/Economy/ShopPlaces');
const Native = require('./helpers/nativeMarketFixture');
const id = 9411, cash = 35013, reserved = 8690025;
const line = (selfId, count, price, extra = {}) => ({ selfId, count, price, enchant: 0, ...extra });
const intent = (itemId, amount, price) => ({ key: 'power:192:14', itemId, amount, price, valueHours: 100, valueRate: 1 });
const bids = () => Afk.ownerRecords(id).filter(row => row.kind === 'buy_ad');
const shop = () => Afk.findOwnerProjection(id)?.shop;
const wallet = async () => Native.amount(await DB.fetchItems(id), 57);

(async () => {
    Data.init(); await DB.init();
    try {
        const loc = Places.take('Giran', Places.afkOwner(id));
        await Native.character(DB, id, 'ReservedBuyer', 'bot_reserved_buyer', loc);
        await DB.setItem(id, { selfId: 57, name: 'Adena', amount: cash + reserved, slot: 0 });
        await Life.init();
        await Life.upsertState({ characterId: id, accountName: 'bot_reserved_buyer', name: 'ReservedBuyer',
            phase: 'cold', activity: 'shopping', level: 41, currentRegion: 'Giran', loc,
            adena: cash + reserved, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
            stats: { generatedCold: true, money: [1025608, 0, 0, 0] } }, 'reserved_buyer_fixture');
        await Market.executePlan(Life.snapshot(id), { buyAds: [[192, 1, reserved]], buyShop: Afk.BUY }, { reviewGoal: false });
        const held = shop();
        assert.equal(held.escrowAdena, reserved);
        assert.equal(await wallet(), cash);
        // The alternative input is affordable only if the same shop's locked
        // money is counted twice. This is the native live failure's path.
        const plan = { buyShop: Afk.BUY, buyAds: [[192, 1, reserved],
            [1458, 80, 1000, 1, 192, 14, 0, 100, 1]] };
        await Market.executePlan(Life.snapshot(id), plan, { reviewGoal: false });
        assert.equal(shop().id, held.id, 'the funded shop keeps its identity');
        assert.equal(shop().revision, held.revision, 'an ad must not rewrite a kept shop');
        assert.equal(shop().escrowAdena, reserved);
        assert.equal(bids().find(row => row.lines[0].selfId === 1458)?.lines[0].count, 35,
            'a new conditional bid is sized from the physical free wallet');
        assert.equal(await wallet(), cash, 'conditional ads do not debit the wallet');
        const before = Afk.ownerRecords(id);
        await Market.executePlan(Life.snapshot(id), plan, { reviewGoal: false });
        assert.deepEqual(Afk.ownerRecords(id), before, 'replaying the oversized preparation leaves the accepted records unchanged');
        await BuyShop.publish(Life.snapshot(id), [line(192, 1, reserved, { intent: intent(192, 1, reserved) }),
            line(1458, 80, 1000, { intent: intent(1458, 80, 1000) }),
            line(19, 1, 100000, { intent: intent(19, 1, 100000) })], 'Giran',
        { priority: Afk.BUY, appearance: async () => ({}) });
        assert.deepEqual(Afk.ownerRecords(id), before,
            'an unaffordable single-unit alternative is omitted without disturbing accepted records');

        // A cheaper prepared quote inside the cap still retains the shop's
        // actual price when only its overflow ads change.
        await BuyShop.publish(Life.snapshot(id), [line(192, 1, reserved - 25,
            { purchaseCap: reserved, intent: intent(192, 1, reserved - 25) }),
            line(1458, 35, 1000, { intent: intent(1458, 35, 1000) }),
            line(1864, 10, 5000, { intent: intent(1864, 10, 5000) })], 'Giran',
        { priority: Afk.BUY, appearance: async () => ({}) });
        assert.equal(shop().id, held.id);
        assert.equal(shop().revision, held.revision);
        assert.equal(shop().lines[0].price, reserved);
        assert.equal(shop().escrowAdena, reserved);
        assert.equal(bids().find(row => row.lines[0].selfId === 1864)?.lines[0].count, 7);
        assert.equal(await wallet(), cash);

        // A replaced shop refunds the old escrow and locks the new one once.
        // Only the remainder can back its conditional alternatives.
        await BuyShop.publish(Life.snapshot(id), [line(192, 1, 4000000, { purchaseCap: 4000000 }),
            line(1458, 6000, 1000, { intent: intent(1458, 6000, 1000) })], 'Giran',
        { priority: Afk.BUY, appearance: async () => ({}) });
        assert.equal(shop().escrowAdena, 4000000);
        assert.equal(await wallet(), cash + reserved - 4000000);
        assert.equal(bids().find(row => row.lines[0].selfId === 1458)?.lines[0].count,
            Math.floor((cash + reserved - 4000000) / 1000));
        const current = Life.snapshot(id);
        await Life.upsertState({ ...current, stats: { ...current.stats,
            money: [1025608, 0, current.adena - 5013, 0] } }, 'protected_cash_fixture');
        await BuyShop.publish(Life.snapshot(id), [line(192, 1, 4000000, { purchaseCap: 4000000 }),
            line(1458, 6000, 1000, { intent: intent(1458, 6000, 1000) })], 'Giran',
        { priority: Afk.BUY, appearance: async () => ({}) });
        assert.equal(bids().find(row => row.lines[0].selfId === 1458)?.lines[0].count, 5,
            'a free wallet still respects the native survival reserve');
        assert.equal(await wallet(), cash + reserved - 4000000);
        console.log('PASS buy publication: kept/refunded escrow, physical ad budgets, retained prices and no-op replay');
    } finally {
        Afk._resetForTests(); await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
