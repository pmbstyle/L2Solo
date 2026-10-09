const assert = require('assert');
require('../src/Global');
const Executor = invoke('GameServer/Bot/Goals/GoalExecutor');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Towns = invoke('GameServer/World/TownRespawn');
// This test checks where the trip goes, not whether the purchase is worth it:
// the worth-the-trip gate (needs a board offer and the experience table) is
// covered by test_acquisition_trip_value.js, so the fixture lets it pass.
invoke('GameServer/Bot/Economy/ColdMarketService').canTravelForPurchase = () => true;
const state = { characterId: 7, name: 'Buyer', level: 40, phase: 'cold', activity: 'hunting',
    currentRegion: 'Field', loc: { locX: 80000, locY: 170000, locZ: -3500 }, stats: {}, timing: {},
    // Town trips are paid (N2): a Scroll of Escape and the gatekeeper fee.
    adena: 1000000, inventory: { 57: { selfId: 57, amount: 1000000 }, 736: { selfId: 736, amount: 1 } } };
const goal = town => ({ type: 'upgrade_gear', status: 'active', target: { itemId: 352 },
    plan: { expectedBenefit: 'market_search_for_gear', marketTown: town } });
for (const town of Object.values(Towns.towns)) {
    const travel = Executor.beginMarketTravel(state, goal(town.name), 1000);
    assert(travel, `${town.name} must have a purchase destination`);
    assert.strictEqual(travel.stats.travel.townName, town.name, 'purchase towns must never silently become Giran');
    const arrival = Resolver.resolveSolo({ state: travel, timestamp: 26000 });
    assert.strictEqual(arrival.patch.activity, 'shopping');
    assert.strictEqual(arrival.patch.currentRegion, town.name);
    // Durable cold positions use whole map units; the selected purchase
    // destination may be fractional (for example a position beside a stall).
    for (const axis of ['locX', 'locY', 'locZ']) {
        assert(Number.isInteger(arrival.patch.loc[axis]), `${town.name} arrival ${axis} is a native map unit`);
        assert(Math.abs(arrival.patch.loc[axis] - travel.stats.travel.to[axis]) <= 0.5,
            `${town.name} arrival ${axis} preserves its selected destination within one rounding step`);
    }
    assert.deepStrictEqual(travel.stats.marketReturn.loc, state.loc);
}
assert.strictEqual(Executor.beginMarketTravel(state, goal('Unknown town'), 1000), null);
console.log('All NPC market town destinations and cold arrivals preserve the requested town');
