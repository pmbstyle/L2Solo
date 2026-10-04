const assert = require('assert');

require('../src/Global');

// A hunting trip starts from the route the coordinator chose (beginHuntingTrip)
// or from a spot main chose itself (PopulationService). For the same bot and
// destination both must write the same trip.

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
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
    current: GoalService.current,
    review: GoalService.review,
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

// The route the coordinator (routeFor) writes for a solo trip to newSpot.
function soloRoute(plan, backoff = null) {
    return {
        needed: true, mode: 'solo', currentSpotId: oldSpot.id, spotId: newSpot.id, regionName: newSpot.name,
        travelMs: 25000,
        reason: backoff ? 'death_pressure_replan' : plan?.status === 'active' ? 'equipment_source_replan' : 'level_replan',
        ...(backoff ? { cause: 'death_pressure', spotBackoff: backoff } : {}),
        to: { ...newSpot.center }, destinations: {}
    };
}

// Main starts its own trip when it resolves a bot without a worker result.
async function mainTrip(state) {
    const applied = [];
    LifeState.applyResolve = (value, result) => {
        applied.push(value);
        return Promise.resolve({ ...value, ...result.patch });
    };
    const result = await PopulationService.resolveColdState(state);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(applied[0].activity, 'traveling', 'fixture: main starts a trip');
    return applied[0];
}

async function soloChecks() {
    SpotProfiles.ensure = () => [oldSpot, newSpot];
    SpotProfiles.findForState = () => newSpot;
    SpotService.findCurrentSpot = (loc) => (loc?.locX === oldSpot.center.locX ? oldSpot : null);
    SpotService.arrivalPointForState = (state, spot) => ({ ...spot.center });
    GearPlanner.planFor = () => ({ status: 'complete', strategy: 'none', grade: 'none' });
    LifeState.cachedState = () => null;
    LifeState.upsertState = (value) => Promise.resolve(value);
    ListingService.reconcileInventory = (value) => Promise.resolve({ state: value, closed: false });
    ListingService.resolve = (lifecycle) => Promise.resolve({ state: lifecycle?.state || lifecycle, closed: false });
    MarketService.tryPurchase = (value) => Promise.resolve({ state: value, purchased: false });
    GoalService.current = () => Promise.resolve(null);
    GoalService.review = () => Promise.resolve(null);
    LifeEvents.recordMany = () => Promise.resolve(null);
    GlobalChat.maybeAnnounce = () => null;

    const plain = hunter(8101);
    const fromMain = await mainTrip(plain);
    const at = fromMain.stats.travel.startedAt;
    const fromKernel = beginHuntingTrip({ ...plain,
        stats: { ...plain.stats, equipmentPlan: fromMain.stats.equipmentPlan } }, soloRoute(fromMain.stats.equipmentPlan), at);
    assert.deepStrictEqual(fromMain.stats.travel, fromKernel.stats.travel, 'solo trips: one trip record');
    assert.deepStrictEqual(fromMain.timing, fromKernel.timing, 'solo trips: one arrival time');
    assert.strictEqual(fromMain.stats.pveEncounter, null);
    assert.strictEqual(fromKernel.stats.pveEncounter, null);

    // Deaths at the current spot: both record the retreat and its backoff.
    const pressured = hunter(8102, { deaths: 2, fightsResolved: 5,
        spotRisk: { spotId: oldSpot.id, deathsAtEntry: 0, fightsAtEntry: 0 } });
    const pressuredMain = await mainTrip(pressured);
    const pressuredAt = pressuredMain.stats.travel.startedAt;
    const backoff = SpotRiskPolicy.backoffForStates([pressured], oldSpot.id, pressuredAt);
    assert(backoff, 'fixture: the bot is under death pressure');
    const pressuredKernel = beginHuntingTrip({ ...pressured,
        stats: { ...pressured.stats, equipmentPlan: pressuredMain.stats.equipmentPlan } }, soloRoute(pressuredMain.stats.equipmentPlan, backoff), pressuredAt);
    assert.deepStrictEqual(pressuredMain.stats.travel, pressuredKernel.stats.travel, 'death-pressure trips: one record');
    assert.strictEqual(pressuredMain.stats.travel.cause, 'death_pressure');
    assert.deepStrictEqual(pressuredMain.stats.spotBackoffs, pressuredKernel.stats.spotBackoffs,
        'death-pressure trips: one backoff');
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
    for (const backoff of [null, { spotId: oldSpot.id, reason: 'death_pressure', startedAt: at, until: at + 3600000 }]) {
        const fromMain = PopulationService.beginPartySpotTravel(member, newSpot, at,
            { destination, ...(backoff ? { spotBackoff: backoff } : {}) });
        const fromKernel = beginHuntingTrip(member, partyRoute(backoff), at);
        assert.deepStrictEqual(fromMain, fromKernel, `party trips${backoff ? ' under pressure' : ''}: one state`);
        assert.deepStrictEqual(fromMain.stats.spotRisk, member.stats.spotRisk,
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
    await soloChecks();
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
    Object.assign(GoalService, { current: originals.current, review: originals.review });
    LifeEvents.recordMany = originals.recordMany;
    GlobalChat.maybeAnnounce = originals.globalAnnounce;
});
