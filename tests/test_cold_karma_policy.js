const assert = require('assert');
require('../src/Global');
const Policy = invoke('GameServer/Bot/Population/ColdKarmaPolicy');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Goals = invoke('GameServer/Bot/Goals/GoalExecutor');
const Crafting = invoke('GameServer/Bot/Economy/ColdCraftingService');
const { lifecycleKind } = invoke('GameServer/Bot/Population/ColdSimulationKernel');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const originals = [Spots.arrivalPointForState, Spots.findCurrentSpot, Routes.bestSpot, utils.isInPeaceZone, Market.canTravelForPurchase];
const field = { npcEntries: [{ selfId: 251, level: 28 }, { selfId: 204, level: 23 }, { selfId: 68, level: 26 }], id: 'field', name: 'Field', minLevel: 20, maxLevel: 27, center: { locX: 12000, locY: 0, locZ: 0 } };
const town = { ...field, id: 'town', center: { locX: 0, locY: 0, locZ: 0 } };
const state = { characterId: 1, name: 'Chaotic', phase: 'cold', level: 27, activity: 'traveling',
    loc: { locX: 1000, locY: 0, locZ: 0 }, timing: {},
    stats: { karma: 45, equipmentPlan: { strategy: 'market' },
        travel: { to: town.center, arrivalAt: 1, arrivalActivity: 'shopping', method: 'soe_gatekeeper' } } };
// The earning spot decision while karma lasts takes the wash's choice (Policy.washSpot,
// woken by karma_changed); a karma step executes that held answer (Policy.plan).
const decided = (s, spots, at = Date.now()) => ({ ...s, stats: { ...s.stats, woken: 0,
    earning: { spotId: Policy.washSpot(s, spots, at)?.id ?? null, shots: true } } });
