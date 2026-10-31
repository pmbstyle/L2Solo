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
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const timestamp = 1793485080000;
const inventory = {};
for (const [id, slots] of [[3, [7]], [23, [10]], [32, [11]], [37, [12]], [43, [6]], [50, [9]],
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
        marketReturn: { spotId: source.id, regionName: source.name, loc: source.center } } };
const saved = { spots: Spots.cache, service: Service.spots, select: Income.select, pending: Errands.pending };
try {
    Spots.cache = Service.spots = spots;
    Errands.pending = () => [];
    Income.select = () => ({ spot: money });
    assert.equal(Spots.findForState(state, { profiles: spots, timestamp })?.id, money.id,
        'fixture: a fresh earning search would choose a different camp');
    const returned = Executor.finishMarketVisit(shopper, timestamp);
    assert.equal(returned.stats.travel.spotId, source.id,
        'a shopping visit returns directly to the valid material source');
    const arrived = { ...returned, activity: 'hunting', spotId: source.id, loc: returned.stats.travel.to,
        stats: { ...returned.stats, travel: null } };
    assert.equal(BotRoute.trip({}, arrived, leaf, { spots, timestamp: timestamp + 30000,
        currentSpot: source, hasRoom: () => true }), null, 'the worker needs no second trip to its source');

    const changed = { ...shopper, stats: { ...shopper.stats, equipmentPlan: {
        status: 'active', strategy: 'direct_drop', target: { selfId: 45, slot: 6 },
        next: { spotId: money.id, npcId: 1126, itemId: 45, amount: 1 } } } };
    assert.equal(Executor.finishMarketVisit(changed, timestamp).stats.travel.spotId, money.id,
        'a source changed during shopping takes precedence over the old safe origin');

    const excluded = { ...shopper, stats: { ...shopper.stats,
        capacityBackoffs: [{ spotId: source.id, untilStep: 12 }] } };
    assert.equal(Executor.finishMarketVisit(excluded, timestamp).stats.travel.spotId, money.id,
        'a marked source is still replanned');
    for (const characterId of [990503, 990504]) Life.acceptLifecycleRow({ characterId,
        characterName: 'SourceHunter', level: 24, phase: 'cold', activity: 'hunting', spotId: source.id,
        statsJson: '{}', inventorySummary: '{}' });
    assert.equal(Executor.finishMarketVisit(shopper, timestamp).stats.travel.spotId, money.id,
        'a source that filled during the visit is still replanned');
} finally {
    Spots.cache = saved.spots; Service.spots = saved.service;
    Income.select = saved.select; Errands.pending = saved.pending;
}
console.log('test_market_return_hunting_origin: ok');
