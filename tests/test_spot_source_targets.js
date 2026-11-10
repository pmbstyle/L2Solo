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
// Its step farms the plan's item: a hunting leaf of the plan's root naming no spot it may take.
const farm = { activity: 'hunting', kind: 'drop', rootKey: 'power:45:6', itemId: 45 };
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
    const Route = invoke('GameServer/Bot/Population/BotRoute');
    assert.equal(Route.huntSpot(hunting, farm, { spots: routeSpots, timestamp })?.spotId, alternative.id,
        'the next executable source is chosen before the ordinary hunting fallback');
    const marked = { ...hunting, stats: { ...hunting.stats, spotMarks: [{ spotId: mixed.id, reason: 'contest_lost', answer: 1 },
        { spotId: unsafe.id, reason: 'contest_lost', answer: 1 }] } };
    assert.equal(Route.huntSpot(marked, farm, { spots: routeSpots, timestamp })?.spotId, alternative.id,
        'marked sources do not hide the safe alternative');
    // A plan it may not farm now sends it nowhere near its source: a bot that lost a level since the
    // plan (leveling recovery: it hunts for the level, until it regains it) and a craft plan whose
    // material is already in the bag both hunt where a bot without the plan would.
    const withoutPlan = Route.huntSpot({ ...hunting, stats: { ...state.stats } }, null, { spots: routeSpots, timestamp })?.spotId;
    assert.notEqual(withoutPlan, alternative.id, 'fixture: the leveling pick is not the source');
    const deleveled = { ...hunting, stats: { ...hunting.stats, equipmentPlan: { ...retargeted, plannedForLevel: 32 } } };
    assert(Planner.levelingRecoveryFor(deleveled, deleveled.stats.equipmentPlan, timestamp), 'fixture: in leveling recovery');
    assert.equal(Route.huntSpot(deleveled, farm, { spots: routeSpots, timestamp })?.spotId, withoutPlan,
        'a deleveled bot hunts its leveling pick, not the plan\'s source');
    const material = { ...retargeted, strategy: 'craft', next: { ...retargeted.next, itemId: 45, requiredTotal: 2 } };
    const stocked = { ...hunting, inventory: { ...inventory, 45: { selfId: 45, amount: 2 } },
        stats: { ...hunting.stats, equipmentPlan: material } };
    assert.equal(Route.huntSpot({ ...stocked, inventory }, farm, { spots: routeSpots, timestamp })?.spotId, alternative.id,
        'fixture: the material still missing, the source is the spot');
    assert.equal(Route.huntSpot(stocked, farm, { spots: routeSpots, timestamp })?.spotId, withoutPlan,
        'its material in the bag: no source to farm');
    const waiting = { ...hunting, stats: { ...hunting.stats, equipmentPlan: { ...plan, requiresParty: true, partyNeed: 'required' } } };
    assert.equal(Planner.bestSourceForPlan(waiting, waiting.stats.equipmentPlan, [unsafe], { timestamp })?.spotId,
        unsafe.id, 'a party-required plan keeps its separate recruitment admission');
    const Service = invoke('GameServer/Bot/AI/SpotService');
    const Errands = invoke('GameServer/Bot/Population/CombinedErrandPolicy');
    const savedService = Service.spots, pending = Errands.pending;
    try {
        Service.spots = routeSpots; Errands.pending = () => [];
        // One chooser: with two sources of one species (one value: both in the habit band)
        // the route takes the one search's pick, the plan's own pick of a source
        // (bestSourceForPlan), not the plan's stored source although that one is viable.
        const species = { selfId: 1099, level: 25, count: 5, pulls: [[1, 1]] };
        const first = field('source-first', [species]), second = field('source-second', [species]);
        const twoSpots = [unsafe, mixed, first, second, home];
        Spots.cache = twoSpots; Service.spots = twoSpots;
        const onSecond = { ...plan, next: { ...plan.next, spotId: second.id, npcId: 1099 } };
        const collector = { ...hunting, spotId: home.id, stats: { ...hunting.stats,
            equipmentPlan: Selection.withRoutedSource(hunting, onSecond, twoSpots, timestamp) } };
        assert.equal(collector.stats.equipmentPlan.routedSpotId, second.id, 'fixture: the plan\'s own source is viable');
        const picked = Planner.bestSourceForPlan(collector, collector.stats.equipmentPlan, twoSpots, { timestamp })?.spotId;
        assert([first.id, second.id].includes(picked), 'fixture: the plan picks one of the two sources');
        const tripSpot = Route.trip({}, collector, farm, { spots: twoSpots, timestamp })?.spotId;
        assert.equal(tripSpot, picked, 'the trip takes the plan\'s pick');
        // A source the bot's marks refuse: the other one, through the one filter.
        const markedCollector = { ...collector, stats: { ...collector.stats, spotMarks: [{ spotId: picked, reason: 'contest_lost', answer: 1 }] } };
        assert.equal(Route.huntSpot(markedCollector, farm, { spots: twoSpots, timestamp })?.spotId, picked === first.id ? second.id : first.id,
            'a marked source is never the pick: the other source');
        // A source camp it heard in town is held by a stronger look (SpotRecords): the other one, as a mark.
        const Records = invoke('GameServer/Bot/Population/SpotRecords');
        try {
            const holder = { members: [{ characterId: 990599, inventory: { 1: { rank: 'a', equippedSlots: [7] }, 2: { rank: 'a', equippedSlots: [10] } } }] };
            for (let n = 0; n < Records.HELD; n++) Records.note(picked, 1.5, [holder]);
            Records.heard(collector.characterId);
            assert.equal(Route.huntSpot(collector, farm, { spots: twoSpots, timestamp })?.spotId, picked === first.id ? second.id : first.id,
                'a source held against it, heard in town, is never the pick: the other source');
        } finally { Records.clear(); }
        const answered = { ...collector, stats: { ...collector.stats, earning: { spotId: mixed.id, shots: true, income: 100, expected: 100,
            earning: 100, error: 0, at: 2 }, spotMarks: [first.id, second.id].map(spotId => ({ spotId, reason: 'contest_lost', answer: 1 })) } };
        assert.equal(Route.huntSpot(answered, farm, { spots: twoSpots, timestamp })?.spotId, mixed.id,
            'refused sources fall to the held earning answer, not to a list walk');
        // Only a step that farms the plan's item goes to its source: buying it in town, earning money
        // for it or levelling hunt at the earning answer (no A -> B -> A between the two on each new leaf).
        const earner = { ...collector, stats: { ...collector.stats, earning: answered.stats.earning } };
        assert.equal(Route.huntSpot(earner, farm, { spots: twoSpots, timestamp })?.spotId, picked,
            'a step farming the plan\'s item goes to its source');
        const money = { activity: 'hunting', kind: 'money', funding: true, rootKey: 'power:45:6' };
        for (const [leaf, why] of [[{ activity: 'shopping', kind: 'npc', rootKey: 'power:45:6', itemId: 45 }, 'buying it in town'],
            [money, 'earning money for it'], [{ activity: 'hunting', kind: 'experience', rootKey: 'level:32' }, 'levelling'],
            [{ ...farm, rootKey: 'power:46:6', itemId: 46 }, 'farming another root\'s item'], [null, 'with no leaf']]) {
            assert.equal(Route.huntSpot(earner, leaf, { spots: twoSpots, timestamp })?.spotId, mixed.id,
                `a step ${why} hunts at the earning answer, not the item's source`);
        }
        const held = {};
        assert.equal(Route.huntSpotHeld(held, earner, money, { spots: twoSpots, timestamp })?.huntSpot.spotId, mixed.id);
        assert.equal(Route.huntSpotHeld(held, earner, farm, { spots: twoSpots, timestamp })?.huntSpot.spotId, picked,
            'the held choice follows the leaf from earning money to farming the item');
        // A player's command goes first: the trip and the published spot are the commanded
        // spot, not the plan's source, and the bot's own mark on it does not hold it back.
        const Income = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
        const command = Income.commanded(null, mixed.id, 1);
        const commandedRow = { ...collector, stats: { ...collector.stats, earning: command,
            spotMarks: [{ spotId: mixed.id, reason: 'contest_lost', answer: 1 }] } };
        assert.equal(Route.trip({}, commandedRow, null, { spots: twoSpots, timestamp })?.spotId, mixed.id,
            'the trip goes where the player sent it');
        assert.deepEqual(Route.huntSpotHeld({}, commandedRow, null, { spots: twoSpots, timestamp }), { huntSpot: { spotId: mixed.id } },
            'the published spot is the commanded one');
        // One chooser: the trip goes where the published choice names, for each kind of choice.
        const earningRow = spotId => ({ ...state, spotId: home.id, stats: { ...state.stats,
            earning: { spotId, shots: true, income: 100, expected: 100, earning: 100, error: 0, at: 2 } } });
        for (const [row, leaf, why] of [[collector, farm, 'the plan\'s source'], [earningRow(mixed.id), null, 'the earning answer'],
            [{ ...state, spotId: home.id }, { activity: 'hunting', spotId: mixed.id }, 'the leaf'], [earningRow(null), null, 'none']]) {
            const chosen = Route.huntSpot(row, leaf, { spots: twoSpots, timestamp })?.spotId ?? null;
            assert.equal(Route.trip({}, row, leaf, { spots: twoSpots, timestamp })?.spotId ?? null, chosen,
                `the trip goes to the one choice (${why})`);
            assert.equal(chosen === null, why === 'none', `fixture: ${why} names a spot or none (${chosen})`);
        }
        assert.equal(Route.huntSpot(collector, farm, { spots: twoSpots, timestamp })?.spotId, tripSpot,
            'the published spot is the trip\'s own choice');
        assert.equal(Route.huntSpot({ ...collector, party: { partyId: 'bgp-source' } }, null, { spots: twoSpots, timestamp }), null,
            'a party member\'s hunt is its party\'s');
        // The worker's step publishes it in the mind, writes it again on a row that lacks it
        // (a refused commit), and nothing on a row that holds it.
        const record = {}, options = { spots: twoSpots, timestamp };
        const keys = Route.huntSpotHeld(record, collector, farm, options);
        assert.deepEqual(keys, { huntSpot: { spotId: picked } });
        assert.equal(Route.huntSpotHeld(record, { ...collector, stats: { ...collector.stats, ...keys } }, farm, options), null);
        assert.deepEqual(Route.huntSpotHeld(record, collector, farm, options), keys);
        // One choice: the trip's held choice is the published spot, full or not (met at arrival).
        const tripRecord = {};
        const tripOut = {};
        assert.equal(Route.trip(tripRecord, collector, farm, { spots: twoSpots, timestamp, out: tripOut })?.spotId, picked);
        assert.deepEqual(Route.huntSpotKeyOf(collector, tripOut.held), keys, 'the trip gives the step the key it publishes');
        assert.equal(Route.huntSpotHeld(tripRecord, collector, farm, options)?.huntSpot.spotId, picked,
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
        assert.notEqual(Route.huntSpot(stripped, leafOf, leafOptions)?.spotId, leafSpot.id, `fixture: without its kit it may not hunt there (${why})`);
        Route.drop(gearRecord, 'sections');
        const chosenAgain = Route.huntSpotHeld(gearRecord, stripped, leafOf, leafOptions);
        assert(chosenAgain && chosenAgain.huntSpot.spotId !== leafSpot.id, 'the route facts moved: the published spot is chosen again');
    } finally { Service.spots = savedService; Errands.pending = pending; }
} finally { Spots.cache = original; }
console.log('test_spot_source_targets: ok');
