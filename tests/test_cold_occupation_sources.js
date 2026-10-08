'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Sources = require('../src/GameServer/Bot/Population/ColdOccupationSources');
const Trip = require('../src/GameServer/Bot/Population/ColdTrip');
const Towns = require('../src/GameServer/World/TownRespawn');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
Sources.initialise();
function drain(iterator) {
    const stages = []; let next;
    do { next = iterator.next(); if (!next.done) stages.push(next.value); } while (!next.done);
    return { value: next.value, stages };
}
assert(Sources.npcOffersFor(1785).length > 0);
assert(Sources.npcOffersFor(1785).every(row => row.sourceId > 0 && row.town && row.price > 0));
assert(Object.isFrozen(Towns.regionIndex.zones[0].points[0]));
for (const loc of [Towns.towns.giran_town, Towns.towns.floran_village,
    { locX: 112000, locY: -15000, locZ: 0 }, { locX: 0, locY: 240000, locZ: -4000 },
    { locX: 500000, locY: 500000, locZ: 0 }]) {
    const regional = drain(Sources.regionalTown(loc));
    assert.strictEqual(regional.value, Towns.getClosestTown(loc.locX, loc.locY, loc.locZ));
    assert(regional.stages.length > 0);
}
const state = { characterId: 900004, phase: 'cold', activity: 'hunting', level: 40,
    adena: 1000000, loc: { locX: 117000, locY: 76000, locZ: -2800 }, currentRegion: "Hunter's Village",
    inventory: { 736: { selfId: 736, amount: 1 }, 1864: { selfId: 1864, amount: 100 } },
    stats: { classId: 57, money: [1000, .001, 0, 0] } };
const savedHonest = Config.coldHonestTravel;
try {
    for (const honest of [false, true]) {
        Config.coldHonestTravel = honest;
        const streamed = drain(Sources.tripDetails(state, 'Giran'));
        const destination = Towns.towns.giran_town;
        const forward = Trip.townPlan(state, destination);
        const back = Trip.spotTripMs({ ...state, loc: Trip.point(destination) }, state.loc);
        assert.equal(streamed.value.hours, (forward.durationMs + back) / 3600000);
        assert.equal(streamed.value.fees, forward.route.fee);
        if (honest) assert(streamed.stages.filter(stage => stage === 'edge').length >= Sources.catalogCounts().teleportEdges);
    }
} finally { Config.coldHonestTravel = savedHonest; }
const board = new BoardIndex();
for (let at = 0; at < 6; at++) board.put({ id: 200 + at, ownerId: 400 + at, storeType: 1,
    kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 300 + at, selfId: 1864, count: 1, price: 100 + at }] });
const read = new Set();
const owner = { ...state, activity: 'shopping', currentRegion: 'Giran', loc: Towns.towns.giran_town };
const prepared = drain(Sources.prepare(owner, { board, timestamp: 1000, read: id => read.add(id) })).value;
assert(prepared && read.has(1864));
assert.equal(prepared.options.ownStock.get(1864).count, 100);
const bounded = drain(prepared.options.preparePurchase(owner, 1864, 6, { npc: false }));
assert.equal(bounded.value.units, 5, 'native purchase view admits only the first five indexed rows');
assert.equal(bounded.value.whole, false);
assert.equal(drain(prepared.options.preparePurchase(owner, 1785, 1, { npc: false })).value, null);
const npc = drain(prepared.options.preparePurchase(owner, 1785, 1, { npc: true })).value;
assert(npc.whole && npc.npc === 1 && npc.repeatable && npc.town);
const EconomicTrip = require('../src/GameServer/Bot/Economy/EconomicTrip');
const routeRows = drain(EconomicTrip.prepare(state)).value;
const routeKey = EconomicTrip.key(state);
const reusedSources = drain(Sources.prepare(state, { board, timestamp: 1000, economy: { routeKey, routeRows } })).value;
const freshSources = drain(Sources.prepare(state, { board, timestamp: 1000 })).value;
const reusedPurchase = drain(reusedSources.options.preparePurchase(state, 1864, 1, { npc: false }));
const freshPurchase = drain(freshSources.options.preparePurchase(state, 1864, 1, { npc: false }));
assert.deepEqual(reusedPurchase.value, freshPurchase.value, 'occupation/actions share the accepted wish route table');
assert(freshPurchase.stages.includes('edge') && !reusedPurchase.stages.includes('edge'),
    'the ready shared table removes repeated geometry, not source or spending revalidation');
