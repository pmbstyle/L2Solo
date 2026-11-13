'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
const Evidence = invoke('GameServer/Bot/Economy/WishPurchaseEvidence');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
// A context holds only by its event proof, which needs the warehouse rows
// and a recompute generation; without them every request builds anew.
invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
const inventory = {};
for (const row of Gear.planFor({ classId: 46, level: 20 }).items) {
    if ([7, 14].includes(row.slot)) continue;
    const held = inventory[row.selfId];
    inventory[row.selfId] = { ...row, amount: Number(held?.amount || 0) + 1,
        equipped: true, equippedCount: Number(held?.equippedCount || 0) + 1,
        equippedSlots: [...held?.equippedSlots || [], row.slot] };
}
inventory[86] = { selfId: 86, amount: 1, slot: 7, equipped: true, equippedCount: 1, equippedSlots: [7] };
inventory[1463] = { selfId: 1463, amount: 100000 };
inventory[1458] = { selfId: 1458, amount: 141 };
const timestamp = 1791741600000;
const state = { characterId: 990771, level: 49, adena: 3632378, inventory,
    phase: 'cold', activity: 'hunting', currentRegion: 'Giran',
    loc: { locX: 83396, locY: 147904, locZ: -3400 },
    stats: { classId: 46, exp: Data.experience[48] } };
state.stats.coldCombat = invoke('GameServer/Bot/Population/ColdCombatProfile').legacySnapshot(state,
    invoke('GameServer/Bot/Population/ColdCombatProfile').skillRecordsFromTree(46, 49), timestamp);
const before = structuredClone(state);
const board = new BoardIndex();
function offer(id, price, count = 1, town = 'Giran') {
    board.put({ id, ownerId: 991000 + id, storeType: 1, kind: 'shop', town,
        lines: [{ lineId: id, selfId: id, count, enchant: 0, price }] });
}
let routeFees = 0;
const trip = () => routeFees;
trip.details = () => ({ known: true, hours: 0, fees: routeFees });
const purchase = Evidence.reader(state, { board, trip }, { npcOffersFor: () => [] });
const station = { known: true, hours: 0, fees: 0 };
offer(90, 1909712);
assert.equal(Crystals.choices(state, purchase, station)[0].selfId, 90);
offer(166, 206926);
let choices = Crystals.choices(state, purchase, station);
assert.equal(choices[0].selfId, 166, 'a real cheap quote outside the old catalogue shortlist wins');
assert.equal(choices[0].net, 631);
assert.equal(choices[0].batchLimit, 1, 'a one-copy quote never permits a larger physical order');
assert(choices.length <= 2, 'only two crystallization paths enter the native graph');
routeFees = 1000000;
assert.equal(Crystals.choices(state, purchase, station)[0].selfId, 90,
    'travel is paid for each input errand and can change the cheapest crystal source');
routeFees = 0;
offer(166, 206926, 0);
assert.equal(Crystals.choices(state, purchase, station)[0].selfId, 90, 'sold-out stock is not a source');
offer(166, 206926);
offer(86, 1, 16);
assert(!Crystals.choices(state, purchase, station).some(row => row.selfId === 86), 'worn gear stays protected');
const held = { ...state, inventory: { ...state.inventory,
    166: { selfId: 166, amount: 2, equipped: false } } };
const owned = Crystals.choices(held, () => null, station)[0];
assert.equal(owned.selfId, 166, 'physical spares work without a market quote');
assert.equal(owned.batchLimit, 2);
{
    const consumed = { ...held, inventory: { ...held.inventory, 166: { ...held.inventory[166], amount: 1 } } };
    assert.equal(Crystals.choices(consumed, () => null, station)[0].batchLimit, 1,
        'native current free stock reduces the executable crystal batch');
}
assert.deepEqual(state, before, 'source selection never mutates the live kit');

const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const equip = Planner.equipInventoryUpgrades;
let kitChecks = 0;
for (const id of Crystals.catalog()) if (![90, 166, 86].includes(id)) offer(id, 10000000);
Planner.equipInventoryUpgrades = (...args) => { kitChecks++; return equip(...args); };
try {
    choices = Crystals.choices(state, purchase, station);
    assert.equal(choices[0].selfId, 166);
    assert.equal(choices[1].selfId, 90);
    assert.equal(kitChecks, 2, 'a full market reconciles only the two winning safe input types');
} finally { Planner.equipInventoryUpgrades = equip; }
for (const id of Crystals.catalog()) if (![90, 166, 86].includes(id)) board.remove(id);
board.remove(86); board.remove(166);
const deps = { board, spots: [], timestamp, npcOffersFor: () => [],
    routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
        () => [true, 0, 0]) };
Economy.reset();
const expensive = Economy.forState(state, deps);
const crystalPaths = context => context.projection.nodes.find(row => row.key === 'item:1458').paths
    .filter(row => row.kind === 'crystallize');
assert(crystalPaths(expensive).some(row => row.improvement.sourceSelfId === 90));
// The bot publishes the build's decision; later reviews read that state.
const published = { ...state, stats: { ...state.stats, ...expensive.statsPacket } };
offer(166, 206926);
const cheaper = Economy.forState(published, deps);
assert.deepEqual(cheaper.network.queue, expensive.network.queue,
    'a new quote of an unwatched input waits for the next decision');
assert.strictEqual(cheaper.plan, expensive.plan, 'the published decision is held, not rebuilt');
// The next decision: a situation woke the build (its gate), read by the bot's step.
const nextDecision = from => ({ ...from, stats: { ...from.stats, decisionSeq: Number(from.stats.decisionSeq || 0) + 1 } });
const refreshed = Economy.forState(nextDecision(published), { ...deps, caller: 'step' });
assert(crystalPaths(refreshed).some(row => row.improvement.sourceSelfId === 166),
    'the newly listed cheap input enters at the next decision');
assert(refreshed.network.queue.some(row => {
    const old = expensive.network.queue.find(other => other.key === row.key);
    return old && row.price < old.price;
}), 'the native full C-goal estimate falls, rather than just a single-batch price');
offer(166, 206926, 0);
const depleted = Economy.forState(nextDecision({ ...state, stats: { ...state.stats, ...refreshed.statsPacket } }), { ...deps, caller: 'step' });
assert(!crystalPaths(depleted).some(row => row.improvement.sourceSelfId === 166),
    'quote depletion invalidates the selected crystal path');
assert.deepEqual(state, before);
console.log(`PASS crystallization market sources: live quotes, trips, finite stock, protected gear and context invalidation ${isMainThread ? 'main' : 'worker'}`);
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
