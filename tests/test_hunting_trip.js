const assert = require('assert');

require('../src/Global');

// A hunting trip starts from the bot's route (BotRoute, beginHuntingTrip) only.

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const Kernel = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');

invoke('GameServer/DataCache').init();

const originals = {
    ensure: SpotProfiles.ensure,
    findForState: SpotProfiles.findForState,
    findCurrentSpot: SpotService.findCurrentSpot,
    arrivalPointForState: SpotService.arrivalPointForState,
    planFor: GearPlanner.planFor,
    cachedState: LifeState.cachedState,
    applyResolve: LifeState.applyResolve,
    upsertState: LifeState.upsertState,
    reconcileInventory: ListingService.reconcileInventory,
    resolveListing: ListingService.resolve,
    tryPurchase: MarketService.tryPurchase,
    goal: NeedsEvaluator.goal,
    needs: NeedsEvaluator.needs,
    recordMany: LifeEvents.recordMany,
    globalAnnounce: GlobalChat.maybeAnnounce
};

const oldSpot = { id: 'old_ground', name: 'Old Ground', center: { locX: 10, locY: 20, locZ: 30 } };
const newSpot = { id: 'new_ground', name: 'New Ground', center: { locX: 9000, locY: 9000, locZ: 30 } };

function hunter(characterId, stats = {}) {
    return {
        characterId, name: `Traveller${characterId}`, phase: 'cold', activity: 'hunting', level: 40, adena: 1000,
        spotId: oldSpot.id, currentRegion: oldSpot.name, loc: { ...oldSpot.center }, inventory: {},
        vitals: { hp: 1000, maxHp: 1000, mp: 600, maxMp: 600 },
        timing: { lastResolvedAt: Date.now() - 30000, nextResolveAt: Date.now() - 1 },
        stats: { pveEncounter: { key: 'old' }, ...stats }
    };
}

// The route BotRoute.record writes for a solo trip to newSpot.
function soloRoute(plan, backoff = null) {
    return {
        needed: true, mode: 'solo', currentSpotId: oldSpot.id, spotId: newSpot.id, regionName: newSpot.name,
        travelMs: 25000,
        reason: backoff ? 'death_pressure_replan' : plan?.status === 'active' ? 'equipment_source_replan' : 'level_replan',
        ...(backoff ? { cause: 'death_pressure', spotBackoff: backoff } : {}),
        to: { ...newSpot.center }, destinations: {}
    };
}

// Only the bot's route starts a hunting trip (BotRoute, beginHuntingTrip): main
// starts none of its own (its cold command hunts the worker's route).
function soloChecks() {
    const at = 1800000000000;
    const plain = hunter(8101);
    const trip = beginHuntingTrip(plain, soloRoute(null), at);
    assert.strictEqual(trip.activity, 'traveling');
    assert.strictEqual(trip.stats.travel.spotId, newSpot.id);
    assert.strictEqual(trip.stats.pveEncounter, null);

    // Deaths at the current spot: the trip records the retreat and its backoff.
    const pressured = hunter(8102, { deaths: 2, fightsResolved: 5,
        spotRisk: { spotId: oldSpot.id, deathsAtEntry: 0, fightsAtEntry: 0 } });
    const backoff = SpotRiskPolicy.backoffForStates([pressured], oldSpot.id, at);
    assert(backoff, 'fixture: the bot is under death pressure');
    const retreat = beginHuntingTrip(pressured, soloRoute(null, backoff), at);
    assert.strictEqual(retreat.stats.travel.cause, 'death_pressure');
    assert(retreat.stats.spotBackoffs.some(entry => entry.spotId === oldSpot.id), 'the retreat records its backoff');
}

function partyChecks() {
    const at = 1800000000000;
    const member = hunter(8201, { deaths: 2, fightsResolved: 5,
        spotRisk: { spotId: oldSpot.id, deathsAtEntry: 0, fightsAtEntry: 0 } });
    const destination = { locX: 9100, locY: 9050, locZ: 30 };
    const partyRoute = (backoff) => ({ needed: true, mode: 'party', currentSpotId: oldSpot.id, spotId: newSpot.id,
        regionName: newSpot.name, travelMs: 25000, reason: 'party_spot_replan',
        ...(backoff ? { cause: 'death_pressure', spotBackoff: backoff } : {}),
        to: destination, destinations: { [member.characterId]: destination } });
    for (const backoff of [null, { spotId: oldSpot.id, reason: 'death_pressure', startedAt: at, steps: 60 }]) {
        const fromKernel = beginHuntingTrip(member, partyRoute(backoff), at);
        assert.deepStrictEqual(fromKernel.stats.spotRisk, member.stats.spotRisk,
            'a party trip leaves the member\'s solo risk alone');
    }
}

// Party arrival (U12, not changed): a member with its own trip lands on the
// trip's point; a member without one is left where it stands.
function arrivalChecks() {
    const at = 1800000000000;
    const destination = { locX: 9100, locY: 9050, locZ: 30 };
    const route = { needed: true, mode: 'party', spotId: newSpot.id, regionName: newSpot.name, travelMs: 25000,
        to: destination, destinations: { 8301: destination } };
    const travelling = beginHuntingTrip(hunter(8301), route, at);
    const arrived = Kernel.finishPartyRouteTravelState(travelling, at + 25000);
    assert.deepStrictEqual(arrived.loc, destination);
    assert.strictEqual(arrived.activity, 'grouped');
    assert.strictEqual(arrived.spotId, newSpot.id);
    assert.strictEqual(Kernel.finishPartyRouteTravelState(hunter(8302), at + 25000), null,
        'a member without a trip has no arrival of its own');
}

async function run() {
    soloChecks();
    partyChecks();
    arrivalChecks();
    console.log('Hunting trip checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(SpotProfiles, { ensure: originals.ensure, findForState: originals.findForState });
    Object.assign(SpotService, { findCurrentSpot: originals.findCurrentSpot,
        arrivalPointForState: originals.arrivalPointForState });
    GearPlanner.planFor = originals.planFor;
    Object.assign(LifeState, { cachedState: originals.cachedState, applyResolve: originals.applyResolve,
        upsertState: originals.upsertState });
    Object.assign(ListingService, { reconcileInventory: originals.reconcileInventory, resolve: originals.resolveListing });
    MarketService.tryPurchase = originals.tryPurchase;
    Object.assign(NeedsEvaluator, { goal: originals.goal, needs: originals.needs });
    LifeEvents.recordMany = originals.recordMany;
    GlobalChat.maybeAnnounce = originals.globalAnnounce;
});