const staleSources = drain(Sources.prepare(state, { board, timestamp: 1000,
    economy: { routeKey: 'obsolete', routeRows } })).value;
assert(drain(staleSources.options.preparePurchase(state, 1864, 1, { npc: false })).stages.includes('edge'),
    'a changed route key cannot suppress actual route preparation');
const protectedState = { ...owner, stats: { ...owner.stats, equipmentPlan: { strategy: 'craft', status: 'active',
    target: { selfId: 3000 }, materials: [{ selfId: 1864, amount: 40 }] } } };
assert.equal(drain(Sources.reservations(protectedState)).value[1864], 40);
const listed = new BoardIndex();
listed.put({ id: 1, ownerId: owner.characterId, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 2,
    lines: [{ lineId: 1, selfId: 1864, count: 10, price: 100 }] });
const allocated = { ...protectedState, inventory: { 1864: { selfId: 1864, amount: 20 } } };
const mask = drain(Sources.feasibility(allocated, { board: listed })).value;
const Look = require('../src/GameServer/Bot/Economy/BoardLook');
const lines = listed.ownerLines(owner.characterId);
assert.equal(Look.feasibilityPredicate(allocated, lines, mask)(lines[0]), false,
    'a deep captured ingredient reservation protects the listed stock on a natural look');
const Publication = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const publication = Publication.compact(structuredClone(Publication.capture({ workshop: { known: false, feasibility: mask } }, allocated)));
assert.deepEqual(publication.feasibility, mask);
assert.equal(publication.workshop.known, false, 'missing recipe evidence cannot erase independently known protection');
assert.equal(Look.feasibilityPredicate(allocated, [{ ...lines[0], revision: 3 }], mask)(lines[0]), undefined,
    'a changed physical line does not reuse an accepted old protection mask');
assert.equal(drain(Sources.prepare({ ...owner, stats: {} }, { board })).value, null);
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const Shots = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const selected = { craft: { recipeId: 25, batches: 64, exit: [200, 1000001, 1000, 9999],
    gear: [247, 0, 201, 1000002, 100, 9999], ownReserve: 3000 } };
const step = Plan.decideShot(owner, null, { preparedCraft: selected });
assert.equal(step.unknown, undefined, 'an ordinary selected source survives the inclusive command budget');
assert(Buffer.byteLength(JSON.stringify(step)) + Publication.COMMAND_HEADER_BYTES <= Plan.MAX_SHOT_BYTES);
const decoded = Shots.unpackStep(step);
assert.deepEqual(decoded.craft.exit, [null, 1000001, null, 9999]);
assert.deepEqual(decoded.craft.gear, [247, 0, null, 1000002, null, 9999]);
assert.equal(decoded.craft.ownReserve, 3000);
const packedDecision = Publication.compact(structuredClone(Publication.capture({ shot: step,
    workshop: { known: true, recipeId: 25, productId: 1864, incomePerHour: 0.1, cycleHours: 0.01 } }, owner)));
assert.deepEqual(packedDecision.shot, step);
assert.equal(packedDecision.workshop.cycleHours, 0.01);
assert.equal(Plan.MAX_PLAN_PAYLOAD_BYTES + Publication.COMMAND_HEADER_BYTES + 32 + 8, Plan.MAX_BYTES);
console.log('PASS native town/NPC authority parity, streamed routes/reservations and five-quote purchase view');
