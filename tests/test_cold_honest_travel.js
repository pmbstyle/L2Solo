const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

// Cold trip time (our choice): scroll cast + 5 s per gatekeeper
// hop + the run at 120 units/s, the same for every bot; a solo bot running to
// its spot is a walker in a small list (LifeStateCache.walkers), nothing is
// computed while it travels, it appears near a player on its road and walks the
// rest of it as a hot body, and a trip is no "busy" reason.
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

// A walker near a player is activated through HotActivation where the cold model
// has it, on its road (never at an endpoint it has not reached), on the first
// attempt, within the activation budget; it walks the rest of its run to its spot
// as a hot body and stands on no spot until it arrives. Only the walker list is
// read. The ground is flat geodata.
(async () => {
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const SavedStats = require('../src/GameServer/Bot/SavedStats');
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const Geo = invoke('GameServer/Geodata/GeodataEngine');
    const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
    const Manager = invoke('GameServer/Bot/BotManager');
    const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
    const ActorQueries = require('../src/GameServer/World/ActorSpatialQueries');
    const real = { near: LifeState.walkersNear, byId: ActorQueries.byId, handoff: Owner.handoffToMain, spawn: Manager.loadAndSpawnBot,
        accept: Coordinator.acceptColdState, upsert: LifeState.upsertState, hasGeo: Geo.hasGeo, cell: Geo.getCellData, height: Geo.getHeight,
        walk: Geo.canWalkStraight };
    try {
        Geo.hasGeo = () => true;
        Geo.getCellData = (x, y, z) => ({ nswe: 15, z: Number(z) });
        Geo.getHeight = (x, y, z) => Number(z);
        Geo.canWalkStraight = () => true;
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
        const gap = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
        const aside = (loc) => ({ ...loc, locX: loc.locX + 1000 });
        const tripMs = ColdTrip.toSpot(bot(), spotTravel(NEAR_DRAGON_VALLEY), T).stats.travel.arrivalAt - T;

        // 1.5 s before the end of its run, the player by the spot edge: it appears on the
        // last stretch of its road and walks the rest to its spot.
        cachedWalker(4200, {}, spotTravel(NEAR_DRAGON_VALLEY), Date.now() - tripMs + 1500);
        const lastStretch = ColdTrip.positionAt(LifeState.cachedState(4200), Date.now());
        const activated = await PopulationService.showWalkersNear(aside(NEAR_DRAGON_VALLEY), [], [], Date.now());
        assert.strictEqual(activated.length, 1, 'the walker is activated on the first attempt');
        assert.strictEqual(spawned.length, 1);
        const shown = spawned[0].coldLifeState;
        assert.ok(gap(placedAt(spawned[0]), lastStretch) <= 300, 'it appears by its place on the road');
        assert.deepStrictEqual([spawned[0].walkTo.spotId, spawned[0].walkTo.destination], ['dv', NEAR_DRAGON_VALLEY],
            'the body walks the rest of its run to its spot');
        assert.strictEqual(spawned[0].currentSpot, null, 'it stands on no spot until its walk ends there');
        assert.strictEqual(shown.activity, 'hunting', 'the cold trip is over: the hot walk carries it');
        assert.strictEqual(shown.spotId, 'dv', 'it holds the spot it walks to');
        assert.strictEqual(shown.stats.travel, null, 'no trip is left on the activated row');
        assert.strictEqual(spawned[0].backgroundActivity, 'hunting');

        // Its body cools before the walk ends (a spawn failing after the handoff rolls the
        // body back; a cooldown): a walker again, the rest of its run on foot from where its
        // body stands, its arrival at its spot as its trip said, never a hunter on the road.
        const body = spawned[0];
        const stands = placedAt(body);
        let cooled = null;
        LifeState.upsertState = async (next) => (cooled = next);
        const cooledAt = Date.now();
        await LifeState.writeColdRow({ accountId: 'bot_walker_4200', plan: 'hunting', coldLifeState: body.coldLifeState,
            populationLocationPolicy: body.populationLocationPolicy,
            // The hot walk as BotManager starts it from walkTo.
            spotRelocation: { mode: 'walk', method: 'walk', spotId: body.walkTo.spotId,
                destination: body.walkTo.destination, coldTrip: body.walkTo.trip },
            actor: { fetchId: () => 4200, fetchName: () => 'Walker4200', fetchLevel: () => 40, fetchExp: () => 0,
                fetchSp: () => 0, fetchClassId: () => 0, fetchClanId: () => 0, fetchRace: () => 0, fetchKarma: () => 0,
                fetchLocX: () => stands.locX, fetchLocY: () => stands.locY, fetchLocZ: () => stands.locZ,
                fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 50, fetchMaxMp: () => 50,
                backpack: { fetchItems: () => [] } } }, 'hot_spawn_rollback');
        LifeState.upsertState = real.upsert;
        assert.strictEqual(cooled.phase, 'cold');
        assert.strictEqual(cooled.activity, 'traveling', 'it walks on cold');
        const rest = cooled.stats.travel;
        assert.deepStrictEqual([rest.run.from, rest.from, rest.run.to], [stands, stands, NEAR_DRAGON_VALLEY],
            'from where its body stands to the end of its run');
        assert.ok(rest.startedAt >= cooledAt && rest.arrivalAt - rest.startedAt === Math.max(1000, ColdTrip.runMs(stands, NEAR_DRAGON_VALLEY)),
            'the rest of the run on foot');
        assert.deepStrictEqual([rest.method, rest.spotId, rest.arrivalEvent, rest.arrivalActivity],
            ['walk', 'dv', 'arrived_hunting_ground', 'hunting'], 'it arrives at its spot as its trip said');
        assert.strictEqual(cooled.timing.nextResolveAt, rest.arrivalAt, 'its arrival is its next cold step');
        const list = new LifeStateCache();
        list.set(4200, cooled);
        assert.strictEqual(list.walkers.size, 1, 'on the walker list: a player near its road sees it again');

        // Its body, landed, read a Scroll of Escape to Heine for its held purchase and cools
        // there: it does that visit cold in Heine and comes back to where it set out, never
        // a bot in town on no spot that rests and comes back through the gatekeeper with
        // its visit undone.
        const heine = TownRespawn.towns.innadril_town;
        const inHeine = { locX: heine.locX, locY: heine.locY, locZ: heine.locZ };
        const coolInHeine = async (extra) => {
            LifeState.upsertState = async (next) => (cooled = next);
            await LifeState.writeColdRow({ accountId: 'bot_walker_4200', coldLifeState: body.coldLifeState,
                populationLocationPolicy: body.populationLocationPolicy, ...extra,
                actor: { fetchId: () => 4200, fetchName: () => 'Walker4200', fetchLevel: () => 40, fetchExp: () => 0,
                    fetchSp: () => 0, fetchClassId: () => 0, fetchClanId: () => 0, fetchRace: () => 0, fetchKarma: () => 0,
                    fetchLocX: () => inHeine.locX, fetchLocY: () => inHeine.locY, fetchLocZ: () => inHeine.locZ,
                    fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 50, fetchMaxMp: () => 50,
                    backpack: { fetchItems: () => [] } } }, 'policy');
            LifeState.upsertState = real.upsert;
            return cooled;
        };
        let inTown = await coolInHeine({ plan: 'shopping', preShopLocation: stands });
        assert.deepStrictEqual([inTown.activity, inTown.currentRegion, inTown.stats.townVisit?.town], ['shopping', 'Heine', 'Heine'],
            'it does its visit in Heine');
        assert.deepStrictEqual([inTown.stats.marketReturn?.loc, inTown.stats.marketReturn?.spotId], [stands, 'dv'],
            'and goes back to where it set out, its spot');
        assert.ok(inTown.timing.nextResolveAt <= Date.now(), 'its visit is due now');
        // Done in town and on its way out through the gatekeeper to its spot when it cools:
        // it goes on there cold from where it stands.
        inTown = await coolInHeine({ plan: 'hunting', spotRelocation: { method: 'town_gatekeeper', spotId: 'dv',
            destination: { ...NEAR_DRAGON_VALLEY }, startedAt: Date.now() } });
        assert.strictEqual(inTown.activity, 'traveling', 'it travels on to its spot');
        assert.deepStrictEqual([inTown.stats.travel.from, inTown.stats.travel.to, inTown.stats.travel.spotId,
            inTown.stats.travel.arrivalEvent], [inHeine, NEAR_DRAGON_VALLEY, 'dv', 'arrived_hunting_ground'],
            'from Heine to its spot, its arrival there as a trip\'s');

        // A long walk (karma: on foot all the way from where it set out). Two walkers of one
        // start at different progress, the player by each: each appears on its own stretch of
        // the road, never both at the start or the end.
        const longMs = ColdTrip.runMs(DION_FIELD, NEAR_DRAGON_VALLEY);
        const shownAt = [];
        for (const [id, share] of [[4204, 0.1], [4205, 0.3]]) {
            spawned = [];
            const walker = cachedWalker(id, { stats: { karma: 100 } }, spotTravel(NEAR_DRAGON_VALLEY),
                Date.now() - Math.round(longMs * share));
            const road = ColdTrip.positionAt(walker, Date.now());
            assert.strictEqual((await PopulationService.showWalkersNear(aside(road), [], [], Date.now())).length, 1);
            assert.ok(gap(placedAt(spawned[0]), road) <= 300, `walker ${id} appears on its road`);
            for (const end of [DION_FIELD, NEAR_DRAGON_VALLEY]) assert.ok(gap(placedAt(spawned[0]), end) > Config.activationRadius);
            assert.strictEqual(spawned[0].walkTo.spotId, 'dv');
            shownAt.push(placedAt(spawned[0]));
        }
        assert.ok(gap(shownAt[0], shownAt[1]) > 10000, 'two walkers of one start are not stacked on one point');

        // Its road point in rock (a straight line across a cliff): it is placed on the first
        // ground stepped back toward where its run began, and the step back is counted.
        spawned = [];
        const rock = cachedWalker(4202, { stats: { karma: 100 } }, spotTravel(NEAR_DRAGON_VALLEY), Date.now() - Math.round(longMs * 0.5));
        const road = ColdTrip.positionAt(rock, Date.now());
        Geo.getCellData = (x, y, z) => ({ nswe: Math.abs(x - road.locX) < 2000 ? 0 : 15, z: Number(z) });
        const stepBacks = Metrics.counters.walkerRoadStepBacks;
        assert.strictEqual((await PopulationService.showWalkersNear(road, [], [], Date.now())).length, 1);
        const placed = placedAt(spawned[0]);
        assert.ok(gap(placed, road) >= 2000 && gap(placed, road) <= Config.activationRadius, 'on ground, still near the player');
        assert.ok(gap(placed, DION_FIELD) < gap(road, DION_FIELD), 'stepped back toward where it set out');
        assert.strictEqual(Metrics.counters.walkerRoadStepBacks, stepBacks + 1);

        // Its road point on ground with no room around it (walls on both sides): stepped back
        // the same way, never refused on the spot.
        spawned = [];
        const midway = (id) => ColdTrip.positionAt(cachedWalker(id, { stats: { karma: 100 } }, spotTravel(NEAR_DRAGON_VALLEY),
            Date.now() - Math.round(longMs * 0.5)), Date.now());
        const cramped = midway(4207);
        Geo.getCellData = (x, y, z) => ({ nswe: x !== cramped.locX && Math.abs(x - cramped.locX) < 2000 ? 0 : 15, z: Number(z) });
        assert.strictEqual((await PopulationService.showWalkersNear(cramped, [], [], Date.now())).length, 1,
            'a walker on a cramped road point is shown');
        assert.ok(gap(placedAt(spawned[0]), cramped) >= 2000, 'on the first roomy ground stepped back');
        assert.strictEqual(Metrics.counters.walkerRoadStepBacks, stepBacks + 2);

        // The ground 3000 above its straight line (a hill the line runs through): never shown
        // on the hilltop, but on the ground stepped back, within 500 of its line's height.
        spawned = [];
        const line = midway(4208);
        const hill = (x, y) => Math.hypot(x - line.locX, y - line.locY) < 3000;
        Geo.getCellData = (x, y, z) => ({ nswe: 15, z: hill(x, y) ? line.locZ + 3000 : Number(z) });
        Geo.getHeight = (x, y, z) => hill(x, y) ? line.locZ + 3000 : Number(z);
        assert.strictEqual((await PopulationService.showWalkersNear(aside(line), [], [], Date.now())).length, 1);
        assert.ok(Math.abs(placedAt(spawned[0]).locZ - line.locZ) <= 500, 'not on the hilltop');
        assert.strictEqual(Metrics.counters.walkerRoadStepBacks, stepBacks + 3);
        Geo.getCellData = (x, y, z) => ({ nswe: 15, z: Number(z) });
        Geo.getHeight = (x, y, z) => Number(z);

        // Just landed by a gatekeeper teleport, its run beginning at the landing, a player
        // standing there: it is shown at the landing beside him, as C4 shows a teleport arrival.
        spawned = [];
        const gatekeeperTrip = ColdTrip.toSpot(bot(), spotTravel(NEAR_DRAGON_VALLEY), T).stats.travel;
        assert.strictEqual(gatekeeperTrip.method, 'gatekeeper_spot');
        const landed = cachedWalker(4206, {}, spotTravel(NEAR_DRAGON_VALLEY),
            Date.now() - (gatekeeperTrip.run.startAt - T) - 500);
        const landingPoint = ColdTrip.positionAt(landed, Date.now());
        assert.ok(gap(landingPoint, landed.stats.travel.run.from) < 100, 'it stands by its landing');
        assert.strictEqual((await PopulationService.showWalkersNear(landingPoint, [], [], Date.now())).length, 1,
            'a teleport arrival is shown though the player stands on its landing');
        assert.ok(gap(placedAt(spawned[0]), landingPoint) <= 300, 'at its landing');
        // A settled player's scan (countInView): such a landing in his view is not late, C4 shows
        // a teleport arrival as it appears; a walker shown in his view on a road that began
        // outside it is late, counted as a walker.
        const late = () => [Metrics.counters.lateInViewActivations, Metrics.counters.lateInViewWalkers];
        ActorQueries.byId = (_world, id) => {
            const body = spawned.find(data => data.coldLifeState.characterId === Number(id));
            return body ? { actor: { fetchLocX: () => body.locX, fetchLocY: () => body.locY } } : null;
        };
        const lateBefore = late();
        spawned = [];
        cachedWalker(4211, {}, spotTravel(NEAR_DRAGON_VALLEY), Date.now() - (gatekeeperTrip.run.startAt - T) - 500);
        assert.strictEqual((await PopulationService.showWalkersNear(landingPoint, [], [], Date.now(), true)).length, 1);
        assert.deepStrictEqual(late(), lateBefore, 'a landing in the player\'s view is not late');
        spawned = [];
        const fromAfar = ColdTrip.positionAt(cachedWalker(4212, { stats: { karma: 100 } }, spotTravel(NEAR_DRAGON_VALLEY),
            Date.now() - Math.round(longMs * 0.5)), Date.now());
        assert.strictEqual((await PopulationService.showWalkersNear(aside(fromAfar), [], [], Date.now(), true)).length, 1);
        assert.deepStrictEqual(late(), [lateBefore[0] + 1, lateBefore[1] + 1], 'a walker from outside the view is late');
        // A walker that set out on foot, a player standing by the start of its run: kept cold,
        // never shown beside him (only a teleport arrival is).
        spawned = [];
        const setOut = cachedWalker(4209, { stats: { karma: 100 } }, spotTravel(NEAR_DRAGON_VALLEY), Date.now() - 500);
        assert.strictEqual(setOut.stats.travel.method, 'walk');
        const start = ColdTrip.positionAt(setOut, Date.now());
        assert.ok(gap(start, setOut.stats.travel.run.from) < 100, 'it stands by where it set out');
        await PopulationService.showWalkersNear(start, [], [], Date.now());
        assert.strictEqual(spawned.length, 0, 'a walker on foot is not shown beside the player');

        cachedWalker(4203, {}, spotTravel(NEAR_DRAGON_VALLEY), Date.now() - tripMs + 1500);
        spawned = [];
        const full = Array(Config.maxActivationsPerScan).fill({ ok: true });
        await PopulationService.showWalkersNear(aside(NEAR_DRAGON_VALLEY), [], full, Date.now());
        assert.strictEqual(spawned.length, 0, 'a full activation budget shows no walker');
    } finally {
        LifeState.walkersNear = real.near;
        ActorQueries.byId = real.byId;
        Owner.handoffToMain = real.handoff;
        Manager.loadAndSpawnBot = real.spawn;
        Coordinator.acceptColdState = real.accept;
        LifeState.upsertState = real.upsert;
        Object.assign(Geo, { hasGeo: real.hasGeo, getCellData: real.cell, getHeight: real.height, canWalkStraight: real.walk });
    }
    assert.ok(TravelRoutes.teleportPoints().length > 0);
    console.log('cold honest travel checks passed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
