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
    loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
    inventory: { 57: { selfId: 57, amount: 100000, stackable: true } },
    stats: { marketSellRetryAfter: now + 1800000 }, timing: {}
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
assert.equal(Executor.beginMarketTravel(state, goal('inventory_half_full'), now + 1800000)?.activity, 'traveling',
    'the half-full goal may start once the existing pause expires');
console.log('Empty sale trip: retained half-full goal respects pause; forced cleanup still works');
