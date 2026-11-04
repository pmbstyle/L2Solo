'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation'); require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
const { createSolver } = invoke('GameServer/Bot/Economy/WishNetwork');
function kit(level) {
    const inventory = {};
    for (const row of Gear.planFor({ classId: 3, level }).items) {
        const slots = [...inventory[row.selfId]?.equippedSlots || [], row.slot];
        inventory[row.selfId] = { ...row, amount: slots.length, equipped: true,
            equippedCount: slots.length, equippedSlots: slots };
    }
    return inventory;
}
const state = { characterId: 990471, classId: 3, level: 64, phase: 'cold', activity: 'hunting', adena: 100000000,
    currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 },
    inventory: kit(40), stats: { classId: 3 } };
for (const id of [invoke('GameServer/Inventory/ShotStock').planForState(state).selfId, 1061, 736])
    state.inventory[id] = { selfId: id, amount: 100000 };
assert.equal(Progression.assess(state).required, false);
const debt = Progression.acquisitionAssessment(state);
assert.equal(debt.rank, 3); assert(debt.required);
assert.equal(Progression.acquisitionRankFor(state, debt), 'b');
assert.equal(Progression.marketOnly(state, { etc: { rank: 'a', slot: 0 } }), false,
    'the A equipment gate never blocks crafting ammunition or materials');
const higher = Data.items.find(item => item.etc?.rank === 'a' && [7, 14].includes(item.etc.slot)
    && Planner.suitable(item, state, Planner.roleFor(state), 'a'));
assert(higher);
assert.equal(Planner.preferredTarget(state, { wishTargetId: higher.selfId, spots: [], findMarketOffer: () => null }), null,
    'an absent A offer cannot turn the C-to-B stage into an A craft or hunt');
assert.deepEqual(Planner.sourceForItem(higher.selfId, [], state), []);
const offer = { selfId: higher.selfId, price: 1, count: 1, sourceType: 'afk', town: 'Giran' };
const purchased = Planner.marketPlanForTarget(state, higher.selfId, { findMarketOffer: () => offer });
assert(purchased); assert(Planner.acquisitionTargetAllowed(state, purchased));
assert.equal(Planner.preferredTarget(state, { spots: [], findMarketOffer: item => item.selfId === higher.selfId ? offer : null })?.item.selfId,
    higher.selfId, 'the clan planner also takes the real affordable A offer');
assert.equal(Planner.acquisitionTargetAllowed(state, { ...purchased, strategy: 'direct_drop' }), false);
const board = new BoardIndex();
board.put({ id: 91, ownerId: 990472, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 92, selfId: higher.selfId, count: 1, enchant: 0, price: 1 }] });
const review = board => Economy.forState(state, { board, spots: [], npcOffersFor: () => [], caller: 'meeting_prepare',
    routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
    workshop: null, workshops: () => [], knownRecipes: [] });
const empty = review(new BoardIndex());
assert(!empty.projection.roots.some(key => key.startsWith(`power:${higher.selfId}:`)));
const available = review(board);
assert(available.projection.roots.some(key => key.startsWith(`power:${higher.selfId}:`)), 'a real affordable A offer is the exception');
assert.equal(available.network.activity.itemId, higher.selfId);
assert.equal(available.network.activity.activity, 'shopping');
const armed = { ...state, inventory: kit(40) };
for (const [id, row] of Object.entries(armed.inventory)) if (row.equippedSlots.some(slot => [7, 14].includes(slot))) delete armed.inventory[id];
const weapon = Gear.planFor({ classId: 3, level: 52 }).items.find(row => [7, 14].includes(row.slot));
armed.inventory[weapon.selfId] = { ...weapon, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [weapon.slot] };
const remaining = Progression.acquisitionAssessment(armed);
assert(remaining.required, 'a B weapon does not close armour and jewellery debt');
assert(!remaining.gaps.has(7) && !remaining.gaps.has(14));
assert.equal(Progression.acquisitionAssessment({ ...state, inventory: kit(52) }).required, false);
const paired = { ...state, inventory: kit(52) };
for (const [id, row] of Object.entries(paired.inventory)) if (row.equippedSlots.some(slot => [1, 2].includes(slot))) delete paired.inventory[id];
const cEar = Gear.planFor({ classId: 3, level: 40 }).items.find(row => row.slot === 2);
paired.inventory[856] = { selfId: 856, amount: 1, equipped: true, equippedSlots: [1], equippedCount: 1, slot: 1 };
paired.inventory[cEar.selfId] = { ...cEar, amount: 1, equipped: true, equippedSlots: [2], equippedCount: 1 };
const secondEar = Planner.preferredTarget(paired, { spots: [], findMarketOffer: item => item.selfId === 856
    ? { ...offer, selfId: 856 } : null });
assert.equal(secondEar?.item.selfId, 856, 'one B earring does not suppress acquiring the second copy');
assert.equal(secondEar.slot, 2);
for (const supported of [true, false]) {
    const solver = createSolver({ nodes: [{ key: 'gear', need: 'power', valueHours: 1, paths: [
        { kind: 'drop', activity: 'hunting', costHours: 0, readyHours: 22, acquisitionOrder: 3 },
        { kind: 'craft', activity: 'crafting', costHours: 1, executable: supported, acquisitionOrder: 1 }
    ] }], hourAdena: 1000, riskWeight: 0 });
    assert.equal(solver.rootWish('gear').plan.kind, supported ? 'craft' : 'drop',
        'craft precedes a zero-net-cost drop; an unavailable craft leaves the last-resort drop');
}
console.log('PASS B kit before absent A, affordable A market exception, B weapon follow-up and craft before rare drop');
