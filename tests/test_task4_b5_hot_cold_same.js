'use strict';
// Task 4 B5 (N9): one decision read hot and cold gives the same leaf, root, item and amount, and a bot
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
const { capture } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
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
    await Database.setItem(1, { selfId: 57, name: 'Adena', amount: 10000, stackable: true });
    await Database.setItem(1, { selfId: itemId, name: 'Stem', amount: 4, stackable: true });
    const cold = await Life.upsertState({ characterId: 1, accountName: 'bot_b5_hotcold', name: 'Native1', level: 30,
        exp: 0, sp: 0, adena: 10000, phase: 'cold', activity: 'hunting', homeRegion: 'Giran', currentRegion: 'Giran',
        loc: { x: 83000, y: 148000, z: -3400 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, classId: 0, shopTown: { town: 'Giran', at: 1 }, money: [10000, .0001, 0, 0, .001, 10000, itemId] },
        inventory: { 57: { selfId: 57, amount: 10000 }, [itemId]: { selfId: itemId, amount: 4 } },
        simulation: { ownerId: 'legacy_main', revision: 0 }, timing: {}, updatedAt: Date.now() }, 'native_fixture');

    // One decision, read cold (the card) and hot (the held economy of DecisionEvents.hold).
    const coldGoal = goalOf(cold, { network: { activity: capture({ network, inputKey: 'one' }, cold).activity },
        inputHash: 1, state: cold });
    invoke('GameServer/Inventory/ShotStock').enableAutoShot = () => null;
    const session = { decisionStats: { decisionSeq: 1 } };
    const held = Events.hold(session, { backpack: { fetchItems: () => [], fetchTotalLoad: () => 0 }, fetchLevel: () => 30 },
        { stock: () => null, network, statsPacket: { decisionSeq: 1, activityLeaf: 0 }, inputKey: 'one' });
    const hotState = { ...cold, phase: 'hot' };
    const hotGoal = goalOf(hotState, { ...held, state: hotState });
    const view = goal => ({ type: goal.type, itemId: goal.target.itemId, amount: goal.target.amount,
        adena: goal.target.adena, rootKey: goal.plan.wishKey, kind: goal.plan.kind, activity: goal.plan.economyActivity });
    assert.deepEqual(view(coldGoal), { type: 'buy_craft_material', itemId, amount: 26, adena: 2, rootKey,
        kind: 'buy', activity: 'shopping' });
    assert.deepEqual(view(hotGoal), view(coldGoal), 'hot and cold read the same leaf, root, item and amount');

    // Cold opens its buy ad for the root's material.
    const opened = await Market.reconcileBuyAds(cold, coldGoal, [coldGoal]);
    assert.equal(buyAds(1).length, 1, 'cold publishes one buy ad');
    const ad = buyAds(1)[0];
    assert.equal(ad.lines[0].selfId, itemId);
    assert.equal(ad.lines[0].count, 26, opened.reason);
    const escrow = ad.escrowAdena;
    const walletAfterAd = Native.amount(await Database.fetchItems(1), 57);
    assert.equal(walletAfterAd, 10000 - escrow);

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
