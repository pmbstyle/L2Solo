'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const timestamp = 1793485080000;
const inventory = {};
// Native archer kit (of a level-29 archer; at 31 it ends a lone Basilisk's fight above
// its potion line, BotEncounterReadiness) from a field that is safe overall but whose
// paired Basilisk spawn the archer cannot hunt. No live database or world.
for (const [id, slots] of [[43, [6]], [50, [9]], [274, [14]], [390, [10]], [412, [11]],
    [847, [1, 2]], [890, [4, 5]], [907, [3]], [1122, [12]]]) {
    inventory[id] = { selfId: id, amount: slots.length, equipped: true,
        equippedCount: slots.length, equippedSlots: slots, slot: slots[0] };
}
const state = { characterId: 990501, phase: 'cold', activity: 'hunting', level: 31,
    stats: { classId: 35, role: 'archer', wishFocus: ['power:45:6', 1, 100000] },
    inventory, spotId: 'source-home', loc: {}, vitals: { hp: 1000, mp: 500 }, timing: {} };
state.stats.coldCombat = Cold.legacySnapshot(state, Cold.skillRecordsFromTree(35, 31), timestamp);
const profiles = Match.stateProfiles(state, { timestamp });
const watcher = { selfId: 67, level: 25, count: 11, pulls: [[1, 1]] };
const basilisk = { selfId: 72, level: 28, count: 2, pulls: [[2, 1]] };
const field = (id, entries) => ({ id, name: id, avgLevel: 26, minLevel: 25, maxLevel: 28,
    density: entries.reduce((sum, e) => sum + e.count, 0), levelCounts: { 25: 11, 28: 2 },
    center: { locX: -45000, locY: 180000, locZ: -3000 }, tags: [], tagsAuthoritative: true,
    npcEntries: entries, npcSelfIds: entries.map(e => e.selfId) });
const unsafe = field('source-unsafe', [basilisk]);
const mixed = field('source-mixed', [watcher, basilisk]);
const safe = field('source-safe', [watcher, { ...basilisk, pulls: [[1, 1]] }]);
const home = field('source-home', [watcher]);
const spots = [unsafe, mixed, safe, home];
assert(!Routes.isSpotAllowedForState(unsafe, state, { timestamp }), 'fixture: the first source field is unsafe');
assert(Routes.isSpotAllowedForState(mixed, state, { timestamp }), 'fixture: the mixed field itself is safe');
assert(!Match.speciesPulls(profiles, basilisk, { soloSafety: true }).canHunt,
    'fixture: the source species is excluded by the native solo pick');
const allowed = Planner.sourceRouteReader(state, { timestamp, spots, matchupProfiles: profiles });
assert(allowed(mixed), 'the field remains ordinary hunting ground');
assert(!allowed(mixed, 72), 'the unsafe species is no item source');
assert(allowed(safe, 72), 'single Basilisks remain a valid item source');
assert(!allowed(safe, 999999), 'an absent species cannot supply an item');
const partial = field('source-partial', [watcher, { ...basilisk, pulls: [[1, 0.5], [2, 0.5]] }]);
assert(allowed(partial, 72), 'a source with some surviving pulls remains available');

const drain = iterator => { let step; do { step = iterator.next(); } while (!step.done); return step.value; };
const facts = extra => drain(Planner.sourceFacts(state, 45, 1,
    { spots, timestamp, routeAllowed: allowed, spotValue: () => ({ kills: 100, valueHours: 0.5 }),
        trip: { details: () => ({ known: true, hours: 0.1, fees: 0 }) }, ...extra }));
const all = facts();
assert.equal(all.find(row => row.spotId === mixed.id && row.npcId === 72)?.reason, 'route_ineligible');
assert(all.some(row => row.spotId === safe.id && row.npcId === 72 && row.status === 'ready'));
assert.deepEqual(facts({ readyOnly: true }), all.filter(row => row.status === 'ready'));
assert.deepEqual(facts({ bestForWish: { hourAdena: 100 } }),
    all.filter(row => row.status === 'ready').sort((a, b) => a.costHours - b.costHours).slice(0, 1));
for (let i = 0; i < 100; i++) {
    assert.notEqual(Cold.npcForSpot(mixed, () => (i + 0.5) / 100,
        { preferredNpcId: 72, matchupProfiles: profiles, soloSafety: true, pull: true }).selfId, 72);
}

// Both the unsafe whole field and the unsafe target must be skipped before
// taking the first source. The saved source is deliberately the bad one.
const plan = { status: 'active', strategy: 'direct_drop', target: { selfId: 45, slot: 6 },
    next: { spotId: unsafe.id, npcId: 72, itemId: 45, amount: 1 } };
