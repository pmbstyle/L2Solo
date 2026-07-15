const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');

DataCache.init();

const originals = {
    execute: Database.execute,
    fetchItems: Database.fetchItems,
    updateItemAmount: Database.updateItemAmount,
    updateItemEquipState: Database.updateItemEquipState,
    setItem: Database.setItem,
    clearGoal: GoalState.clear,
    user: World.user
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
        { id: 11, selfId: 1, amount: 1, equipped: true, slot: 7 }
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
});
