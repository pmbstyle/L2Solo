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
    // The plan's review publishes the route's verdict with it (routedSpotId), the one main
    // reads where it sends a bot to hunt without searching: none for the refused source,
    // the spot of the one the route takes.
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
        // A visit's end reads the route's verdict on the plan's source, never the bare
        // source: a refused one sends the bot back where it hunted, the routed one to it.
        const fromHome = { ...shopping, stats: { ...shopping.stats,
            marketReturn: { spotId: home.id, loc: home.center, regionName: home.name } } };
        assert.equal(Goals.finishMarketVisit(fromHome, timestamp).stats.travel.spotId, home.id,
            'a source the route refuses is no destination: the spot it hunted');
        assert.equal(Goals.finishMarketVisit({ ...fromHome, stats: { ...fromHome.stats, equipmentPlan: routed } }, timestamp)
            .stats.travel.spotId, alternative.id, 'the source the route takes is the return\'s destination');
    } finally { Service.spots = savedService; Errands.pending = pending; }
} finally { Spots.cache = original; }
console.log('test_spot_source_targets: ok');