const alternative = field('source-other-species', [{ selfId: 1099, level: 25, count: 5, pulls: [[1, 1]] }]);
const routeSpots = [unsafe, mixed, alternative, home];
const hunting = { ...state, stats: { ...state.stats, equipmentPlan: plan } };
const original = Spots.cache;
try {
    Spots.cache = routeSpots;
    assert.equal(Planner.isPlanSourceViableForState(hunting, plan, { spots: routeSpots, timestamp }), false,
        'a stored unsafe source cannot hold its advisory fast path');
    const nativeSource = Planner.bestSourceForPlan(hunting, plan, routeSpots, { timestamp });
    assert.equal(nativeSource?.spotId, alternative.id, 'the native plan owner chooses the same alternative');
    assert.equal(nativeSource?.npcId, 1099, 'the alternative has a different target species');
    const retargeted = Planner.retargetPlanSource(hunting, plan, nativeSource);
    assert.equal(retargeted.next.npcId, 1099, 'native plan retargeting updates the combat target with the spot');
    assert.equal(Planner.isPlanSourceViableForState(hunting, retargeted, { spots: routeSpots, timestamp }), true);
    // The plan's review holds the route's verdict on its source with it (routedSpotId, the
    // outgrown fact's input): none for the refused source, the spot of the one it takes.
    const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
    const refused = Selection.withRoutedSource(hunting, { ...plan, routedSpotId: unsafe.id }, routeSpots, timestamp);
    assert.equal(refused.routedSpotId, undefined, 'a source the route refuses is published as none');
    const routed = Selection.withRoutedSource(hunting, retargeted, routeSpots, timestamp);
    assert.equal(routed.routedSpotId, alternative.id, 'the source the route takes is published by its spot');
    const options = { profiles: routeSpots, timestamp, hasRoom: () => true };
    assert.equal(Spots.findForState(hunting, options)?.id, alternative.id,
        'the next executable source is chosen before the ordinary hunting fallback');
    assert.notEqual(Spots.findForState(hunting, { ...options, hasRoom: id => id !== alternative.id })?.id, alternative.id,
        'a full alternative source is skipped too');
    assert.equal(Spots.findForState(hunting, { ...options, excludedSpotIds: [mixed.id, unsafe.id] })?.id, alternative.id,
        'excluded sources do not hide the safe alternative');
    assert.equal(Planner.bestSourceForPlan(hunting, plan, routeSpots,
        { timestamp, hasRoom: () => false }), null, 'the native owner also skips full remote sources');
    const waiting = { ...hunting, stats: { ...hunting.stats, equipmentPlan: { ...plan, requiresParty: true, partyNeed: 'required' } } };
    assert.equal(Planner.bestSourceForPlan(waiting, waiting.stats.equipmentPlan, [unsafe], { timestamp })?.spotId,
        unsafe.id, 'a party-required plan keeps its separate recruitment admission');
    const Service = invoke('GameServer/Bot/AI/SpotService');
    const Errands = invoke('GameServer/Bot/Population/CombinedErrandPolicy');
    const savedService = Service.spots, pending = Errands.pending;
    try {
        Service.spots = routeSpots; Errands.pending = () => [];
        const shopping = { ...hunting, spotId: mixed.id, activity: 'shopping', currentRegion: 'Gludin',
            loc: { locX: -80752, locY: 149776, locZ: -3000 }, stats: { ...hunting.stats,
                equipmentPlan: { ...plan, next: { ...plan.next, spotId: mixed.id } },
                townVisit: { completed: true }, marketReturn: { spotId: mixed.id, loc: mixed.center, regionName: mixed.name } } };
        const Goals = invoke('GameServer/Bot/Goals/GoalExecutor');
        assert.equal(Goals.finishMarketVisit(shopping, timestamp).stats.travel.spotId,
            mixed.id, 'the return goes to the spot it hunted; the worker\'s trip start retargets it (above)');
        // A visit's end reads the spot the worker's route publishes (huntSpot), never the
        // bare source: with none published it goes back where it hunted.
        const fromHome = { ...shopping, stats: { ...shopping.stats,
            marketReturn: { spotId: home.id, loc: home.center, regionName: home.name } } };
        assert.equal(Goals.finishMarketVisit(fromHome, timestamp).stats.travel.spotId, home.id,
            'none published: the spot it hunted');
        const Route = invoke('GameServer/Bot/Population/BotRoute');
        // The mind key as the worker writes it: the spot and what it was chosen on.
        const published = (row, spotId) => ({ ...row, stats: { ...row.stats, huntSpot: { spotId,
            plan: String(row.stats.equipmentPlan.next.spotId), earning: null } } });
        const routedRow = { ...fromHome, stats: { ...fromHome.stats, equipmentPlan: routed } };
        assert.equal(Goals.finishMarketVisit(published(routedRow, alternative.id), timestamp).stats.travel.spotId,
            alternative.id, 'the published source is the return\'s destination');
        assert.equal(Goals.finishMarketVisit({ ...published(routedRow, alternative.id), stats: {
            ...published(routedRow, alternative.id).stats, equipmentPlan: plan } }, timestamp).stats.travel.spotId, home.id,
        'a spot chosen on another plan source is not served: the spot it hunted');
        // One chooser: with two sources of one species the route takes the first in its
        // order (BotRoute.trip), not the plan's own source although that one is viable; a
        // visit's end with no saved return sends the bot where the trip would.
        const species = { selfId: 1099, level: 25, count: 5, pulls: [[1, 1]] };
        const first = field('source-first', [species]), second = field('source-second', [species]);
        const twoSpots = [unsafe, mixed, first, second, home];
        Spots.cache = twoSpots; Service.spots = twoSpots;
        const onSecond = { ...plan, next: { ...plan.next, spotId: second.id, npcId: 1099 } };
        const collector = { ...hunting, spotId: home.id, stats: { ...hunting.stats,
            equipmentPlan: Selection.withRoutedSource(hunting, onSecond, twoSpots, timestamp) } };
        assert.equal(collector.stats.equipmentPlan.routedSpotId, second.id, 'fixture: the plan\'s own source is viable');
        const tripSpot = Route.trip({}, collector, null, { spots: twoSpots, timestamp })?.spotId;
        assert.equal(tripSpot, first.id, 'fixture: the trip takes the first source');
        const lost = { ...collector, activity: 'shopping', currentRegion: 'Gludin', loc: shopping.loc,
            stats: { ...collector.stats, townVisit: { completed: true }, marketReturn: null } };
        assert.equal(Goals.finishMarketVisit(published(lost, tripSpot), timestamp, { recoverMissingReturn: true })
            .stats.travel.spotId, first.id, 'the visit\'s end goes where the trip goes');
        assert.equal(Route.huntSpot(collector, null, { spots: twoSpots, timestamp }), tripSpot,
            'the published spot is the trip\'s own choice');
        assert.equal(Route.huntSpot({ ...collector, party: { partyId: 'bgp-source' } }, null, { spots: twoSpots, timestamp }), null,
            'a party member\'s hunt is its party\'s');
        // The worker's step publishes it in the mind with its basis, writes it again on a
        // row that lacks it (a refused commit), and nothing on a row that holds it.
        const record = {}, options = { spots: twoSpots, timestamp };
        const keys = Route.huntSpotHeld(record, collector, null, options);
        assert.deepEqual(keys, { huntSpot: { spotId: first.id, plan: second.id, earning: null } });
        assert.equal(Route.huntSpotHeld(record, { ...collector, stats: { ...collector.stats, ...keys } }, null, options), null);
        assert.deepEqual(Route.huntSpotHeld(record, collector, null, options), keys);
        assert.equal(Goals.finishMarketVisit({ ...lost, stats: { ...lost.stats, ...keys } }, timestamp, { recoverMissingReturn: true })
            .stats.travel.spotId, first.id, 'main serves what the worker published');
        // One search: with the first source full, the trip's room filter takes another, and
        // the published spot is that same choice, not the full source.
        const roomRecord = {}, hasRoom = id => String(id) !== first.id;
        const roomTrip = Route.trip(roomRecord, collector, null, { spots: twoSpots, timestamp, hasRoom })?.spotId;
        assert(roomTrip && roomTrip !== first.id, 'fixture: the trip skips the full source');
        assert.equal(Route.huntSpotHeld(roomRecord, collector, null, options)?.huntSpot.spotId, roomTrip,
            'the published spot is where the trip goes');
        // A step the route may not take the bot on (a clan party wait) publishes nothing: the
        // spot it holds stands, and the next step asks again.
        const ClanPartyDuty = invoke('GameServer/Bot/Population/ClanPartyDuty'), waiting = ClanPartyDuty.waiting;
        try {
            ClanPartyDuty.waiting = () => true;
            assert.equal(Route.huntSpotHeld(record, { ...collector, stats: { ...collector.stats, ...keys } },
                { activity: 'shopping' }, options), null, 'a clan wait does not erase the published spot');
        } finally { ClanPartyDuty.waiting = waiting; }
        // A gear change (the build's route facts move: the step drops the route) chooses the
        // published spot again: a leaf's spot it may no longer hunt is not served on.
        Spots.cache = spots; Service.spots = spots;
        const leafSpot = safe, leafOf = { activity: 'hunting', spotId: leafSpot.id };
        const kitted = { ...state, spotId: home.id }, naked = { ...kitted, inventory: {} };
        const fits = row => { const read = Route.leafFitReader(row, { spots, timestamp }); return spots.map(s => `${s.id}:${read(s.id)}`).join(' '); };
        const why = `kitted ${fits(kitted)}; naked ${fits(naked)}`;
        const gearRecord = {}, leafOptions = { spots, timestamp };
        const published2 = Route.huntSpotHeld(gearRecord, kitted, leafOf, leafOptions);
        assert.equal(published2?.huntSpot.spotId, leafSpot.id, `fixture: the leaf's spot is published (${why})`);
        const stripped = { ...naked, stats: { ...naked.stats, ...published2 } };
        assert.notEqual(Route.huntSpot(stripped, leafOf, leafOptions), leafSpot.id, `fixture: without its kit it may not hunt there (${why})`);
        Route.drop(gearRecord, 'sections');
        const chosenAgain = Route.huntSpotHeld(gearRecord, stripped, leafOf, leafOptions);
        assert(chosenAgain && chosenAgain.huntSpot.spotId !== leafSpot.id, 'the route facts moved: the published spot is chosen again');
    } finally { Service.spots = savedService; Errands.pending = pending; }
} finally { Spots.cache = original; }
console.log('test_spot_source_targets: ok');
