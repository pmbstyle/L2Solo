const assert = require('assert');

require('../src/Global');

const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const state = {
    characterId: 7,
    name: 'Traveler',
    activity: 'hunting',
    currentRegion: 'Dion',
    loc: { locX: 15631, locY: 142885, locZ: -2704 },
    stats: {},
    vitals: { hp: 100, maxHp: 100, mp: 50, maxMp: 50 }
};
const goal = { type: 'upgrade_gear', plan: { expectedBenefit: 'market_search_for_weapon' } };
const started = GoalExecutor.beginMarketTravel(state, goal, Date.now());
assert.strictEqual(started.activity, 'traveling');
assert.strictEqual(started.stats.travel.townName, 'Giran');
assert.strictEqual(started.stats.travel.method, 'soe_gatekeeper');
assert(started.stats.travel.viaTown, 'market travel should first use SoE to the regional town');
assert.strictEqual(started.stats.travel.arrivalAt - started.stats.travel.startedAt, GoalExecutor.MARKET_TRAVEL_MS);
assert.strictEqual(started.timing.nextResolveAt, started.stats.travel.arrivalAt, 'travel must sleep until its arrival event');

const nativeMidway = {
    ...started,
    stats: {
        ...started.stats,
        travel: {
            ...started.stats.travel,
            startedAt: Date.now() - 1000,
            arrivalAt: Date.now() + 10000
        }
    }
};
const nativeTransit = BackgroundResolver.resolveSolo({ state: nativeMidway, spot: null, timestamp: nativeMidway.stats.travel.startedAt + 1 });
assert.deepStrictEqual(nativeTransit.patch.loc, state.loc, 'SoE/gatekeeper transit must not visibly interpolate across the map');
assert.strictEqual(nativeTransit.patch.activity, 'traveling', 'native transit must remain traveling until its short cast/transit completes');
assert.strictEqual(nativeTransit.nextResolveAt, nativeMidway.stats.travel.arrivalAt, 'in-flight travel must retain its exact arrival deadline');

const sellStarted = GoalExecutor.beginMarketTravel({ ...state, activity: 'hunting', stats: {} }, {
    type: 'sell_inventory',
    plan: { expectedBenefit: 'market_sale_inventory' }
}, Date.now());
assert.strictEqual(sellStarted.stats.travel.reason, 'market_sale_inventory');

const midway = BackgroundResolver.resolveSolo({ state: started, spot: null, elapsedMs: 30000 });
assert.strictEqual(midway.patch.activity, 'traveling');
assert.strictEqual(midway.materialize.exp, 0);

const legacyTravel = {
    ...started,
    stats: { ...started.stats, travel: { ...started.stats.travel, method: undefined, arrivalAt: Date.now() + 600000 } }
};
const migrated = BackgroundResolver.resolveSolo({ state: legacyTravel, spot: null });
assert.strictEqual(migrated.patch.activity, 'shopping', 'old long Giran market travel must complete through the fast route');

const arrivedState = { ...started, stats: { ...started.stats, travel: { ...started.stats.travel, arrivalAt: Date.now() - 1, startedAt: Date.now() - 1000 } } };
const arrived = BackgroundResolver.resolveSolo({ state: arrivedState, spot: null });
assert.strictEqual(arrived.patch.activity, 'shopping');
assert.strictEqual(arrived.events[0].type, 'arrived_town');
assert(arrived.nextResolveAt <= Date.now(), 'arrival must make the shopping event due without another polling delay');

const shoppingState = {
    ...arrivedState,
    activity: 'shopping',
    currentRegion: 'Giran',
    loc: { ...started.stats.travel.to },
    stats: { ...started.stats, travel: null }
};
const returning = GoalExecutor.finishMarketVisit(shoppingState, Date.now());
assert.strictEqual(returning.activity, 'traveling');
assert.strictEqual(returning.stats.travel.reason, 'return_after_market');
assert.strictEqual(returning.stats.travel.arrivalActivity, 'hunting');
assert.strictEqual(returning.stats.travel.method, 'gatekeeper_spot', 'returning from Giran must use the destination gatekeeper instead of walking across the world');
assert.strictEqual(returning.stats.travel.arrivalAt - returning.stats.travel.startedAt, GoalExecutor.GATEKEEPER_SPOT_TRAVEL_MS);
assert.strictEqual(returning.timing.nextResolveAt, returning.stats.travel.arrivalAt, 'return travel must sleep until its arrival event');

const ignoringRemoteLead = GoalExecutor.finishMarketVisit({
    ...shoppingState,
    stats: { ...shoppingState.stats, marketLead: { town: 'Oren', itemId: 354 } }
}, Date.now());
assert.strictEqual(ignoringRemoteLead.stats.travel.reason, 'return_after_market');

const returnedState = {
    ...returning,
    stats: {
        ...returning.stats,
        travel: { ...returning.stats.travel, arrivalAt: Date.now() - 1, startedAt: Date.now() - 1000 }
    }
};
const returned = BackgroundResolver.resolveSolo({ state: returnedState, spot: null });
assert.strictEqual(returned.patch.activity, 'hunting');
assert.strictEqual(returned.patch.currentRegion, 'Dion');
assert.strictEqual(returned.patch.stats.marketReturn, null);
assert.strictEqual(returned.events[0].type, 'returned_to_spot');

