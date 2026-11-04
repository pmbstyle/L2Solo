const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

// Cold trip time (step 3.2, user 2026-10-04): scroll cast + 5 s per gatekeeper
// hop + the run at 120 units/s, the same for every bot; a solo bot running to
// its spot is a walker in a small list (LifeStateCache.walkers), nothing is
// computed while it travels, it appears near a player at the teleport point or
// the spot edge, and a trip is no "busy" reason (design 5.9).
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const TripPayment = invoke('GameServer/Bot/Travel/TripPayment');
const TravelRoutes = invoke('GameServer/Bot/Travel/TravelRoutes');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');
const ColdKarmaPolicy = invoke('GameServer/Bot/Population/ColdKarmaPolicy');
const LifeStateCache = require('../src/GameServer/Bot/Population/LifeStateCache');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const InteractionMemory = invoke('GameServer/Social/InteractionMemoryRuntime');

const T = 1_750_000_000_000;
const DION_FIELD = { locX: 22000, locY: 140000, locZ: -3000 };
const DION = TownRespawn.towns.dion_town;
const GIRAN = { locX: 83396, locY: 147904, locZ: -3404 };
const DRAGON_VALLEY = { locX: 122881, locY: 110792, locZ: -3722 };
const NEAR_DRAGON_VALLEY = { locX: DRAGON_VALLEY.locX + 500, locY: DRAGON_VALLEY.locY, locZ: DRAGON_VALLEY.locZ };

function bot(overrides = {}) {
    return {
        characterId: 4100, name: 'Runner', phase: 'cold', level: 40, activity: 'hunting', adena: 100000,
        currentRegion: 'Dion fields', spotId: 'home', loc: { ...DION_FIELD }, timing: {},
        inventory: { 57: { selfId: 57, amount: 100000 }, 736: { selfId: 736, amount: 2 } },
        stats: {}, ...overrides
    };
}
const spotTravel = (to) => ({ to: { ...to }, spotId: 'dv', regionName: 'Dragon Valley', arrivalActivity: 'hunting' });
const townTravel = { to: { ...GIRAN }, townName: 'Giran', arrivalActivity: 'shopping' };

// A town trip: the scroll cast, one hop Dion -> Giran, then the steps inside Giran.
let trip = ColdTrip.toTown(bot(), townTravel, T);
assert.strictEqual(trip.stats.travel.arrivalAt - T, TripPayment.SCROLL_CAST_MS + ColdTrip.HOP_MS
    + ColdTrip.runMs(TownRespawn.towns.giran_town, GIRAN));
assert.strictEqual(trip.stats.travel.run, undefined, 'a town trip has no walker part');
// Without a scroll: the run to Dion, then the hop.
trip = ColdTrip.toTown(bot({ inventory: { 57: { selfId: 57, amount: 100000 } } }), townTravel, T);
assert.strictEqual(trip.stats.travel.method, 'walk_gatekeeper');
assert.strictEqual(trip.stats.travel.arrivalAt - T, ColdTrip.runMs(DION_FIELD, DION) + ColdTrip.HOP_MS
    + ColdTrip.runMs(TownRespawn.towns.giran_town, GIRAN));

// A near spot: on foot from where the bot stands.
const near = { locX: DION_FIELD.locX + 2400, locY: DION_FIELD.locY, locZ: DION_FIELD.locZ };
trip = ColdTrip.toSpot(bot(), spotTravel(near), T);
assert.strictEqual(trip.stats.travel.method, 'walk');
assert.strictEqual(trip.stats.travel.arrivalAt - T, 20000, '2400 units at 120 units/s');
assert.deepStrictEqual(trip.stats.travel.run, { from: DION_FIELD, to: near, startAt: T, endAt: T + 20000 });

