'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('market-goal-quantity');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Native = require('./helpers/nativeMarketFixture');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Decisions = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions;
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Opportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
// A material purchase on arrival buys what the held card still orders: its
// amount less what reached the bag since its decision (the one progress count).
Data.init();

async function buyer(id, wallet, held = 0, itemId = 2509) {
    await Native.character(Database, id, `Quantity${id}`, `bot_quantity_${id}`);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: wallet, stackable: true });
    await Database.setItem(id, { selfId: 736, name: 'Scroll of Escape', amount: 2, stackable: true });
    if (held) await Database.setItem(id, { selfId: 2509, name: 'Spiritshot', amount: held, stackable: true });
    return Life.upsertState({ characterId: id, name: `Quantity${id}`, accountName: `bot_quantity_${id}`,
        phase: 'cold', activity: 'shopping', level: 42, adena: wallet,
        currentRegion: 'Dion', homeRegion: 'Dion', loc: { locX: 19000, locY: 145000, locZ: -3100 },
        stats: { classId: 12, money: [36000, 0.001, 0, 0, 0.001, wallet, itemId] },
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        inventory: { 57: { selfId: 57, amount: wallet }, 736: { selfId: 736, amount: 2 }, ...(held ? { 2509: { selfId: 2509, amount: held } } : {}) },
        simulation: { revision: 0 }, updatedAt: Date.now() }, 'quantity_fixture');
}
// The goal on arrival, read from the held card (NeedsEvaluator): the card orders
// `amount` at the NPC's unit price, at its root's place in the money queue (r),
// over what the bag held at its decision (heldAtDecision, default the bag now).
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
function goal(state, amount, itemId = 2509, adena = Number(Opportunity.npcOffersAll(itemId).find(offer => offer.town === 'Dion')?.price),
    heldAtDecision = Native.amount(Object.values(state.inventory), itemId)) {
    Decisions.hold(state.characterId, { updatedAt: 0, echo: [1, 1, null], inputHash: 1, activity: { activity: 'shopping', itemId,
        amount, unitPrice: adena, price: adena * amount, town: 'Dion', sourceType: 'npc', r: 0.001, heldAtDecision } });
    return Needs.goal(state);
}
async function run() {
    Database.init();
    const npc = Opportunity.npcOffersAll(2509).find(offer => offer.town === 'Dion');
    assert(npc?.price > 0, 'real catalog supplies a concrete NPC Spiritshot quote');
    const price = Number(npc.price);
    const state = await buyer(9101, price * 2000, 100);
    const fullGoal = goal(state, 1000);
    const result = await Market.tryPurchase(state, fullGoal);
    assert.equal(result.units, 1000, 'remaining goal is not the whole bag target or default one');
    assert.equal(Native.amount(await Database.fetchItems(9101), 2509), 1100);
    assert.equal(Native.amount(await Database.fetchItems(9101), 57), price * 1000);
    assert.equal(Needs.goal(result.state), null, 'the filled card leaves no goal');
    assert.equal((await Market.tryPurchase(result.state, Needs.goal(result.state))).reason, 'no_purchase_goal');
    assert.equal(Native.amount(await Database.fetchItems(9101), 2509), 1100, 'a filled step cannot buy another full stack');

    const short = await buyer(9102, price * 200), shortGoal = goal(short, 1000);
    const partial = await Market.tryPurchase(short, shortGoal);
    assert.equal(partial.units, 200);
    assert.equal(Native.amount(await Database.fetchItems(9102), 2509), 200);
    assert.equal(Native.amount(await Database.fetchItems(9102), 57), 0);
    // 300 reached the bag since the decision (a meeting on the way): the step buys only the rest.
    const met = await buyer(9103, price * 2000, 300), metGoal = goal(met, 1000, 2509, price, 0);
    assert.equal(metGoal.target.amount, 700, 'the goal is the rest of the card');
    assert.equal((await Market.tryPurchase(met, metGoal)).units, 700, 'the rest of the card, not its whole amount again');
    assert.equal(Native.amount(await Database.fetchItems(9103), 2509), 1000);
    const purchase = Database.purchaseNpcInventoryBasket;
    const refusedState = await buyer(9105, price * 2000), refusedGoal = goal(refusedState, 1000);
    try {
        Database.purchaseNpcInventoryBasket = async () => ({ ok: false, lines: [] });
        assert.equal((await Market.tryPurchase(refusedState, refusedGoal)).units, 0);
        assert.equal(Native.amount(await Database.fetchItems(9105), 57), price * 2000);
    } finally { Database.purchaseNpcInventoryBasket = purchase; }
    const unknown = await Market.tryPurchase(refusedState, { ...refusedGoal, target: { itemId: 2509 } });
    assert.equal(unknown.reason, 'purchase_quantity_unknown');
    await Native.character(Database, 9106, 'QuantitySeller', 'bot_quantity_seller');
    await Database.setItem(9106, { selfId: 1864, name: 'Stem', amount: 600, stackable: true });
    // E115: a bot's sell_ad settles only through a meeting; an immediate
    // board purchase needs the seller's backed shop, as real bots publish.
    const stem = (await Database.fetchItems(9106)).find(item => Number(item.selfId) === 1864);
    await Afk.publishBot(9106, { kind: 'shop', storeType: Afk.SELL, town: 'Dion', title: 'Stem',
        lines: [{ selfId: 1864, name: 'Stem', count: 600, price: 10, enchant: 0, stackable: true, objectId: stem.id }] });
    const stemBuyer = await buyer(9107, 20000, 0, 1864);
    const finite = await Market.tryPurchase(stemBuyer, goal(stemBuyer, 1000, 1864, 10));
    assert.equal(finite.units, 600, 'finite public stock leaves the actual unmet need');
    assert.equal(Native.amount(await Database.fetchItems(9107), 1864), 600);
    console.log('Native goal quantities: full/partial stock and funds, existing bag, the rest after a partial buy, refusal and unknown amount passed');
}
run().then(async () => {
    await Database.close();
}).catch(async error => {
    console.error(error); process.exitCode = 1; await Database.close();
});
