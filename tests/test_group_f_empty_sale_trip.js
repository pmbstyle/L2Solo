const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Executor = invoke('GameServer/Bot/Goals/GoalExecutor');
DataCache.init();
const now = 1791200000000;
const state = {
    characterId: 910061, name: 'HalfFullTrip', classId: 0, level: 25,
    phase: 'cold', activity: 'hunting', adena: 100000,
    // In the field: a bot standing in Giran already would sell there with no trip.
    loc: { locX: 60000, locY: 140000, locZ: -3400 }, currentRegion: 'Giran',
    inventory: { 57: { selfId: 57, amount: 100000, stackable: true },
        1864: { selfId: 1864, amount: 10, kind: 'Other.Material', stackable: true } },
    // The sale retry: the last visit could not place these stems, nothing new came since.
    stats: { marketSellSeen: { items: [1864], buyers: null } }, timing: {}
};
const goal = (reason, place = 'target') => ({ type: 'sell_inventory',
    target: place === 'target' ? { cleanupReason: reason } : {},
    plan: { marketTown: 'Giran', kind: 'market_sell', expectedBenefit: 'market_sale_inventory',
        ...(place === 'plan' ? { cleanupReason: reason } : {}) } });
for (const place of ['target', 'plan']) {
    assert.equal(Executor.beginMarketTravel(state, goal('inventory_half_full', place), now), null,
        `D10: retained half-full ${place} goal obeys the pause after an empty trip`);
}
assert.equal(Executor.beginMarketTravel(state, goal(undefined), now), null, 'ordinary sales also obey the pause');
for (const reason of ['inventory_capacity', 'npc_only_inventory', 'market_surplus_inventory']) {
    assert.equal(Executor.beginMarketTravel(state, goal(reason), now)?.activity, 'traveling',
        `${reason} retains the forced cleanup exception`);
}
assert.equal(Executor.beginMarketTravel(state, goal('inventory_half_full'), now + 6 * 3600000), null,
    'time alone does not end the pause');
const looted = { ...state, inventory: { ...state.inventory, 1865: { selfId: 1865, amount: 3, kind: 'Other.Material', stackable: true } } };
assert.equal(Executor.beginMarketTravel(looted, goal('inventory_half_full'), now)?.activity, 'traveling',
    'the half-full goal may start once goods the last visit did not try arrive');
// A new buyer of the goods the last visit could not place ends the pause; a
// buyer leaving does not. The board's buyers are read as [best bid, units].
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const buyerSeen = { ...state, stats: { marketSellSeen: { items: [1864], buyers: [[0, 0]] } } };
assert.equal(Executor.beginMarketTravel(buyerSeen, goal(undefined), now), null, 'no buyer came: the pause holds');
AfkTrade.refreshRecord({ id: 991061, ownerId: 991062, ownerName: 'StemBuyer', ownerAccount: 'bot_991062', kind: 'buy_ad',
    storeType: AfkTrade.BUY, status: 'active', town: 'Giran', title: '', revision: 1, expiresAt: 0, locX: 0, locY: 0, locZ: 0,
    appearance: {}, lines: [{ id: 9910611, selfId: 1864, name: 'Stem', count: 10, price: 900, enchant: 0 }] });
assert.equal(Executor.beginMarketTravel(buyerSeen, goal(undefined), now)?.activity, 'traveling',
    'a new bid for the unsold stems ends the pause at once');
const afterBid = { ...state, stats: { marketSellSeen: { items: [1864], buyers: [[900, 10]] } } };
assert.equal(Executor.beginMarketTravel(afterBid, goal(undefined), now), null, 'a bid already tried keeps the pause');
console.log('Empty sale trip: retained half-full goal respects pause; forced cleanup still works');
