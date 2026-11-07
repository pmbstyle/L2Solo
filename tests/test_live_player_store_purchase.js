'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('live-player-store');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
fixture.assertConfigured(options.default);
// The author's fixed shot merchant sells shots here (off by default since T116).
invoke('GameServer/Bot/Population/PopulationConfig').staticShotsDisabled = false;
const DB = invoke('Database'), Data = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Trade = invoke('GameServer/Bot/TradeService'), Shots = invoke('GameServer/Inventory/ShotStock');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const EquipmentShopping = invoke('GameServer/Bot/AI/CompanionEquipmentShopping');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const Response = invoke('GameServer/Network/Response');
const originals = new Map();
// Native packet layout has its own request/socket test. Here presentation is
// recorded while real publication, queries, funding and SQLite writes execute.
for (const name of ['userInfo', 'charInfo', 'sitAndStand']) {
    originals.set(name, Response[name]); Response[name] = () => Buffer.alloc(1);
}
const { POINT, character, stock, publish, sqlAmount, memoryAmount, balances } = require('./helpers/liveMarketActors');

(async () => {
    Data.init(); DB.init(); World.user = { sessions: [], revision: 0 };
    await Life.init();
    const seller = await character(), buyer = await character(true), second = await character(true);
    const source = await stock(seller, 1463, 600);
    await stock(buyer, 156, 1, 0, true, 7);
    await stock(second, 156, 1, 0, true, 7);
    let store = publish(seller, [{ objectId: source, count: 600, price: 5 }]);
    const offer = () => Market.hotOffers(1463, { town: 'Giran', buyerCharacterId: buyer.actor.fetchId() })
        .find(row => row.sourceId === seller.actor.fetchId());
    assert.equal(offer()?.objectId, source, 'publication is discoverable by its real inventory lot');
    assert.equal(offer().town, 'Giran', 'a normal native store without a town field is located physically');
    assert(!Market.hotOffers(1463, { town: 'Dion' }).some(row => row.sourceId === seller.actor.fetchId()));
    assert(!Market.hotOffers(1463, { town: 'Giran', budget: 4 }).some(row => row.sourceId === seller.actor.fetchId()));
    assert(!Market.bestOffer(1463, { town: 'Giran' })?.session, 'cold offer query keeps face-to-face stores out');
    seller.actor.storeType = 2; assert.equal(offer(), undefined, 'an edited draft is not public');
    seller.actor.storeType = 0; assert.equal(offer(), undefined, 'closing keeps the object but removes its offer');
    seller.actor.storeType = 1;
    assert.equal(Shots.restockTarget(buyer.actor, 'Giran').actorId, seller.actor.fetchId());
    store.items[0].price = 2000;
    assert.equal(Shots.liveRestockTarget(buyer.actor, 'Giran'), null, 'a live quote above the accepted shot price does not attract a trip');
    assert.equal(Shots.restockTarget(buyer.actor, 'Giran'), null, 'companion restock also skips an unacceptable live quote');
    store.items[0].price = 5;
    buyer.actor.point.locX += 1000;
    await assert.rejects(Trade.buyFromStore(buyer.actor, store, 1463, 1), /private_store_changed/);
    const staged = Shots.liveRestockTarget(buyer.actor, 'Giran');
    assert.equal(staged?.actorId, seller.actor.fetchId(), 'a funded shot restock selects the physical seller');
    Shopping.scheduleRestock(buyer, buyer.actor, {}, {});
    assert.equal(buyer.shoppingTarget.actorId, seller.actor.fetchId(), 'normal shopping routes to the player before buying');
    assert.equal(buyer.shoppingRestock, undefined, 'no purchase timer starts while walking to the seller');
    buyer.actor.point = { ...POINT };
    const before = await balances(seller, buyer);
    const result = await Shots.purchaseActorRestock(buyer.actor, { town: 'Giran', targetAmount: 100,
        unitPrice: 500, potionUnitPrice: 0, skipNpc: true });
    assert.equal(result.delta, 100); assert.equal(result.cost, 500);
    const after = await balances(seller, buyer);
    assert.deepEqual(after, [[before[0][0] + 500, 500, before[0][2] + 500, 500],
        [before[1][0] - 500, 100, before[1][2] - 500, 100]], 'both SQLite and live bags conserve money and shots');
    assert.equal(store.items[0].count, 500);
    assert.equal(buyer.coldLifeState.inventory[1463].amount, 100, 'hot state follows its real acquired stock');

    // The last lot is sold once even if two bots accept it in the same tick.
    const race = await Promise.allSettled([buyer, second].map(session => Trade.buyFromStore(session.actor, store, 1463, 500,
        { expectedUnitPrice: 5, funding: { itemId: 1463 } })));
    assert.equal(race.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(await sqlAmount(seller, 1463), 0); assert.equal(memoryAmount(seller, 1463), 0);
    assert.equal((await sqlAmount(buyer, 1463)) + (await sqlAmount(second, 1463)), 600);
    assert.equal(seller.actor.storeType, 0, 'selling out closes the native shop');

    const extra = await stock(seller, 1463, 10);
    store = publish(seller, [{ objectId: extra, count: 10, price: 5 }]);
    await assert.rejects(Trade.buyFromStore(second.actor, store, 1463, 1, { expectedUnitPrice: 4 }), /private_store_changed/);
    second.coldLifeState.stats.money = [77000, 1, 1000000, 0];
    await assert.rejects(Trade.buyFromStore(second.actor, store, 1463, 1), /economy_funding_changed/);
    second.coldLifeState.stats.money = [77000, 1e-5, 1000, 0, 4e-5, 1000000, 1463];
    const unchanged = await balances(seller, second);
    const control = new DatabaseSync(fixture.world);
    control.exec(`CREATE TRIGGER fail_live_store_credit BEFORE UPDATE OF amount ON items
        WHEN NEW.characterId=${seller.actor.fetchId()} AND NEW.selfId=57 BEGIN SELECT RAISE(ABORT,'injected_credit_failure'); END`);
    await assert.rejects(Trade.buyFromStore(second.actor, store, 1463, 1), /injected_credit_failure/);
    assert.deepEqual(await balances(seller, second), unchanged, 'failed seller credit rolls back every SQL and live balance');
    assert.equal(store.items[0].count, 10, 'failed transaction leaves the advertised stock intact');
    control.exec('DROP TRIGGER fail_live_store_credit'); control.close();

    // Recheck after DB flushes too: closing/repricing while a purchase is
    // queued must abort without transferring either side of the exchange.
    const nativeBuy = DB.buyFromLivePrivateStore;
    DB.buyFromLivePrivateStore = (id, details) => { seller.actor.storeType = 0; return nativeBuy(id, details); };
    try { await assert.rejects(Trade.buyFromStore(second.actor, store, 1463, 1), /private_store_changed/); }
    finally { DB.buyFromLivePrivateStore = nativeBuy; seller.actor.storeType = 1; }
    assert.deepEqual(await balances(seller, second), unchanged);
    DB.buyFromLivePrivateStore = (id, details) => { store.items[0].price = 6; return nativeBuy(id, details); };
    try { await assert.rejects(Trade.buyFromStore(second.actor, store, 1463, 1), /private_store_changed/); }
    finally { DB.buyFromLivePrivateStore = nativeBuy; store.items[0].price = 5; }
    assert.deepEqual(await balances(seller, second), unchanged, 'a price changed during the await cannot debit the old quote');

    // Gear shopping uses the same live offers and pays for the exact copy,
    // preserving enchantment rather than creating an unenchanted template.
    const sword = await stock(seller, 1, 1, 4);
    store = publish(seller, [{ objectId: sword, count: 1, price: 200 }]);
    assert.equal(store.items[0].enchant, 4);
    second.partyCompanion = true;
    second.coldLifeState.stats.money = [77000, 1e-5, 1000, 0, 4e-5, 1000, 1];
    second.coldLifeState.stats.equipmentPlan = { status: 'active', strategy: 'market',
        target: { selfId: 1, name: 'Short Sword', slot: 7 }, amount: 1 };
    const errand = EquipmentShopping.planErrand(second, second.actor, { name: 'Giran', ...POINT });
    assert.equal(errand?.sourceId, seller.actor.fetchId()); assert.equal(errand.objectId, sword);
    assert.equal(errand.price, 200);
    const bought = await Trade.buyFromStore(second.actor, store, errand.itemId, errand.amount,
        { objectId: errand.objectId, expectedUnitPrice: errand.price, funding: errand.funding });
    assert.equal(bought.qty, 1);
    const swordRows = (await DB.fetchItems(second.actor.fetchId())).filter(row => row.selfId === 1);
    assert.equal(swordRows.length, 1); assert.equal(swordRows[0].enchant, 4);
    assert.equal(second.actor.backpack.fetchItemFromSelfId(1).fetchEnchantLevel(), 4);

    const nativeBuyer = await character(true);
    await stock(nativeBuyer, 156, 1, 0, true, 7);
    const nativeLot = await stock(seller, 1463, 10);
    store = publish(seller, [{ objectId: nativeLot, count: 10, price: 5 }]);
    const ordinaryRestock = await Shots.purchaseActorRestock(nativeBuyer.actor, { town: 'Giran', skipNpc: true,
        potionUnitPrice: 0 });
    assert.equal(ordinaryRestock.delta, 10, 'ordinary restock uses its native stock target and funding without a forced amount');
    assert.equal(ordinaryRestock.cost, 50);
    await DB.close();
    const history = new DatabaseSync(fixture.history, { readOnly: true });
    const trades = history.prepare("SELECT * FROM market_trades WHERE sourceType='private_store' ORDER BY id").all();
    assert.equal(trades.length, 4, 'one durable record per committed live sale, none for failed attempts');
    assert.equal(trades[0].sellerCharacterId, seller.actor.fetchId());
    assert.equal(trades[0].buyerCharacterId, buyer.actor.fetchId());
    assert.equal(trades[0].totalPrice, 500);
    history.close();
    console.log('PASS live player stores: publication, local discovery, shopping approach, funded restock, atomic sale, races, rollback, stale shop and enchanted gear');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const [name, value] of originals) Response[name] = value;
    await DB.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
