const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
invoke('GameServer/DataCache').init();
const Database = invoke('Database');
const Shot = invoke('GameServer/Inventory/ShotStock');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const originals = { update: Database.updateItemAmount, fetch: Database.fetchItems,
    offers: Afk.offers, buy: Afk.buyFromShop };
const updates = [], purchases = [];
let offers = [], current;
const failed = new Set();
const plan = Shot.planForKind('soulshot', 'none');
function actor(shots, adena, reserve = 0) {
    const rows = new Map();
    for (const [id, selfId, amount] of [[1, 57, adena], [2, 1835, shots]]) rows.set(selfId, {
        id, selfId, amount, fetchId() { return this.id; }, fetchSelfId() { return this.selfId; },
        fetchAmount() { return this.amount; }, setAmount(value) { this.amount = value; } });
    return { fetchId: () => 100, fetchLevel: () => 1, fetchClassId: () => 0,
        session: { coldLifeState: { phase: 'hot', stats: { classId: 0, money: [10000, .0001, reserve, 0, .001, 21000, 1835] } } },
        backpack: { fetchItemFromSelfId: id => rows.get(Number(id)), fetchItems: () => [...rows.values()] } };
}
// ARCH-NOTE: the old fixed 1000/3000 threshold and percentage reserve were
// replaced by the native hourly stock and wish packet. This fixture pins an
// explicit paid target and packet to verify the purchase/failed-shop mechanics;
// native target and affordability gates are covered by the stock interval test.
const buy = value => { current = value; return Shot.purchaseActorRestock(value,
    { plan, targetAmount: 3000, unitPrice: 7, potionUnitPrice: 0, town: 'Giran' }); };
async function run() {
    Database.updateItemAmount = async (characterId, itemId, amount) => { updates.push({ characterId, itemId, amount }); };
    Afk.offers = () => offers;
    Afk.buyFromShop = async (_id, store, selfId, amount, options) => {
        if (failed.has(store)) throw Error('afk_trade_stock_changed');
        purchases.push([store, amount, options.expectedPrice]);
        const money = current.backpack.fetchItemFromSelfId(57), shots = current.backpack.fetchItemFromSelfId(selfId);
        money.setAmount(money.fetchAmount() - amount * options.expectedPrice);
        shots.setAmount(shots.fetchAmount() + amount);
        return {};
    };
    const funded = actor(999, 20000, 2000), result = await buy(funded);
    assert.equal(result.delta, 2001); assert.equal(result.cost, 14007);
    assert.equal(funded.backpack.fetchItemFromSelfId(57).fetchAmount(), 5993);
    assert.deepEqual(updates, [{ characterId: 100, itemId: 1, amount: 5993 }, { characterId: 100, itemId: 2, amount: 3000 }]);
    updates.length = 0;
    assert.equal((await buy(actor(3000, 20000, 2000))).changed, false);
    assert.deepEqual(updates, []);
    const partial = actor(0, 7000, 700);
    assert.equal((await buy(partial)).delta, 900);
    assert.equal(partial.backpack.fetchItemFromSelfId(57).fetchAmount(), 700);
    updates.length = 0;
    const empty = actor(100, 500, 500);
    assert.equal((await buy(empty)).changed, false);
    assert.equal(empty.backpack.fetchItemFromSelfId(1835).fetchAmount(), 100);
    assert.deepEqual(updates, []);

    offers = [{ store: 'b', price: 6, count: 500 }, { store: 'a', price: 5, count: 1000 },
        { store: 'c', price: 7, count: 5000 }, { store: 'd', price: 6, count: 600 }];
    const shopped = await buy(actor(0, 100000));
    assert.deepEqual(purchases, [['a', 1000, 5], ['b', 500, 6], ['d', 600, 6]]);
    assert.equal(shopped.delta, 3000); assert.equal(shopped.cost, 17900);
    purchases.length = 0; failed.add('b');
    offers = [{ store: 'a', price: 5, count: 1000 }, { store: 'b', price: 6, count: 2500 }];
    const mixed = await buy(actor(0, 100000));
    assert.deepEqual(purchases, [['a', 1000, 5]]);
    assert.deepEqual([mixed.delta, mixed.cost], [3000, 19000]);
    purchases.length = 0; offers = [{ store: 'b', price: 6, count: 5000 }];
    const allFailed = await buy(actor(0, 100000));
    assert.deepEqual(purchases, []); assert.deepEqual([allFailed.delta, allFailed.cost], [3000, 21000]);
    offers = []; failed.clear();

    const dPlan = Shot.planForKind('soulshot', 'd');
    let cold = { characterId: 100, level: 30, phase: 'cold', spotId: '-10_30', adena: 51000,
        stats: { classId: 0, money: [10000, .0001, 7500, 0, .001, 60000, 1463, .001, 61400, 1061] },
        inventory: { 1463: { selfId: 1463, amount: 200 } } };
    const hot = actor(0, 51000, 7500); hot.fetchLevel = () => 30;
    hot.session.coldLifeState = { ...cold, phase: 'hot' };
    const held = { id: 3, selfId: 1463, amount: 200, fetchId() { return this.id; }, fetchSelfId() { return this.selfId; }, fetchAmount() { return this.amount; } };
    const fetch = hot.backpack.fetchItemFromSelfId;
    hot.backpack.fetchItemFromSelfId = id => Number(id) === 1463 ? held : Number(id) === 1835 ? undefined : fetch(id);
    hot.backpack.fetchItems = () => [fetch(57), held];
    // Mirror the native hot kit, not an unrelated empty cold combat profile.
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const mirrored = Economy.stateForActor(hot);
    const packet = Economy.forState(mirrored).statsPacket;
    cold = { ...mirrored, phase: 'cold', stats: { ...mirrored.stats, ...packet } };
    hot.session.coldLifeState = { ...cold, phase: 'hot' };
    const options = { plan: dPlan, targetAmount: 3000, unitPrice: 20, potionUnitPrice: 200,
        offers: [{ store: 'a', price: 15, count: 400 }] };
    const coldPlan = Shot.restockPlan(cold, options), hotPlan = Shot.restockPlan(hot, options);
    assert.deepEqual(hotPlan, coldPlan);
    const potions = Potions.restockPlan(cold, { unitPrice: 200 });
    assert(potions.amount > 0); assert.equal(coldPlan.potionCost, coldPlan.needed ? potions.cost : 0);
    assert(coldPlan.cost + coldPlan.potionCost <= cold.adena - packet.money[2]);
    assert.equal(coldPlan.needed, false, 'an unequipped native bot has no funded D-shot wish');
    assert.equal(coldPlan.amount, 0); assert.deepEqual(coldPlan.shops, []);

    updates.length = 0;
    Database.fetchItems = async () => [{ id: 2, selfId: 1835, amount: 3000, equipped: 0, slot: 0 }];
    const retained = await Shot.ensureCharacterStock(100, { plan, targetAmount: Shot.DEFAULT_TARGET_AMOUNT });
    assert.equal(retained.changed, false); assert.equal(retained.amount, 3000); assert.deepEqual(updates, []);
    assert.equal(Database.isReady(), false);
    console.log('Paid shot restock: packet funding, ordered shops, NPC fallback, potion allowance, hot/cold parity and restart preservation passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Database.updateItemAmount = originals.update; Database.fetchItems = originals.fetch;
    Afk.offers = originals.offers; Afk.buyFromShop = originals.buy;
});
