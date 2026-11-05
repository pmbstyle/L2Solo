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
// The walk to the held earning answer (the wash's spot, decided when woken).
const washing = ColdKarmaPolicy.plan(bot({ stats: { karma: 100, woken: 0, earning: { spotId: 'wash' } } }), [{
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

// Appearance near a player: at the spot edge it runs to when the player is in
// reach of it, else at the teleport point it ran from; never on the line between
// them, and with neither in reach not at all.
const atEdge = PopulationService.walkerAppearance(walker, DRAGON_VALLEY);
assert.deepStrictEqual(atEdge.loc, NEAR_DRAGON_VALLEY, 'the spot edge it runs to, though the player stands at its start');
assert.strictEqual(atEdge.activity, 'hunting');
assert.strictEqual(atEdge.spotId, 'dv', 'it keeps its destination spot');
assert.strictEqual(atEdge.stats.travel, null);
const atStart = PopulationService.walkerAppearance(red, DION_FIELD);
assert.deepStrictEqual(atStart.loc, DION_FIELD, 'the spot edge out of reach: at the point it set out from');
assert.strictEqual(atStart.activity, 'hunting');
assert.strictEqual(atStart.stats.travel, null);
const roadMiddle = ColdTrip.positionAt(red, (red.stats.travel.run.startAt + red.stats.travel.run.endAt) / 2);
assert.strictEqual(PopulationService.walkerAppearance(red, roadMiddle), false, 'by the middle of a long road: no endpoint in reach');
assert.strictEqual(PopulationService.walkerAppearance(bot(), DION_FIELD), null, 'a hunter is no walker');

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
// point on the first attempt, within the activation budget, only where the
// player sees it; only the walker list is read. The ground is flat geodata.
(async () => {
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const SavedStats = require('../src/GameServer/Bot/SavedStats');
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const Geo = invoke('GameServer/Geodata/GeodataEngine');
    const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
    const Manager = invoke('GameServer/Bot/BotManager');
    const real = { near: LifeState.walkersNear, handoff: Owner.handoffToMain, spawn: Manager.loadAndSpawnBot,
        accept: Coordinator.acceptColdState, hasGeo: Geo.hasGeo, cell: Geo.getCellData, height: Geo.getHeight,
        sight: Geo.hasLineOfSight };
    try {
        Geo.hasGeo = () => true;
        Geo.getCellData = (x, y, z) => ({ nswe: 15, z: Number(z) });
        Geo.getHeight = (x, y, z) => Number(z);
        Geo.hasLineOfSight = () => true;
        Owner.handoffToMain = async () => ({ ok: true, revision: 2 });
        Coordinator.acceptColdState = async () => ({ ok: true });
        let spawned = [];
        Manager.loadAndSpawnBot = async (_account, data) => { spawned.push(data); return { actor: {} }; };
        // A walker in the cache whose trip began at `startedAt`, the only one on the walker list.
        const cachedWalker = (id, overrides, travel, startedAt) => {
            const trip = ColdTrip.toSpot(bot({ characterId: id, name: `Walker${id}`, accountName: `bot_walker_${id}`, ...overrides }),
                travel, startedAt);
            const walker = LifeState.acceptLifecycleRow({ ...trip, characterName: trip.name, ...trip.loc,
                ...SavedStats.statsColumns(trip.stats), inventorySummary: JSON.stringify(trip.inventory), simulationRevision: 1 });
            assert.strictEqual(walker.activity, 'traveling');
            assert.ok(walker.stats.travel.run, 'the cached row is a walker');
            LifeState.walkersNear = () => [LifeState.cachedState(id)];
            return walker;
        };
        const placedAt = (data) => ({ locX: data.locX, locY: data.locY, locZ: data.locZ });
        const aside = (loc) => ({ ...loc, locX: loc.locX + 1000 });
        const tripMs = ColdTrip.toSpot(bot(), spotTravel(NEAR_DRAGON_VALLEY), T).stats.travel.arrivalAt - T;

        // 1.5 s before the end of its run, the player by the spot edge.
        cachedWalker(4200, {}, spotTravel(NEAR_DRAGON_VALLEY), Date.now() - tripMs + 1500);
        const activated = await PopulationService.showWalkersNear(aside(NEAR_DRAGON_VALLEY), [], [], Date.now());
        assert.strictEqual(activated.length, 1, 'the walker is activated on the first attempt');
        assert.strictEqual(spawned.length, 1);
        const shown = spawned[0].coldLifeState;
        assert.deepStrictEqual(placedAt(spawned[0]), NEAR_DRAGON_VALLEY, 'it appears at the spot edge, not on the road');
        assert.strictEqual(shown.activity, 'hunting', 'the trip is over: it hunts at its destination');
        assert.strictEqual(shown.spotId, 'dv');
        assert.strictEqual(shown.stats.travel, null, 'no trip is left on the activated row');
        assert.strictEqual(spawned[0].backgroundActivity, 'hunting');

        // 45% of its run, the player by the teleport point it ran from: the spot edge is
        // in sight too, so it appears there; a detour keeps its stand-in pair.
        spawned = [];
        const runStartMs = TripPayment.SCROLL_CAST_MS + 2 * ColdTrip.HOP_MS;
        const shortRunMs = ColdTrip.runMs(DRAGON_VALLEY, NEAR_DRAGON_VALLEY);
        cachedWalker(4201, {}, { ...spotTravel(NEAR_DRAGON_VALLEY), leafSpotId: 'leaf' },
            Date.now() - runStartMs - Math.round(shortRunMs * 0.45));
        assert.strictEqual((await PopulationService.showWalkersNear(aside(DRAGON_VALLEY), [], [], Date.now())).length, 1);
        assert.deepStrictEqual(placedAt(spawned[0]), NEAR_DRAGON_VALLEY, 'the arrival in sight: it appears there');
        assert.strictEqual(spawned[0].coldLifeState.activity, 'hunting');
        assert.deepStrictEqual(spawned[0].coldLifeState.stats.standIn, { leaf: 'leaf', ground: 'dv' },
            'a detour walker stands in for its leaf, as on arrival');

        // A long walk on foot, 10% done, the player where it set out: the spot edge is
        // out of reach, so it appears at its start, still standing in for its leaf.
        spawned = [];
        const longMs = ColdTrip.runMs(DION_FIELD, NEAR_DRAGON_VALLEY);
        cachedWalker(4204, { stats: { karma: 100 } }, { ...spotTravel(NEAR_DRAGON_VALLEY), leafSpotId: 'leaf' },
            Date.now() - Math.round(longMs * 0.1));
        assert.strictEqual((await PopulationService.showWalkersNear(aside(DION_FIELD), [], [], Date.now())).length, 1);
        assert.deepStrictEqual(placedAt(spawned[0]), DION_FIELD, 'at the point it set out from');
        assert.deepStrictEqual(spawned[0].coldLifeState.stats.standIn, { leaf: 'leaf', ground: 'dv' });

        // The same long walk half done, the player by the middle of its road: within the
        // activation radius of the walker, both endpoints farther. It walks on cold.
        spawned = [];
        const far = cachedWalker(4202, { stats: { karma: 100 } }, spotTravel(NEAR_DRAGON_VALLEY), Date.now() - Math.round(longMs * 0.5));
        const road = ColdTrip.positionAt(far, Date.now());
        for (const end of [DION_FIELD, NEAR_DRAGON_VALLEY]) {
            assert.ok(Math.hypot(road.locX - end.locX, road.locY - end.locY) > Config.activationRadius);
        }
        assert.strictEqual((await PopulationService.showWalkersNear(road, [], [], Date.now())).length, 0,
            'an endpoint no player sees is not activated');
        const answer = await PopulationService.requestActivation(LifeState.cachedState(4202), 'near_player',
            { readyOnActivation: true, preferAnchor: true, playerLoc: road });
        assert.strictEqual(answer.reason, 'walker_endpoint_far');
        assert.strictEqual(spawned.length, 0);
        assert.strictEqual(LifeState.cachedState(4202).activity, 'traveling', 'it walks on cold');

        cachedWalker(4203, {}, spotTravel(NEAR_DRAGON_VALLEY), Date.now() - tripMs + 1500);
        const full = Array(Config.maxActivationsPerScan).fill({ ok: true });
        await PopulationService.showWalkersNear(aside(NEAR_DRAGON_VALLEY), [], full, Date.now());
        assert.strictEqual(spawned.length, 0, 'a full activation budget shows no walker');
    } finally {
        LifeState.walkersNear = real.near;
        Owner.handoffToMain = real.handoff;
        Manager.loadAndSpawnBot = real.spawn;
        Coordinator.acceptColdState = real.accept;
        Object.assign(Geo, { hasGeo: real.hasGeo, getCellData: real.cell, getHeight: real.height, hasLineOfSight: real.sight });
    }
    assert.ok(TravelRoutes.teleportPoints().length > 0);
    console.log('cold honest travel checks passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