const wash = (s, spots, at) => Policy.plan(decided(s, spots, at), spots, at);
try {
    Spots.arrivalPointForState = (_state, spot) => spot.center;
    Spots.findCurrentSpot = loc => loc.locX === 12000 ? field : null;
    Routes.bestSpot = spots => spots.length ? { spot: spots[0] } : null;
    utils.isInPeaceZone = x => x === 0;
    // Karma is the subject here. Whether a shopping trip pays for itself has
    // its own fixture (test_acquisition_trip_value.js) and needs NPC offers.
    Market.canTravelForPurchase = () => true;
    const planned = wash(state, [town, field], 1000);
    const route = planned.plannedState.stats.travel;
    assert.strictEqual(route.spotId, 'field', 'town must be excluded from washing destinations');
    assert.strictEqual(route.method, 'walk', 'karma travel must not use SoE or gatekeepers');
    assert.strictEqual(route.arrivalActivity, 'hunting');
    assert(route.arrivalAt > 1000, 'relocation must take time');
    assert.strictEqual(planned.plannedState.stats.equipmentPlan, null);
    assert.strictEqual(lifecycleKind(state), 'resolver', 'karma must bypass economic command routing');
    const shoppingGoal = { type: 'upgrade_gear', plan: { expectedBenefit: 'market_search_for_weapon' } };
    // A white bot pays its town trip (N2): a Scroll of Escape and the gatekeeper fee.
    const hunting = { ...state, activity: 'hunting', adena: 1000000,
        inventory: { 57: { selfId: 57, amount: 1000000 }, 736: { selfId: 736, amount: 1 } } };
    assert.strictEqual(Goals.beginMarketTravel(hunting, shoppingGoal), null);
    assert(Goals.beginMarketTravel({ ...hunting, stats: { karma: 0 } }, shoppingGoal),
        'normal town shopping must resume after karma reaches zero');
    assert.strictEqual(Crafting.beginTravel(state), null);
    // Any karma above 0 closes towns and starts karma washing; none, zero or
    // negative karma does not.
    const whiteKind = lifecycleKind({ ...hunting, stats: { clanHallVisit: {} } });
    assert.strictEqual(whiteKind, 'command');
    for (const [karma, red] of [[undefined, false], [null, false], [0, false], [-5, false], ['0', false], [NaN, false], [1, true], ['7', true], [45, true]]) {
        const karmaState = { ...hunting, stats: { karma } };
        assert.strictEqual(!!Goals.beginMarketTravel(karmaState, shoppingGoal), !red, `market trip with karma ${karma}`);
        assert.strictEqual(Policy.active(karmaState), red, `karma washing with karma ${karma}`);
        assert.strictEqual(lifecycleKind({ ...hunting, stats: { clanHallVisit: {}, karma } }), red ? 'resolver' : whiteKind,
            `lifecycle with karma ${karma}`);
    }
    const blocked = Resolver.resolveSolo({ state, timestamp: 2000 });
    assert.strictEqual(blocked.debug.reason, 'karma_blocks_town', 'even an overdue saved town trip must be cancelled');
    assert.strictEqual(blocked.patch.loc, undefined, 'cancelling town travel must not teleport');
    const arrived = Resolver.resolveSolo({ state: planned.plannedState, timestamp: route.arrivalAt });
    assert.strictEqual(arrived.patch.activity, 'hunting');
    assert.deepStrictEqual(arrived.patch.loc, field.center);
    assert(arrived.events[0].summary.includes('on foot'));
    const hunter = wash({ ...planned.plannedState, ...arrived.patch }, [field], route.arrivalAt + 1);
    assert.strictEqual(hunter.plannedState.activity, 'hunting', 'arrival must not start another journey');
    assert.strictEqual(hunter.targetNpcId, 204, 'washing must prefer weaker mobs instead of random stronger neighbours');
    const alternate = { ...field, id: 'alternate', center: { locX: 24000, locY: 0, locZ: 0 } };
    const failed = { ...hunter.plannedState, stats: { ...hunter.plannedState.stats,
        spotRisk: { version: 2, spotId: field.id, windowFights: 12, windowWins: 0, windowDeaths: 0 } } };
    const rerouted = wash(failed, [field, alternate], 5000);
    assert.strictEqual(rerouted.plannedState.stats.travel.spotId, alternate.id,
        'karma washing must leave a nearby field after repeated fights without wins');
    const backoff = rerouted.plannedState.stats.spotBackoffs.find(entry => entry.spotId === field.id);
    assert.strictEqual(backoff.reason, 'low_win_rate');
    assert.strictEqual(backoff.untilStep - Risk.stepCount(rerouted.plannedState), Risk.BACKOFF_STEPS,
        'a first mark lives the bot\'s own steps');
    const enRoute = wash(rerouted.plannedState, [field, alternate], 6000);
    assert.deepStrictEqual(enRoute.plannedState.stats.travel, rerouted.plannedState.stats.travel,
        'an ongoing safe walk must keep its original arrival deadline');
    assert.strictEqual(enRoute.plannedState.stats.spotBackoffs[0].untilStep, backoff.untilStep,
        'planning during travel must not extend an existing backoff');
    const dying = { ...failed, stats: { ...failed.stats,
        spotRisk: { version: 2, spotId: field.id, windowFights: 5, windowWins: 0, windowDeaths: 2 } } };
    const deathRoute = wash(dying, [field, alternate], 5000);
    assert.strictEqual(deathRoute.plannedState.stats.travel.spotId, alternate.id);
    assert.strictEqual(deathRoute.plannedState.stats.spotBackoffs[0].reason, 'death_pressure');
    const noAlternative = wash(failed, [field], 5000);
    assert.strictEqual(noAlternative.spot, null);
    assert.strictEqual(noAlternative.plannedState.activity, 'resting',
        'lack of alternatives must not send a PK back to a failed field');
    const arrivalState = { ...rerouted.plannedState, activity: 'hunting', spotId: alternate.id,
        loc: alternate.center, stats: { ...rerouted.plannedState.stats, travel: null, spotRisk: null } };
    assert.strictEqual(wash(arrivalState, [field, alternate], 7000).spot.id, alternate.id,
        'persisted backoff must survive relocation and risk-window replacement');
    const returned = { ...arrivalState, spotId: field.id, loc: field.center };
    assert.strictEqual(wash(returned, [field, alternate], 7000).plannedState.stats.travel.spotId, alternate.id,
        'an active backoff must reject even a nearby field after its risk window was replaced');
    const unsafeTravel = { ...returned, activity: 'traveling', stats: { ...returned.stats,
        travel: { ...route, reason: 'karma_washing', spotId: field.id } } };
    assert.strictEqual(wash(unsafeTravel, [field, alternate], 7000).plannedState.stats.travel.spotId, alternate.id,
        'saved travel toward an excluded spot must be replanned');
    assert.strictEqual(wash({ ...state, stats: { karma: 0 } }, [field]), null, 'normal goals resume at zero karma');
    // The step reads the held answer, it does not search: a held spot the wash would
    // not pick is still walked to, and a decision still woken rests until its answer.
    const held = { ...returned, stats: { ...returned.stats, spotBackoffs: [], woken: 0, earning: { spotId: field.id } } };
    assert.strictEqual(Policy.plan({ ...held, loc: alternate.center, spotId: alternate.id }, [field, alternate], 7000)
        .plannedState.stats.travel.spotId, field.id, 'a karma step executes the held answer');
    // A party member decides no earning spot: its karma step still takes the wash's spot itself
    // (temporary until the party aggregate, situations step 8).
    const member = { ...held, loc: alternate.center, spotId: alternate.id, party: { partyId: 'p1' },
        stats: { ...held.stats, woken: undefined, earning: undefined } };
    assert.strictEqual(Policy.plan(member, [field, alternate], 7000).spot?.id, Policy.washSpot(member, [field, alternate], 7000)?.id,
        'a party member with karma washes on the wash\'s spot');
    const pending = { ...held, stats: { ...held.stats, woken: undefined, earning: undefined } };
    assert.strictEqual(Policy.plan(pending, [field, alternate], 7000).plannedState.activity, 'resting',
        'a karma step with its earning spot woken waits for the answer');
    const dead = wash({ ...state, activity: 'dead' }, [field]);
    assert.strictEqual(dead.plannedState.activity, 'dead', 'washing must not bypass death recovery');
    assert.strictEqual(dead.plannedState.stats.travel, null);
    assert.strictEqual(wash(state, []).plannedState.activity, 'resting', 'missing hunting ground must never fall back to town');
} finally {
    [Spots.arrivalPointForState, Spots.findCurrentSpot, Routes.bestSpot, utils.isInPeaceZone, Market.canTravelForPurchase] = originals;
}
console.log('Cold karma town exclusion and washing route checks passed');