const originalFindById = SpotService.findById;
const originalArrivalPointForState = SpotService.arrivalPointForState;
const originalFindForState = SpotProfiles.findForState;
const legacyMineSpot = {
    id: '29_-30',
    name: 'Mithril Mines',
    center: { locX: 176673, locY: -177656, locZ: 801 }
};
const availableSpot = {
    id: '19_-19',
    name: 'Dwarven Village hunting grounds',
    center: { locX: 116000, locY: -180000, locZ: -900 }
};
try {
    SpotService.findById = (id) => id === legacyMineSpot.id ? legacyMineSpot : null;
    SpotProfiles.findForState = () => availableSpot;
    SpotService.arrivalPointForState = (bot, spot) => ({
        locX: spot.center.locX + 137,
        locY: spot.center.locY - 91,
        locZ: spot.center.locZ
    });
    const rerouted = GoalExecutor.finishMarketVisit({
        ...shoppingState,
        stats: {
            ...shoppingState.stats,
            marketReturn: {
                spotId: legacyMineSpot.id,
                regionName: 'Akaste Bone Soldier fields',
                loc: { ...legacyMineSpot.center }
            }
        }
    }, Date.now());
    assert.strictEqual(rerouted.stats.travel.spotId, availableSpot.id,
        'a market return must honor the current capacity-aware route instead of feeding an old overloaded spot');
    assert.strictEqual(rerouted.stats.travel.regionName, availableSpot.name);
    assert.deepStrictEqual(rerouted.stats.travel.to, {
        locX: availableSpot.center.locX + 137,
        locY: availableSpot.center.locY - 91,
        locZ: availableSpot.center.locZ
    }, 'market returns must use a distributed spawn-aware arrival point');
} finally {
    SpotService.findById = originalFindById;
    SpotService.arrivalPointForState = originalArrivalPointForState;
    SpotProfiles.findForState = originalFindForState;
}

const originalFindCurrentSpot = SpotService.findCurrentSpot;
const originalPartyArrivalPoint = SpotService.arrivalPointForState;
try {
    SpotService.findCurrentSpot = () => legacyMineSpot;
    SpotService.arrivalPointForState = () => ({ locX: 116137, locY: -180091, locZ: -900 });
    const partyTravel = PopulationService.beginPartySpotTravel({
        ...state,
        activity: 'grouped',
        spotId: legacyMineSpot.id,
        party: { partyId: 'party-route' }
    }, availableSpot, 1000);
    assert.strictEqual(partyTravel.activity, 'traveling');
    assert.strictEqual(partyTravel.stats.travel.reason, 'party_spot_replan');
    assert.strictEqual(partyTravel.stats.travel.arrivalActivity, 'grouped');
    assert.strictEqual(partyTravel.stats.travel.arrivalAt, 1000 + 25000);
    const partyArrived = PopulationService.finishPartySpotTravel(partyTravel, 26000);
    assert.strictEqual(partyArrived.activity, 'grouped');
    assert.strictEqual(partyArrived.spotId, availableSpot.id);
    assert.strictEqual(partyArrived.currentRegion, availableSpot.name);
    assert.deepStrictEqual(partyArrived.loc, { locX: 116137, locY: -180091, locZ: -900 });
    assert.strictEqual(partyArrived.stats.travel, null,
        'a background party arrival must clear its transition instead of remaining visually at the old spot');
    const interruptedMember = {
        ...state,
        activity: 'traveling',
        spotId: legacyMineSpot.id,
        stats: {
            ...(state.stats || {}),
            travel: { reason: 'market_visit', arrivalAt: 90000 }
        }
    };
    const alignedMember = PopulationService.finishPartySpotTravel(
        interruptedMember,
        26000,
        availableSpot,
        {
            reason: 'party_spot_replan',
            regionName: availableSpot.name,
            spotId: availableSpot.id,
            arrivalAt: 26000
        }
    );
    assert.strictEqual(alignedMember.activity, 'grouped',
        'a member that could not start party travel must still join the party at arrival');
    assert.strictEqual(alignedMember.spotId, availableSpot.id,
        'fallback party arrival must align the member with the party spot');
    assert.deepStrictEqual(alignedMember.loc, { locX: 116137, locY: -180091, locZ: -900 });
    assert.strictEqual(alignedMember.stats.travel, null,
        'fallback party arrival must clear the unrelated stale travel transition');
    const arrivedPartyRecord = PopulationService.finishPartyTravelRecord({
        partyId: 'party-route',
        nextResolveAt: 25000,
        stats: {
            lastResolveAt: 1000,
            travel: { reason: 'party_spot_replan', arrivalAt: 26000 }
        }
    }, 26000);
    assert.strictEqual(arrivedPartyRecord.stats.lastResolveAt, 26000,
        'party combat time must restart at arrival instead of including the travel interval');
    assert.strictEqual(arrivedPartyRecord.nextResolveAt, 27000);
    assert.strictEqual(arrivedPartyRecord.stats.travel, null);
} finally {
    SpotService.findCurrentSpot = originalFindCurrentSpot;
    SpotService.arrivalPointForState = originalPartyArrivalPoint;
}

const boundaryArrival = SpotService.arrivalPointForState({ characterId: 2 }, {
    id: '0_0',
    center: { locX: 1, locY: 1, locZ: 0 },
    arrivalPoints: [{ locX: 1, locY: 1, locZ: 0 }]
});
assert(boundaryArrival.locX >= 0 && boundaryArrival.locX < 6000,
    'spawn-aware arrival offsets must remain inside the destination X grid');
assert(boundaryArrival.locY >= 0 && boundaryArrival.locY < 6000,
    'spawn-aware arrival offsets must remain inside the destination Y grid');

console.log('Bot cold travel checks passed');
