'use strict';
// Task 4 B4: a survival item's buy ad may spend its kit cost from the survival
// reserve, as the meeting and the NPC restock do. The worker decides the
// tranche once with the bid (its own unit price estimate); the plan carries
// it and the main executePlan check and the native conditional bid check
// reuse that value; any other item stays funded by the queue alone.
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('task4-survival-tranche');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Native = require('./helpers/nativeMarketFixture');
const owner = 9311, SHOT = 1835, OTHER = 1864;
// The queue holds only OTHER (r 0.001 at money price 0.001): a shot has no
// queue money, so its ad lives on the survival tranche alone.
const packet = [36000, 0.001, 9000, 0, 0.001, 400, OTHER];
const config = (selfId, count, price, survivalCost) => ({ storeType: 3, town: 'Dion', title: 'Kit',
    lines: [{ selfId, count, price, name: `Item ${selfId}`, enchant: 0, stackable: true,
        ...(survivalCost !== undefined ? { survivalCost } : {}) }] });
const records = () => Database.fetchAfkTradeShops(owner);
const wallet = async () => Native.amount(await Database.fetchItems(owner), 57);
const expected = rows => Object.fromEntries(rows.map(row => [row.id, row.revision]));
async function run() {
    Database.init(); Data.init();
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
    const BuyAdPolicy = invoke('GameServer/Bot/Economy/BuyAdPolicy');
    await Native.character(Database, owner, 'SurvivalBuyer', 'bot_survival_buyer');
    await Database.setItem(owner, { selfId: 57, name: 'Adena', amount: 10000, stackable: true });
    await Life.upsertState({ characterId: owner, accountName: 'bot_survival_buyer', name: 'SurvivalBuyer',
        phase: 'cold', activity: 'hunting', level: 20, adena: await wallet(), currentRegion: 'Dion',
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(owner)),
        loc: { locX: 19000, locY: 145000, locZ: -3100 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        stats: { money: packet } }, 'survival_fixture');
    const state = Life.cachedState(owner);
    assert.equal(Funding.spendable(state, 0, { itemId: SHOT }), 0, 'the queue gives a shot nothing');
    assert.equal(Funding.spendable(state, 0, { itemId: SHOT, survivalCost: 1000 }), 1000);

    // 1. Native conditional bid check: the line's survivalCost funds it.
    await assert.rejects(Afk.replaceBotRecords(owner, 'buy_ad', [config(SHOT, 100, 7)], { expected: {} }),
        /economy_funding_changed/, 'without the kit cost the shot ad is unfunded');
    await assert.rejects(Afk.replaceBotRecords(owner, 'buy_ad', [config(SHOT, 100, 7, 500)], { expected: {} }),
        /economy_funding_changed/, 'a kit cost below the bid does not fund it');
    await Afk.replaceBotRecords(owner, 'buy_ad', [config(SHOT, 100, 7, 1000)], { expected: {} });
    let ads = await records();
    assert.equal(ads.length, 1); assert.equal(ads[0].lines[0].selfId, SHOT); assert.equal(ads[0].lines[0].count, 100);
    assert.equal(await wallet(), 10000, 'a conditional ad holds no money');
    await Afk.replaceBotRecords(owner, 'buy_ad', [], { expected: expected(ads) });
    assert.equal((await records()).length, 0);

    // 2. executePlan: the main check and the line reuse the tranche the
    // worker decided the bid with (plan.buyKit). This bot's real kit cost
    // (EconomyContext.basics) is 0: a second computation on main refuses.
    assert.equal(Economy.basics(Life.cachedState(owner)).kitCost(SHOT), 0);
    {
        await assert.rejects(Market.executePlan(Life.cachedState(owner), { buyAds: [[SHOT, 100, 7]] }),
            /economy_plan_bid_unfunded/, 'no tranche: the shot ad is refused on main');
        assert.equal((await records()).length, 0);
        await Market.executePlan(Life.cachedState(owner), { buyAds: [[SHOT, 100, 7], [OTHER, 1, 300]], buyKit: [1000, 0] });
        ads = await records();
        assert.deepEqual(ads.map(ad => [ad.lines[0].selfId, ad.lines[0].count]).sort((a, b) => a[0] - b[0]),
            [[SHOT, 100], [OTHER, 1]].sort((a, b) => a[0] - b[0]));
        assert.equal(await wallet(), 10000);
        await assert.rejects(Market.executePlan(Life.cachedState(owner), { buyAds: [[SHOT, 200, 7]], buyKit: [500] }),
            /economy_plan_bid_unfunded/, 'a bid above queue + tranche is refused');
        await Afk.replaceBotRecords(owner, 'buy_ad', [], { expected: expected(await records()) });
    }

    // 3. Worker bid: the kit cost is the bot's own estimate (survivalMissing
    // 100 x unit price 10 = 1000), whatever it bids. A bid below 10 for 250
    // shots buys floor(1000 / price) (e.g. 7: 142 = 994): the worker, main
    // and the native check must all allow it, not 100 x price (700).
    const kitCost = (id, unitPrice = null) => Number(id) === SHOT ? 100 * (unitPrice > 0 ? unitPrice : 10) : 0;
    const economy = { kitCost, worth: () => 7, moneyPrice: 0 };
    const goal = { type: 'buy_craft_material', target: { itemId: SHOT, amount: 250, adena: 7 },
        plan: { estimatedCost: 7, priceSource: 'market' } };
    const poor = Life.cachedState(owner);
    assert.equal(BuyAdPolicy.bidFor(poor, goal, { economy: { ...economy, kitCost: () => 0 }, board: null }), null,
        'no queue money and no kit: no bid');
    // The goal path caps the bid by the goal's money: without the tranche
    // there is none, with it the whole kit.
    assert.equal(BuyAdPolicy.bidFor(poor, goal, { economy, board: null,
        money: Funding.spendable(poor, 0, Funding.goalTerms(goal)) }), null, 'goal money without the tranche funds nothing');
    const money = BuyAdPolicy.goalMoney(poor, goal, 0, economy);
    assert.equal(money, 1000, 'the goal money holds the tranche');
    const bid = BuyAdPolicy.bidFor(poor, goal, { economy, board: null, money });
    assert(bid, 'the tranche funds a shot bid');
    assert(bid.price > 0 && bid.price < 10, `a bid below the unit price: ${bid.price}`);
    assert.equal(bid.count, Math.floor(1000 / bid.price)); assert.equal(bid.survivalCost, 1000);
    assert(bid.count * bid.price > 100 * bid.price, 'more than a kit priced at the bid');
    const otherGoal = { ...goal, target: { itemId: OTHER, amount: 100, adena: 7 } };
    const otherBid = BuyAdPolicy.bidFor(poor, otherGoal, { economy, board: null, money: BuyAdPolicy.goalMoney(poor, otherGoal, 0, economy) });
    assert(!otherBid || otherBid.count * otherBid.price <= Funding.spendable(poor, 0, { itemId: OTHER }),
        'another item stays on its queue money');

    // 4. The whole chain: the worker's lines, the plan batch, executePlan and
    // the native check publish the bid the worker decided.
    const lines = BuyAdPolicy.linesFor(poor, goal, { economy, board: null, watchList: [], money });
    assert.deepEqual(lines.map(line => [line.selfId, line.count, line.price, line.survivalCost]), [[SHOT, bid.count, bid.price, 1000]]);
    const batch = invoke('GameServer/Bot/Population/ColdEconomyPlan').buyBatch(lines);
    assert.deepEqual(batch, { buyAds: [[SHOT, bid.count, bid.price]], buyKit: [1000] });
    await Market.executePlan(Life.cachedState(owner), batch);
    ads = await records();
    assert.deepEqual(ads.map(ad => [ad.lines[0].selfId, ad.lines[0].count, ad.lines[0].price]), [[SHOT, bid.count, bid.price]]);
    assert.equal(await wallet(), 10000);

    console.log('Survival tranche: native bid check, executePlan and worker bid fund a shot ad by its kit cost');
}
run().then(() => Database.close()).catch(async error => { console.error(error); process.exitCode = 1; await Database.close(); });
