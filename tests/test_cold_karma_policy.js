const assert = require('assert');
require('../src/Global');
const Policy = invoke('GameServer/Bot/Population/ColdKarmaPolicy');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Goals = invoke('GameServer/Bot/Goals/GoalExecutor');
const Crafting = invoke('GameServer/Bot/Economy/ColdCraftingService');
const { lifecycleKind } = invoke('GameServer/Bot/Population/ColdSimulationKernel');
const originals = [Spots.arrivalPointForState, Spots.findCurrentSpot, Routes.bestSpot, utils.isInPeaceZone];
const field = { npcEntries: [{ selfId: 251, level: 28 }, { selfId: 204, level: 23 }, { selfId: 68, level: 26 }], id: 'field', name: 'Field', minLevel: 20, maxLevel: 27, center: { locX: 12000, locY: 0, locZ: 0 } };
const town = { ...field, id: 'town', center: { locX: 0, locY: 0, locZ: 0 } };
const state = { characterId: 1, name: 'Chaotic', phase: 'cold', level: 27, activity: 'traveling',
    loc: { locX: 1000, locY: 0, locZ: 0 }, timing: {},
    stats: { karma: 45, equipmentPlan: { strategy: 'market' },
        travel: { to: town.center, arrivalAt: 1, arrivalActivity: 'shopping', method: 'soe_gatekeeper' } } };
try {
    Spots.arrivalPointForState = (_state, spot) => spot.center;
    Spots.findCurrentSpot = loc => loc.locX === 12000 ? field : null;
    Routes.bestSpot = spots => spots.length ? { spot: spots[0] } : null;
    utils.isInPeaceZone = x => x === 0;
    const planned = Policy.plan(state, [town, field], 1000);
    const route = planned.plannedState.stats.travel;
    assert.strictEqual(route.spotId, 'field', 'town must be excluded from washing destinations');
    assert.strictEqual(route.method, 'walk', 'karma travel must not use SoE or gatekeepers');
    assert.strictEqual(route.arrivalActivity, 'hunting');
    assert(route.arrivalAt > 1000, 'relocation must take time');
    assert.strictEqual(planned.plannedState.stats.equipmentPlan, null);
    assert.strictEqual(lifecycleKind(state), 'resolver', 'karma must bypass economic command routing');
    const shoppingGoal = { type: 'upgrade_gear', plan: { expectedBenefit: 'market_search_for_weapon' } };
    const hunting = { ...state, activity: 'hunting' };
    assert.strictEqual(Goals.beginMarketTravel(hunting, shoppingGoal), null);
    assert(Goals.beginMarketTravel({ ...hunting, stats: { karma: 0 } }, shoppingGoal),
        'normal town shopping must resume after karma reaches zero');
    assert.strictEqual(Crafting.beginTravel(state), null);
    const blocked = Resolver.resolveSolo({ state, timestamp: 2000 });
    assert.strictEqual(blocked.debug.reason, 'karma_blocks_town', 'even an overdue saved town trip must be cancelled');
    assert.strictEqual(blocked.patch.loc, undefined, 'cancelling town travel must not teleport');
    const arrived = Resolver.resolveSolo({ state: planned.plannedState, timestamp: route.arrivalAt });
    assert.strictEqual(arrived.patch.activity, 'hunting');
    assert.deepStrictEqual(arrived.patch.loc, field.center);
    assert(arrived.events[0].summary.includes('on foot'));
    const hunter = Policy.plan({ ...planned.plannedState, ...arrived.patch }, [field], route.arrivalAt + 1);
    assert.strictEqual(hunter.plannedState.activity, 'hunting', 'arrival must not start another journey');
    assert.strictEqual(hunter.targetNpcId, 204, 'washing must prefer weaker mobs instead of random stronger neighbours');
    assert.strictEqual(Policy.plan({ ...state, stats: { karma: 0 } }, [field]), null, 'normal goals resume at zero karma');
    const dead = Policy.plan({ ...state, activity: 'dead' }, [field]);
    assert.strictEqual(dead.plannedState.activity, 'dead', 'washing must not bypass death recovery');
    assert.strictEqual(dead.plannedState.stats.travel, null);
    assert.strictEqual(Policy.plan(state, []).plannedState.activity, 'resting', 'missing hunting ground must never fall back to town');
} finally {
    [Spots.arrivalPointForState, Spots.findCurrentSpot, Routes.bestSpot, utils.isInPeaceZone] = originals;
}
console.log('Cold karma town exclusion and washing route checks passed');