// A far spot: SoE to Dion, two hops to Dragon Valley (Dion -> Giran -> DV), then 500 units.
trip = ColdTrip.toSpot(bot(), spotTravel(NEAR_DRAGON_VALLEY), T);
const before = TripPayment.SCROLL_CAST_MS + 2 * ColdTrip.HOP_MS;
assert.strictEqual(trip.stats.travel.method, 'gatekeeper_spot');
assert.strictEqual(trip.stats.travel.arrivalAt - T, before + ColdTrip.runMs(DRAGON_VALLEY, NEAR_DRAGON_VALLEY));
assert.deepStrictEqual(trip.stats.travel.run.from, DRAGON_VALLEY, 'the run starts at the teleport point');
assert.strictEqual(trip.stats.travel.run.startAt, T + before);
assert.strictEqual(trip.stats.travel.run.endAt, trip.stats.travel.arrivalAt);
assert.strictEqual(ColdTrip.spotPlan(bot(), NEAR_DRAGON_VALLEY).durationMs, trip.stats.travel.arrivalAt - T);
assert.strictEqual(trip.inventory[736].amount, 2, 'a trip to a spot is free');

// The same for every bot: the trip depends on the places only.
const other = ColdTrip.toSpot(bot({ characterId: 4999, level: 70, stats: { persona: { traits: { caution: 1 } } } }),
    spotTravel(NEAR_DRAGON_VALLEY), T);
assert.strictEqual(other.stats.travel.arrivalAt, trip.stats.travel.arrivalAt, 'no trait changes the trip time');

// Karma: no teleport, the whole way on foot.
const red = ColdTrip.toSpot(bot({ stats: { karma: 100 } }), spotTravel(NEAR_DRAGON_VALLEY), T);
assert.strictEqual(red.stats.travel.method, 'walk');
assert.strictEqual(red.stats.travel.arrivalAt - T, ColdTrip.runMs(DION_FIELD, NEAR_DRAGON_VALLEY));
const washing = ColdKarmaPolicy.plan(bot({ stats: { karma: 100 } }), [{
    id: 'wash', name: 'Wash', minLevel: 35, maxLevel: 45, center: { locX: 40000, locY: 140000, locZ: -3000 },
    npcEntries: [{ selfId: 20001, level: 38 }]
}], T);
const wash = washing.plannedState.stats.travel;
assert.strictEqual(wash.method, 'walk');
assert.deepStrictEqual(wash.run.from, DION_FIELD, 'a karma washing walk is a walker from where it stands');
assert.strictEqual(wash.arrivalAt - T, ColdTrip.runMs(DION_FIELD, wash.to), 'and takes the honest walking time');

// A party travels as one: the shared time, no walker.
const partyRoute = { needed: true, mode: 'party', spotId: 'dv', regionName: 'Dragon Valley', travelMs: 61000,
    to: NEAR_DRAGON_VALLEY };
const member = beginHuntingTrip(bot({ party: { partyId: 'p' } }), partyRoute, T);
assert.strictEqual(member.stats.travel.arrivalAt - T, 61000);
assert.strictEqual(member.stats.travel.run, undefined);
const solo = beginHuntingTrip(bot(), { ...partyRoute, mode: 'solo' }, T);
assert.strictEqual(solo.stats.travel.arrivalAt, trip.stats.travel.arrivalAt, 'a solo route takes its honest time');

// Position at request time, never stored.
const walker = { ...trip, characterId: 4100 };
const run = walker.stats.travel.run;
assert.deepStrictEqual(ColdTrip.positionAt(walker, T + 1000), DION_FIELD, 'before the run: where it set out');
const middle = ColdTrip.positionAt(walker, (run.startAt + run.endAt) / 2);
assert.strictEqual(middle.locX, Math.round((DRAGON_VALLEY.locX + NEAR_DRAGON_VALLEY.locX) / 2));
assert.deepStrictEqual(ColdTrip.positionAt(walker, run.endAt + 1), walker.stats.travel.to);

