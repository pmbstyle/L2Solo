const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');

DataCache.init();

const originals = {
    execute: Database.execute,
    fetchItems: Database.fetchItems,
    updateItemAmount: Database.updateItemAmount,
    updateItemEquipState: Database.updateItemEquipState,
    setItem: Database.setItem,
    clearGoal: GoalState.clear,
    user: World.user,
    bestOffer: MarketOpportunity.bestOffer,
    reserve: MarketOpportunity.reserve
};

const calls = [];
const playerStore = {
    storeType: 1,
    town: 'Giran',
    items: [{ selfId: 2, price: 1000, count: 1 }]
};

async function run() {
    Database.execute = (statement) => {
        calls.push({ type: 'execute', statement });
        return Promise.resolve([]);
    };
    Database.fetchItems = () => Promise.resolve([
        { id: 10, selfId: 57, amount: 1000, equipped: false, slot: 0 },
        { id: 11, selfId: 1, amount: 1, equipped: true, slot: 7 },
        { id: 12, selfId: 21, amount: 1, equipped: true, slot: 10 }
    ]);
    Database.updateItemAmount = (characterId, id, amount) => {
        calls.push({ type: 'amount', characterId, id, amount });
        return Promise.resolve();
    };
    Database.updateItemEquipState = (characterId, id, equipped, slot) => {
        calls.push({ type: 'equip', characterId, id, equipped, slot });
        return Promise.resolve();
    };
    Database.setItem = (characterId, item) => {
        calls.push({ type: 'insert', characterId, item });
        return Promise.resolve();
    };
    GoalState.clear = (characterId, status) => {
        calls.push({ type: 'goal', characterId, status });
        return Promise.resolve(null);
    };
    World.user = { sessions: [{
        actor: {
            fetchId: () => 9001,
            fetchName: () => 'PlayerSeller',
            fetchPrivateStore: () => playerStore
        }
    }] };

    const state = {
        characterId: 77,
        accountName: 'bot77',
        name: 'ColdBuyer',
        level: 10,
        adena: 1000,
        phase: 'cold',
        activity: 'shopping',
        currentRegion: 'Giran',
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 1000 },
            1: { selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7, rank: 'none', kind: 'Weapon.Sword' }
        },
        stats: { equipment: [{ selfId: 1, slot: 7, rank: 'none', kind: 'Weapon.Sword' }] },
        loc: {},
        vitals: {},
        timing: {}
    };
    const goal = { type: 'upgrade_gear', target: { itemId: 2 } };
    const result = await ColdMarketService.tryPurchase(state, goal);

    assert.strictEqual(result.purchased, true);
    assert.strictEqual(result.state.adena, 0);
    assert.strictEqual(result.state.inventory['57'].amount, 0);
    assert.strictEqual(result.state.inventory['1'].equipped, false);
    assert.strictEqual(result.state.inventory['2'].equipped, true);
    assert.strictEqual(result.state.stats.equipment[0].selfId, 2);
    assert.strictEqual(playerStore.items[0].count, 0, 'private offer should be consumed');
    assert(calls.some((call) => call.type === 'amount' && call.id === 10 && call.amount === 0));
    assert(calls.some((call) => call.type === 'equip' && call.id === 11 && call.equipped === false));
    assert(calls.some((call) => call.type === 'insert' && call.item.selfId === 2 && call.item.equipped === true));
    assert(calls.some((call) => call.type === 'goal' && call.characterId === 77 && call.status === 'completed'));

    const noOffer = await ColdMarketService.tryPurchase({
        ...state,
        characterId: 79,
        stats: { ...state.stats, marketReturn: { loc: { locX: 100, locY: 200, locZ: -10 }, regionName: 'Field', spotId: 'field' } },
        loc: { locX: 80000, locY: 150000, locZ: -3466 }
    }, { type: 'buy_craft_material', target: { itemId: 999999, itemName: 'Missing Material' } });
    assert.strictEqual(noOffer.purchased, false);
    assert.strictEqual(noOffer.state.activity, 'traveling', 'a buyer with no offer must return to farming instead of waiting in Giran');
    assert.strictEqual(noOffer.state.stats.travel.arrivalActivity, 'hunting');
    assert(noOffer.state.stats.marketRetryAfter > Date.now(), 'a buyer with no offer must wait before retrying the same market trip');

    MarketOpportunity.bestOffer = () => ({ selfId: 2, price: 1000, sourceType: 'cold_store', storeItem: { count: 1, price: 1000 } });
    MarketOpportunity.reserve = () => false;
    const changedOffer = await ColdMarketService.tryPurchase({
        ...state,
        characterId: 80,
        stats: { ...state.stats, marketReturn: { loc: { locX: 100, locY: 200, locZ: -10 }, regionName: 'Field', spotId: 'field' } },
        loc: { locX: 80000, locY: 150000, locZ: -3466 }
    }, { type: 'buy_craft_material', target: { itemId: 2, itemName: 'Changed Offer' } });
    assert.strictEqual(changedOffer.reason, 'offer_changed');
    assert.strictEqual(changedOffer.state.activity, 'traveling', 'a stale offer must return the buyer to farming');
    assert(changedOffer.state.stats.marketRetryAfter > Date.now(), 'a stale offer must also start the retry cooldown');

    const armorPurchase = await BotLifeState.applyMarketPurchase({
        ...state,
        characterId: 78,
        adena: 505000,
        inventory: {
            ...state.inventory,
            57: { selfId: 57, name: 'Adena', amount: 505000 },
            21: { selfId: 21, name: 'Shirt', amount: 1, equipped: true, slot: 10, rank: 'none', kind: 'Armor.Light' }
        },
        stats: {
            equipment: [
                { selfId: 1, slot: 7, rank: 'none', kind: 'Weapon.Sword' },
                { selfId: 21, slot: 10, rank: 'none', kind: 'Armor.Light' }
            ]
        }
    }, { selfId: 354, price: 505000, sourceType: 'npc' });
    assert.strictEqual(armorPurchase.inventory['1'].equipped, true, 'a chest purchase must keep the weapon equipped');
    assert.strictEqual(armorPurchase.inventory['21'].equipped, false);
    assert.strictEqual(armorPurchase.inventory['354'].equipped, true);
    assert(armorPurchase.stats.equipment.some((item) => item.selfId === 1 && item.slot === 7));
    assert(armorPurchase.stats.equipment.some((item) => item.selfId === 354 && item.slot === 10));
    assert(calls.some((call) => call.type === 'equip' && call.characterId === 78 && call.id === 12 && call.equipped === false));
    assert(calls.some((call) => call.type === 'insert' && call.characterId === 78 && call.item.selfId === 354 && call.item.equipped === true));

    console.log('Bot cold market purchase checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Database.execute = originals.execute;
    Database.fetchItems = originals.fetchItems;
    Database.updateItemAmount = originals.updateItemAmount;
    Database.updateItemEquipState = originals.updateItemEquipState;
    Database.setItem = originals.setItem;
    GoalState.clear = originals.clearGoal;
    World.user = originals.user;
    MarketOpportunity.bestOffer = originals.bestOffer;
    MarketOpportunity.reserve = originals.reserve;
});
