'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
const fs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Cold = invoke('GameServer/Bot/Economy/ColdMarketService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const native = require('./helpers/nativeMarketFixture');
Data.init();
async function purchase(id, wantedId) {
    await native.character(Database, id, 'Buyer' + id, 'bot_' + id);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000 });
    await Database.setItem(id, { selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7 });
    const stockId = Number((await Database.setItem(9001, { selfId: 2, name: 'Long Sword', amount: 1 })).insertId);
    const wanted = { itemId: wantedId, itemName: wantedId === 2 ? 'Long Sword' : 'Wooden Shield', lastMissingAt: 1000 };
    const state = await Life.upsertState({ characterId: id, accountName: 'bot_' + id, name: 'Buyer' + id,
        level: 40, adena: 1000, phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
        loc: { locX: 83000, locY: 148000, locZ: -3400 },
        vitals: { hp: 1000, maxHp: 1000, mp: 300, maxMp: 300 }, timing: {},
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId: 1, generatedCold: true, equipmentPlan: { status: 'active', strategy: 'market',
            target: { selfId: 2, slot: 7 }, market: { price: 1000, town: 'Giran', sourceType: 'afk_bot_store' } },
            partyRequest: { status: 'open' }, marketWanted: wanted,
            marketRetryAfter: 100000, marketLead: { itemId: wantedId, town: 'Giran' } }
    }, 'fixture_public_purchase');
    const shop = await Afk.publishBot(9001, { kind: 'shop', storeType: 1, town: 'Giran', title: 'Long Sword',
        locX: 83000, locY: 148000, locZ: -3400, appearance: { model: { name: 'RareSupplier' } },
        lines: [{ objectId: stockId, selfId: 2, name: 'Long Sword', count: 1, price: 1000, stackable: false }] });
    const beforeBuyer = await Database.fetchItems(id), beforeSeller = await Database.fetchItems(9001);
    const offer = Market.bestOffer(2, { town: 'Giran', buyerCharacterId: id });
    assert.equal(offer.recordId, shop.id);
    const result = await Cold.buyOffer(state, { ...offer, buyerCharacterId: id, equipSlot: 7 });
    assert.equal(result.purchased, true);
    const afterBuyer = await Database.fetchItems(id), afterSeller = await Database.fetchItems(9001);
    assert.equal(native.amount(beforeBuyer, 57), 1000);
    assert.equal(native.amount(afterBuyer, 57), 0);
    assert.equal(native.amount(afterSeller, 57) - native.amount(beforeSeller, 57), 1000);
    assert.equal(native.amount(beforeBuyer, 57) + native.amount(beforeSeller, 57),
        native.amount(afterBuyer, 57) + native.amount(afterSeller, 57));
    assert.equal(native.amount(afterBuyer, 2) + native.amount(afterSeller, 2), 1);
    assert.equal(Number(afterBuyer.find(row => Number(row.selfId) === 2).equipped), 1);
    assert.equal(result.state.stats.equipmentPlan, undefined);
    assert.equal(result.state.stats.partyRequest, undefined);
    const [durable] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [id]]);
    const stats = JSON.parse(durable.statsJson);
    console.log('Native payment and target fulfillment', JSON.stringify({ id, wantedId,
        walletBefore: 1000, walletAfter: 0, sellerCredit: 1000, swordCount: 1,
        returnedWanted: result.state.stats.marketWanted, durableWanted: stats.marketWanted }));
    if (wantedId === 2) {
        for (const key of ['marketWanted', 'marketRetryAfter', 'marketLead']) {
            assert.equal(result.state.stats[key], null, 'matching fulfilled target clears ' + key);
            assert.equal(stats[key], null, 'durable matching target clears ' + key);
        }
    } else {
        assert.deepEqual(result.state.stats.marketWanted, wanted);
        assert.deepEqual(stats.marketWanted, wanted);
        assert.equal(stats.marketRetryAfter, 100000);
        assert.deepEqual(stats.marketLead, { itemId: wantedId, town: 'Giran' });
    }
}
async function run() {
    Database.init();
    await native.character(Database, 9001, 'RareSupplier', 'bot_raresupplier');
    // Actual authored dual recipe and production planner: a bought component
    // cannot complete the composed weapon's acquisition or clear its demand.
    const recipe = invoke('GameServer/Items/C4DualSwordCombinations').resolveByProductId(2523);
    const saber = { selfId: 123, name: 'Saber', amount: 1, equipped: true, equippedCount: 1,
        equippedSlots: [7], slot: 7, rank: 'd', kind: 'Weapon.Sword' };
    const dual = { characterId: 42, name: 'DualProbe', phase: 'cold', level: 40, adena: 5000000,
        activity: 'hunting', currentRegion: 'Giran', loc: { locX: 83000, locY: 148000, locZ: -3400 },
        inventory: { 123: saber }, stats: { classId: 2, role: 'dps', forcedRecipeId: recipe.recipeId } };
    const plan = Gear.planFor(dual, { recipeId: recipe.recipeId, spots: [],
        findMarketOffer: item => Number(item.selfId) === 129
            ? { selfId: 129, price: 100000, town: 'Giran', sourceType: 'npc' } : null });
    assert.equal(plan.target.selfId, 129);
    assert.equal(plan.combine.resultId, recipe.productId);
    const template = Data.items.find(row => Number(row.selfId) === 129);
    const wanted = { itemId: 129, itemName: template.template.name, lastMissingAt: 1000 };
    const acquired = Life.reconcileEquipmentInventory({ ...dual,
        inventory: { ...dual.inventory, 129: { selfId: 129, name: template.template.name, amount: 1,
            equipped: true, slot: 7, rank: template.etc.rank, kind: template.template.kind } },
        stats: { ...dual.stats, equipmentPlan: plan, marketWanted: wanted, marketRetryAfter: 100000 } });
    assert.deepEqual(acquired.stats.equipmentPlan, plan);
    assert.deepEqual(acquired.stats.marketWanted, wanted);
    assert.equal(acquired.stats.marketRetryAfter, 100000);
    console.log('Authored partial combination control preserves plan and wanted');
    await purchase(78, 21);
    await purchase(77, 2);
}
run().then(() => console.log('Matching/unrelated/partial fulfilled demand controls passed')).catch(error => {
    console.error(error); process.exitCode = 1;
}).finally(async () => { Afk._resetForTests(); Life.reset?.(); await Database.close(); });
