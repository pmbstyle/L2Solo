'use strict';
// One decision read hot and cold gives the same leaf, root, item and amount, and a bot
// flipped cold -> hot -> cold with an open buy ad keeps exactly one ad for one root (no second ad,
// no second escrow): hot leaves the cold ad standing, the cold return sees the same order.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('task4-b5-hot-cold');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const { WishNetwork } = invoke('GameServer/Bot/Economy/WishNetwork');
const { capture, view: decisionView } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Native = require('./helpers/nativeMarketFixture');
invoke('GameServer/DataCache').init();
fixture.assertConfigured(options.default);

const itemId = 1864, rootKey = 'power:101:7'; // Stem: a craft material, no equipment slot
const material = { key: `item:${itemId}`, price: 2, paths: [{ kind: 'buy', activity: 'shopping', price: 2, itemId,
    executable: true, quoted: true, availableUnits: 100 }] };
const product = { key: 'item:101', price: 500, paths: [{ kind: 'craft', activity: 'crafting', costHours: .1,
    itemId: 101, productCount: 2, recipeId: 7, grossRequirements: [{ key: material.key, amount: 10 }],
    requirements: [{ key: material.key, amount: 6 }] }] };
const root = { key: rootKey, need: 'power', valueHours: 100, object: { itemId: 101 },
    paths: [{ requirements: [{ key: product.key, amount: 5 }] }] };
const network = new WishNetwork().build({ actorKey: 'hot-cold', inputKey: 'one', nodes: [root, product, material],
    roots: [rootKey], wallet: 10000, hourAdena: 100, stockFor: id => id === itemId ? { owned: 4 } : {},
    persona: { traits: { commitment: 0 } }, remembered: false });
async function row(id) { return (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]; }
async function current(id) { return Life.acceptLifecycleRow(await row(id)); }
async function step(id, kind) { return Commit.admit(await current(id), kind); }
const buyAds = id => Afk.ownerRecords(id).filter(record => record.kind === 'buy_ad');
const goalOf = (state, economy) => Needs.evaluate(state, { now: 1000, errand: null, economy })
    .find(goal => goal.target?.itemId === itemId);

async function run() {
    Database.init();
    await Life.init();
    await Native.character(Database, 1, 'Native1', 'bot_b5_hotcold');
    await Database.setItem(1, { selfId: 57, name: 'Adena', amount: 100000, stackable: true });
    await Database.setItem(1, { selfId: itemId, name: 'Stem', amount: 4, stackable: true });
    const cold = await Life.upsertState({ characterId: 1, accountName: 'bot_b5_hotcold', name: 'Native1', level: 30,
        exp: 0, sp: 0, adena: 100000, phase: 'cold', activity: 'hunting', homeRegion: 'Giran', currentRegion: 'Giran',
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, classId: 0, shopTown: { town: 'Giran', at: 1 },
            // The material's row stands at its funded root's place in the money queue.
            money: [10000, .0001, 0, 0, invoke('GameServer/Bot/Economy/PurchaseFunding').rootRatio(network.queue[0]), 100000, itemId] },
        inventory: { 57: { selfId: 57, amount: 100000 }, [itemId]: { selfId: itemId, amount: 4 } },
        simulation: { revision: 0 }, timing: {}, updatedAt: Date.now() }, 'native_fixture');

    // One decision, read cold (the card) and hot (the near body's held view of the same card,
    // DecisionEvents.receive).
    const card = capture({ network, inputKey: 'one' }, cold);
    const coldGoal = goalOf(cold, { network: { activity: card.activity }, inputHash: 1, state: cold });
    const hotState = { ...cold, phase: 'hot' };
    const session = { decisionStats: { decisionSeq: 1 }, heldEconomy: decisionView(hotState, card) };
    const held = Events.held(session);
    const hotGoal = goalOf(hotState, { ...held, state: hotState });
    const view = goal => ({ type: goal.type, itemId: goal.target.itemId, amount: goal.target.amount,
        adena: goal.target.adena, rootKey: goal.plan.wishKey, kind: goal.plan.kind, activity: goal.plan.economyActivity });
    assert.deepEqual(view(coldGoal), { type: 'buy_craft_material', itemId, amount: 26, adena: 2, rootKey,
        kind: 'buy', activity: 'shopping' });
    assert.deepEqual(view(hotGoal), view(coldGoal), 'hot and cold read the same leaf, root, item and amount');

    // Cold posts its build's bid for the root's material (the plan's row: item, amount, price).
    await Market.executePlan(cold, { buyAds: [[itemId, coldGoal.target.amount, coldGoal.target.adena]] }, { reviewGoal: false });
    assert.equal(buyAds(1).length, 1, 'cold publishes one buy ad');
    const ad = buyAds(1)[0];
    assert.equal(ad.lines[0].selfId, itemId);
    assert.equal(ad.lines[0].count, 26);
    const escrow = ad.escrowAdena;
    const walletAfterAd = Native.amount(await Database.fetchItems(1), 57);
    assert.equal(walletAfterAd, 100000 - escrow);

    // Flip hot with the ad open: the hot review neither withdraws nor republishes it.
    const hot = await Life.upsertState({ ...(await current(1)), phase: 'hot', timing: { lastHotAt: Date.now() } }, 'receipt_handoff');
    assert.equal(hot.phase, 'hot');
    assert.equal((await Market.reconcileBuyAds(hot, hotGoal, [hotGoal])).changed, false);
    assert.deepEqual(buyAds(1).map(row => [row.id, row.revision]), [[ad.id, ad.revision]], 'hot keeps the one cold ad');
    // Back cold: the same order is recognised, no second ad, no second escrow.
    await Life.upsertState({ ...(await current(1)), phase: 'cold' }, 'receipt_return', { releaseHot: true });
    const back = await current(1);
    assert.equal(back.phase, 'cold');
    assert.equal((await Market.reconcileBuyAds(back, coldGoal, [coldGoal])).changed, false);
    assert.deepEqual(buyAds(1).map(row => [row.id, row.revision]), [[ad.id, ad.revision]], 'cold return keeps the same ad');
    assert.equal(Native.amount(await Database.fetchItems(1), 57), walletAfterAd, 'escrow taken once');
    const ads = await Database.execute(['SELECT COUNT(*) AS n FROM afk_trade_shops WHERE ownerId=? AND storeType=3', [1]]);
    assert.equal(Number(ads[0].n), 1, 'one native buy record');
    assert.equal((await step(1, Commit.KINDS.afkBuy)).state.phase, 'cold', 'the cold owner admits the next step');
    console.log('Task 4 B5 hot/cold same: one decision reads the same hot and cold; cold->hot->cold keeps one buy ad, one escrow');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    require('node:fs').rmSync(fixture.directory, { recursive: true, force: true });
});
