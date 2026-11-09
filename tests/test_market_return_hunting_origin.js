'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Service = invoke('GameServer/Bot/AI/SpotService');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Income = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const Errands = invoke('GameServer/Bot/Population/CombinedErrandPolicy');
const Executor = invoke('GameServer/Bot/Goals/GoalExecutor');
const BotRoute = invoke('GameServer/Bot/Population/BotRoute');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const timestamp = 1793485080000;
const inventory = {};
// A Falchion, not the starter Broadsword: a level 24 knight with the latter does not
// take the source's level 25-27 mobs (BotEncounterReadiness: a fight ends above the potion line).
for (const [id, slots] of [[68, [7]], [23, [10]], [32, [11]], [37, [12]], [43, [6]], [50, [9]],
    [114, [1]], [115, [2]], [876, [4, 5]], [907, [3]], [945, [8]]]) {
    inventory[id] = { selfId: id, amount: slots.length, equipped: true,
        equippedCount: slots.length, equippedSlots: slots, slot: slots[0] };
}
inventory[1835] = { selfId: 1835, amount: 1000 };
const field = (id, level, center, entries) => ({ id, name: id, minLevel: level - 1, maxLevel: level + 1,
    avgLevel: level, density: 12, capacity: 2, levelCounts: { [level]: 12 }, center,
    arrivalPoints: [center], npcEntries: entries, npcSelfIds: entries.map(row => row.selfId),
    tags: [], tagsAuthoritative: true });
const source = field('28_-31', 26, { locX: 173736, locY: -184174, locZ: -1940 },
    [{ selfId: 1133, level: 25, count: 2 }, { selfId: 1135, level: 27, count: 2 }, { selfId: 1134, level: 26, count: 1 }]);
const money = field('27_-35', 19, { locX: 165425, locY: -206763, locZ: -3532 },
    [{ selfId: 1126, level: 20, count: 5 }, { selfId: 1125, level: 19, count: 4 }, { selfId: 1124, level: 18, count: 4 }]);
const spots = [source, money];
const state = { characterId: 990502, level: 24, adena: 100000, phase: 'cold', activity: 'hunting',
    spotId: source.id, loc: source.center, currentRegion: source.name, inventory, timing: {},
    vitals: { hp: 600, maxHp: 600, mp: 250, maxMp: 250 },
    stats: { classId: 32, role: 'tank', wishFocus: ['power:167:7', 1, 0], stepCount: 10,
        equipmentPlan: { status: 'deferred', strategy: 'none', next: null } } };
state.stats.coldCombat = Cold.legacySnapshot(state, Cold.skillRecordsFromTree(32, 24), timestamp);
assert(Routes.isSpotAllowedForState(source, state, { timestamp }), 'fixture: the original item source is huntable');
const leaf = { activity: 'hunting', spotId: source.id, npcId: 1133, itemId: 167, amount: 1,
    rootKey: 'power:167:7', kind: 'drop' };
const shopper = { ...state, activity: 'shopping', currentRegion: 'Dwarven Village',
    loc: { locX: 115072, locY: -178176, locZ: -880 },
    stats: { ...state.stats, townVisit: { town: 'Dwarven Village', completed: true },
        marketReturn: { spotId: source.id, regionName: source.name, loc: source.center },
        // Its held earning answer is where it hunts (the worker decided it; main reads it, never searches).
        earning: { spotId: source.id, shots: true, income: 1, expected: 1, earning: 1, error: 0, at: 1 } } };
const holding = spot => ({ spotId: spot.id, shots: true, income: 1, expected: 1, earning: 1, error: 0, at: 2 });
// The row as the worker's step leaves it: the spot its route goes to when sent to hunt
// published in the mind (huntSpot, BotRoute.huntSpotHeld), which main's visit end reads.
const published = (row, leaf = null) => ({ ...row, stats: { ...row.stats,
    ...BotRoute.huntSpotHeld(null, row, leaf, { spots, timestamp }) } });
const saved = { spots: Spots.cache, service: Service.spots, pending: Errands.pending };
try {
    Spots.cache = Service.spots = spots;
    Errands.pending = () => [];
    assert.equal(Income.heldSpot(shopper, spots)?.id, source.id, 'fixture: the held earning answer is its source');
    // A solo visit's end hands the bot back to the worker: it rests in town, due now, with no
    // trip of main's choosing, whatever spot it hunted before (marketReturn) or the worker holds.
    const back = row => {
        const next = Executor.finishMarketVisit(row, timestamp);
        assert.equal(next.activity, 'resting', 'the visit ends in town');
        assert.equal(next.stats.travel ?? null, null, 'main starts no trip');
        assert.equal(next.timing.nextResolveAt, timestamp, 'the worker\'s next step is due now');
        assert.equal(next.stats.marketReturn, null);
        assert.equal(next.spotId, null, 'it stands on no spot in town');
        // The worker's next step ends its rest, due now again: the step after it starts the
        // trip (BotRoute.trip), not half a minute later.
        const rest = Resolver.resolveSolo({ state: next, spot: null, elapsedMs: 0, timestamp });
        assert.equal(rest.patch.activity, 'hunting', 'its rest is over');
        assert.equal(rest.nextResolveAt, timestamp, 'with no ground under it, it is routed at once');
        return { ...next, activity: rest.patch.activity, stats: { ...next.stats, ...rest.patch.stats } };
    };
    const tripOf = (row, leaf = null) => BotRoute.trip({}, row, leaf, { spots, timestamp: timestamp + 1000 })?.spotId;
    const returned = back(published(shopper));
    assert.equal(tripOf(returned), source.id, 'the worker sends it to the valid material source it holds');
    const arrived = { ...returned, spotId: source.id, loc: source.center, currentRegion: source.name };
    assert.equal(BotRoute.trip({}, arrived, leaf, { spots, timestamp: timestamp + 30000,
        currentSpot: source }), null, 'the worker needs no second trip to its source');

    // The plan as its review publishes it: with the route's verdict on its source.
    const changed = { ...shopper, stats: { ...shopper.stats, equipmentPlan: invoke('GameServer/Bot/AI/GearPlanSelection')
        .withRoutedSource(shopper, { status: 'active', strategy: 'direct_drop', target: { selfId: 45, slot: 6 },
            next: { spotId: money.id, npcId: 1126, itemId: 45, amount: 1 } }, spots, timestamp) } };
    // A gear plan's source the route takes comes before the held answer (BotRoute.huntSpot).
    assert.equal(tripOf(back(published(changed))), money.id, 'an active plan\'s viable source, as the route takes it');
    // The held answer comes before the spot it hunted before the trip (B12).
    const heldElsewhere = { ...shopper, stats: { ...shopper.stats, earning: holding(money) } };
    assert.equal(tripOf(back(published(heldElsewhere))), money.id, 'the held earning answer, not the saved spot');
    assert.equal(tripOf(back(published(shopper)), { activity: 'hunting', spotId: money.id }), money.id,
        'the worker\'s hunting leaf names the spot');
} finally {
    Spots.cache = saved.spots; Service.spots = saved.service;
    Errands.pending = saved.pending;
}
console.log('test_market_return_hunting_origin: ok');