// The walker list: only cold solo runs, kept on writes, read by walkersNear.
const cache = new LifeStateCache();
cache.set(4100, walker);
cache.set(4101, { ...member, characterId: 4101 });
cache.set(4102, { ...bot({ characterId: 4102 }) });
cache.set(4103, { ...ColdTrip.toSpot(bot({ characterId: 4103 }), spotTravel(near), T), characterId: 4103 });
assert.strictEqual(cache.walkers.size, 2, 'walkers: the two solo runs, not the party member or the hunter');
const at = (run.startAt + run.endAt) / 2;
assert.deepStrictEqual(cache.walkersNear(NEAR_DRAGON_VALLEY, 2000, at).map((state) => state.characterId), [4100]);
assert.deepStrictEqual(cache.walkersNear(DION_FIELD, 2000, at).map((state) => state.characterId), [],
    'the other walker\'s run is over by then');
assert.deepStrictEqual(cache.walkersNear(NEAR_DRAGON_VALLEY, 2000, run.startAt - 1), [], 'before its run a walker is not on the road');
cache.set(4100, { ...walker, activity: 'hunting', stats: { ...walker.stats, travel: null } });
assert.strictEqual(cache.walkers.size, 1, 'an arrival leaves the list');
cache.set(4103, { ...cache.get(4103), phase: 'hot' });
assert.strictEqual(cache.walkers.size, 0, 'a bot gone hot leaves the list');
// Nothing runs per tick: no timer in the trip builder or the list.
for (const file of ['src/GameServer/Bot/Population/ColdTrip.js', 'src/GameServer/Bot/Population/LifeStateCache.js']) {
    assert.ok(!/setInterval|setTimeout/.test(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')), `${file} has no timer`);
}

// Appearance near a player: at the teleport point early on the run, at the
// spot edge later; never on the line between them.
const early = PopulationService.walkerAppearance(walker, run.startAt + 100);
assert.deepStrictEqual(early.loc, DRAGON_VALLEY, 'early: at the teleport point');
assert.strictEqual(early.activity, 'hunting');
assert.strictEqual(early.spotId, 'dv', 'it keeps its destination spot');
assert.strictEqual(early.stats.travel, null);
const late = PopulationService.walkerAppearance(walker, run.endAt - 100);
assert.deepStrictEqual(late.loc, NEAR_DRAGON_VALLEY, 'late: at the spot edge it ran to');
assert.strictEqual(late.activity, 'hunting');
assert.strictEqual(late.stats.travel, null);
assert.strictEqual(PopulationService.walkerAppearance(bot(), T), null, 'a hunter is no walker');

// A traveller is not busy: it answers an invite from where it is now.
const realAssess = InteractionMemory.assess;
const realPeek = BotSocialMemory.peekSnapshot;
const realGet = BotSocialMemory.getSnapshot;
InteractionMemory.assess = () => ({ ready: true, personal: null });
BotSocialMemory.peekSnapshot = BotSocialMemory.getSnapshot = () => ({ trust: 0, familiarity: 0, recentlyAbandonedAt: null });
try {
    const player = { actor: { fetchId: () => 1, fetchLevel: () => 40, fetchClanId: () => 0, isDead: () => false,
        fetchLocX: () => NEAR_DRAGON_VALLEY.locX, fetchLocY: () => NEAR_DRAGON_VALLEY.locY, fetchLocZ: () => NEAR_DRAGON_VALLEY.locZ } };
    const social = { ...walker, persona: { primaryDrive: 'social', traits: { sociability: 0.8, empathy: 0.8, commitment: 0.7 } } };
    const answer = BotAvailability.evaluateState(player, social, { loadMemory: false, timestamp: at });
    assert.notStrictEqual(answer.reason, 'in_transit', 'a trip is no busy reason');
    assert.strictEqual(answer.available, true, 'a sociable walker accepts the party');
    assert.ok(answer.distance < 300, `the distance is from its place on the road: ${answer.distance}`);
} finally {
    InteractionMemory.assess = realAssess;
    BotSocialMemory.peekSnapshot = realPeek;
    BotSocialMemory.getSnapshot = realGet;
}

// A walker near a player is activated through HotActivation at its appearance
// point on the first attempt, within the activation budget; only the walker
// list is read.
(async () => {
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const SavedStats = require('../src/GameServer/Bot/SavedStats');
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const Placement = invoke('GameServer/Bot/Population/ActivationPlacement');
    const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
    const Manager = invoke('GameServer/Bot/BotManager');
    const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
    const real = { near: LifeState.walkersNear, resolve: Placement.resolve, handoff: Owner.handoffToMain,
        spawn: Manager.loadAndSpawnBot, accept: Coordinator.acceptColdState, diagnostics: Config.developerDiagnostics };
    try {
        // Now is 1.5 s before the end of its run: past half, so it shows at the spot edge.
        const now = Date.now();
        const planned = ColdTrip.toSpot(bot({ characterId: 4200 }), spotTravel(NEAR_DRAGON_VALLEY), T);
        const startedAt = now - (planned.stats.travel.arrivalAt - T) + 1500;
        const trip = ColdTrip.toSpot(bot({ characterId: 4200, name: 'Walker', accountName: 'bot_walker_4200' }),
            spotTravel(NEAR_DRAGON_VALLEY), startedAt);
        const walker = LifeState.acceptLifecycleRow({ ...trip, characterName: trip.name, ...trip.loc,
            ...SavedStats.statsColumns(trip.stats), inventorySummary: JSON.stringify(trip.inventory), simulationRevision: 1 });
        assert.strictEqual(walker.activity, 'traveling');
        assert.ok(walker.stats.travel.run, 'the cached row is a walker');
        const run = walker.stats.travel.run;
        LifeState.walkersNear = (loc, radius, at) => (at >= run.startAt && at <= run.endAt
            ? [LifeState.cachedState(walker.characterId)] : []);
        const placed = [], spawned = [];
        let restored = 0;
        Placement.resolve = (state) => {
            placed.push(state);
            return { loc: { ...state.loc }, spot: { id: state.spotId, name: 'Dragon Valley', center: { ...state.loc } } };
        };
        Owner.handoffToMain = async () => ({ ok: true, revision: 2 });
        Manager.loadAndSpawnBot = async (_account, data) => { spawned.push(data); return { actor: {} }; };
        Coordinator.acceptColdState = async () => { restored++; return { ok: true }; };
        Config.developerDiagnostics = true;
        const refusals = Metrics.counters.activationRefusals;

        const activated = await PopulationService.showWalkersNear(NEAR_DRAGON_VALLEY, [], [], Date.now());
        assert.strictEqual(activated.length, 1, 'the walker is activated on the first attempt');
        assert.strictEqual(spawned.length, 1);
        assert.strictEqual(Metrics.counters.activationRefusals, refusals, 'no refusal');
        assert.strictEqual(restored, 0, 'nothing is handed back to the worker');
        const shown = spawned[0].coldLifeState;
        assert.deepStrictEqual(shown.loc, NEAR_DRAGON_VALLEY, 'it appears at the spot edge, not on the road');
        assert.deepStrictEqual({ locX: spawned[0].locX, locY: spawned[0].locY, locZ: spawned[0].locZ }, NEAR_DRAGON_VALLEY);
        assert.ok(placed.every(state => state.activity !== 'traveling'), 'placement reads the appearance, not the trip');
        assert.strictEqual(shown.activity, 'hunting', 'the trip is over: it hunts at its destination');
        assert.strictEqual(shown.spotId, 'dv');
        assert.strictEqual(shown.stats.travel, null, 'no trip is left on the activated row');
        assert.strictEqual(spawned[0].backgroundActivity, 'hunting');

        const full = Array(Config.maxActivationsPerScan).fill({ ok: true });
        await PopulationService.showWalkersNear(NEAR_DRAGON_VALLEY, [], full, Date.now());
        assert.strictEqual(spawned.length, 1, 'a full activation budget shows no walker');
    } finally {
        LifeState.walkersNear = real.near;
        Placement.resolve = real.resolve;
        Owner.handoffToMain = real.handoff;
        Manager.loadAndSpawnBot = real.spawn;
        Coordinator.acceptColdState = real.accept;
        Config.developerDiagnostics = real.diagnostics;
    }
    assert.ok(TravelRoutes.teleportPoints().length > 0);
    console.log('cold honest travel checks passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
