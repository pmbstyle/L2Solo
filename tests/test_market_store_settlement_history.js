const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Buyers = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'store-settlement-'));
options.default.Database.path = path.join(directory, 'world.sqlite');
invoke('GameServer/DataCache').init();
(async () => {
    Database.init();
    await Database.execute(["INSERT INTO accounts(username,password) VALUES('shop_test','unused')"]);
    for (const id of [7, 8, 9]) await Database.execute([`INSERT INTO characters
        (id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES(?,'shop_test',?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `Trader${id}`]]);
    await Life.init();
    const state = (id, amount = 0) => ({ characterId: id, name: `Trader${id}`, accountName: 'shop_test',
        level: 40, phase: 'cold', activity: 'shopping', currentRegion: 'Giran', adena: id === 7 ? 1000 : 0,
        inventory: { 57: { selfId: 57, amount: id === 7 ? 1000 : 0 },
            1864: { selfId: 1864, name: 'Stem', amount, stackable: true, kind: 'Other.Material' } },
        stats: {}, timing: {}, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, loc: {} });
    const buyer = state(7);
    buyer.activity = 'merchant';
    buyer.stats.marketStore = { id: 'partial-wtb', storeType: 3, budgetBacked: true, town: 'Giran',
        openedAt: Date.now(), expiresAt: Date.now() + 600000,
        items: [{ selfId: 1864, name: 'Stem', kind: 'Other.Material', price: 100, count: 3 }] };
    Market.indexColdStore(await Life.upsertState(buyer, 'cold_market_buy_store'));
    const seller = await Life.upsertState(state(8, 2), 'seed');
    const lastSeller = await Life.upsertState(state(9, 1), 'seed');
    for (const s of [buyer, seller, lastSeller]) await Database.syncInventorySummary(s.characterId, s.inventory);
    const events = () => Database.readHistory(["SELECT eventType,reason FROM market_store_events WHERE storeId='partial-wtb' ORDER BY id"]);
    const partial = await Buyers.sellToBestBuyer(seller, 'Giran');
    assert.strictEqual(partial.itemCount, 2);
    assert.strictEqual(partial.sales[0].buyer.activity, 'merchant');
    assert.strictEqual(partial.sales[0].buyer.stats.marketStore.items[0].count, 1);
    assert.deepStrictEqual(await events(), [{ eventType: 'opened', reason: 'cold_market_buy_store' }],
        'real partial settlement must not close or reopen the journaled store');
    // Exercise the real compensation write after an intermediate buyer write.
    const before = structuredClone(partial.sales[0].buyer);
    assert(await Life.applyMarketPurchase(before, { selfId: 1864, price: 100 }, 1));
    assert(await Life.restoreMarketState(before, 'cold_market_buy_seller_rollback'));
    assert.strictEqual((await events()).length, 1, 'compensated purchase must not leave a false closure');
    Market.indexColdStore(Life.snapshot(7));
    const filled = await Buyers.sellToBestBuyer(lastSeller, 'Giran');
    assert.strictEqual(filled.itemCount, 1);
    assert.strictEqual(filled.sales[0].buyer.stats.marketStore, null);
    assert.deepStrictEqual(await events(), [
        { eventType: 'opened', reason: 'cold_market_buy_store' },
        { eventType: 'closed', reason: 'cold_market_buy_filled' }
    ]);
    assert.strictEqual(Life.snapshot(7).adena, 700);
    assert.strictEqual(Life.snapshot(7).inventory[1864].amount, 3);
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
    console.log('Real partial WTB, compensated purchase and final fill preserve journal lifecycle');
})().catch(async error => {
    console.error(error);
    await Database.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
    process.exitCode = 1;
});
