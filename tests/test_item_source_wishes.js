'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Catalog = invoke('GameServer/Items/ItemAcquisitionCatalog');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const FirstPrice = invoke('GameServer/Bot/Economy/FirstPrice');
const Wishes = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
// Frozen audited C4 rows, rather than a policy blacklist: production discovers
// their origins from actual data. A legitimate new source must change this test.
const suspects = require('./fixtures/source_less_c4_gear.json');
assert.equal(suspects.length, 392);
const forbidden = new Set(suspects);
const nominated = new Set();
for (let classId = 0; classId <= 118; classId++) {
    const state = { characterId: 990000 + classId, level: 78, stats: { classId }, inventory: {} };
    for (const items of Wishes.gearCandidates(state).values()) for (const item of items) {
        assert(!forbidden.has(Number(item.selfId)), `class ${classId} nominated source-less ${item.selfId}`);
        nominated.add(Number(item.selfId));
    }
}
for (const id of suspects) assert.equal(Catalog.hasSource(id), false, `audited item ${id} has no native origin`);
for (const id of [97, 3]) {
    assert(Catalog.hasSource(id), `ordinary item ${id} stays obtainable`);
    assert(nominated.has(id), `ordinary item ${id} stays in compatible kits`);
    assert(FirstPrice.firstPrice(id, { spots: [] }), `ordinary item ${id} has a price`);
}
const board = new BoardIndex();
for (const id of [1303, 1305]) {
    for (const storeType of [1, 3]) board.put({ id: id * 10 + storeType, storeType, ownerId: 500,
        town: 'Giran', botOwned: false, lines: [{ id, selfId: id, count: 1, price: 1 }] });
    assert.equal(FirstPrice.firstPrice(id, { spots: [] }), null, 'GM price cannot create an origin');
    assert.equal(FirstPrice.cachedFirstPrice(id, { spots: [] }), null);
}
const fixture = require('./fixtures/wish_spot_native_state.json');
const routes = Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
    () => [true, 0, 0]);
for (const id of [1303, 1305]) {
    const state = structuredClone(fixture);
    state.stats.equipmentPlan = { target: { selfId: id }, strategy: 'market', status: 'active',
        grade: Planner.gradeForLevel(state.level), plannedForLevel: state.level,
        rateModelVersion: Planner.RATE_MODEL_VERSION, rateProfileSignature: Planner.rateProfileSignature() };
    state.stats.wishFocus = [`power:${id}:7`];
    state.stats.economy = { watchList: [{ selfId: id, amount: 1, price: 1 }] };
    const before = structuredClone(state.inventory);
    Economy.reset();
    const context = Economy.forState(state, { board, spots: [], timestamp: 1791335800000,
        npcOffersFor: () => [{ selfId: id, price: 1 }], routeRows: routes, knownRecipes: [] });
    assert(!context.projection.nodes.some(node => Number(node.object?.itemId) === id || node.key === `item:${id}`),
        'fake public/NPC offer and retained focus cannot create a node');
    assert(!context.network.queue.some(node => Number(node.object?.itemId) === id));
    const previous = Planner.replanContextFor(state, state.stats.equipmentPlan, 1791335800000);
    assert.equal(previous.planCurrent, false); assert.equal(previous.routeCurrent, false);
    assert.equal(previous.invalidSource.reason, 'unsupported_item_source');
    assert.deepEqual(state.inventory, before, 'admission preserves existing possessions');
}
const starter = { characterId: 990999, level: 10, stats: { classId: 0 }, inventory: {
    2369: { selfId: 2369, amount: 1, equipped: true, slot: 7, equippedSlots: [7] } } };
assert.equal(Catalog.hasSource(2369), true, 'authored character creation is a real origin');
assert.equal(Catalog.hasNonRaidSource(2369), true, 'creation does not require a raid');
for (const id of [6, 10, 2368, 2369, 2370]) {
    assert.deepEqual(Planner.sourceForItem(id, [], starter), [], 'origin admission invents no farming route');
    assert.deepEqual(invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(id), [],
        'creation admission invents no repeatable NPC supplier');
}
assert(Planner.isRealCatalogItem(Data.items.find(item => item.selfId === 2369)), 'starter remains valid owned equipment');
assert.equal(Wishes.worn(starter, 7).selfId, 2369);
assert.equal(Planner.combatReadiness(starter).hasWeapon, true, 'owned starter still participates in combat readiness');
// A raid is a real world origin but is not a solo acquisition forecast.
const raidId = 6364;
assert(Catalog.hasSource(raidId)); assert.equal(Catalog.hasNonRaidSource(raidId), false);
assert(FirstPrice.firstPrice(raidId, { spots: [] }), 'raid loot retains a legal market valuation');
function raidReview(supply) {
    const state = structuredClone(fixture), raidBoard = new BoardIndex();
    state.level = 78; state.adena = 1000000000; state.inventory = {};
    state.stats = { classId: 90, equipmentPlan: { target: { selfId: raidId } }, wishFocus: [`power:${raidId}:7`] };
    if (supply.startsWith('quote')) raidBoard.put({ id: 990100, storeType: 1, ownerId: 500, town: 'Giran',
        botOwned: false, lines: [{ id: 1, selfId: raidId, count: 1, price: 1 }] });
    if (supply === 'owned') state.inventory[raidId] = { selfId: raidId, amount: 1, equipped: true, slot: 7 };
    Economy.reset();
    return Economy.forState(state, { board: raidBoard, spots: [], timestamp: 1791335800000,
        npcOffersFor: () => [], routeRows: supply === 'quote_unknown' ? routes.map(() => [false, null, null]) : routes, knownRecipes: [],
        persona: { primaryDrive: 'progression', understanding: 1, traits: { ambition: 1, caution: 0.5 } } });
}
const unquotedRaid = raidReview('none');
assert(!unquotedRaid.projection.nodes.some(node => node.key === `item:${raidId}`
    || Number(node.object?.itemId) === raidId), 'positive raid-loot price is no personal supply');
assert(!unquotedRaid.network.queue.some(node => Number(node.object?.itemId) === raidId));
const ordinaryWeapons = Wishes.gearCandidates(unquotedRaid.state, unquotedRaid, undefined, id => Catalog.hasNonRaidSource(id)).get(7) || [];
assert(ordinaryWeapons.length > 0 && ordinaryWeapons.every(item => Catalog.hasNonRaidSource(item.selfId)),
    'unquoted raid gear cannot screen the ordinary weapon alternative');
const unknownRoad = raidReview('quote_unknown');
assert(!unknownRoad.projection.nodes.some(node => node.key === `item:${raidId}`),
    'an unreachable public supplier does not admit a solo raid wish');
const quotedRaid = raidReview('quote');
assert(quotedRaid.projection.nodes.some(node => node.key === `item:${raidId}`), 'real finite supplier permits acquiring raid loot');
assert(quotedRaid.projection.nodes.some(node => Number(node.object?.itemId) === raidId), 'supplied raid loot may improve equipment');
const heldRaid = raidReview('owned');
assert.equal(Planner.combatReadiness(heldRaid.state).hasWeapon, true, 'owned raid equipment remains usable');
assert.equal(heldRaid.state.inventory[raidId].amount, 1);
const ClanEconomy = invoke('GameServer/Clan/ClanEconomyContext');
const clan = { id: 990900, level: 3, leaderId: 990901,
    members: [{ characterId: 990901, level: 78, stats: {}, adena: 0, inventory: {} }], state: {} };
const clanContext = ClanEconomy.build(clan, {
    warehouse: [{ selfId: 57, amount: 1000000, reservedAmount: 0 }],
    memberContexts: [{ inputKey: 'source-admission', clanHorizon: 10, hunt: { perHour: 10000 },
        persona: { traits: { empathy: 1, ambition: 1 } }, itemUsefulness: () => 100 }],
    equipment: [1303, 6724].map(itemId => ({ memberId: 990901, costHours: 2,
        plan: { target: { selfId: itemId }, strategy: 'raid', status: 'active', market: { price: 1000 } } }))
});
assert(!clanContext.network.queue.some(wish => Number(wish.object?.itemId) === 1303),
    'positive member value cannot admit GM equipment into the clan purse');
assert(clanContext.network.queue.some(wish => Number(wish.object?.itemId) === 6724),
    'prepared clan acquisition retains legitimate raid-only equipment');
ClanEconomy.reset();
console.log('PASS raid-only price cannot become solo desire; actual supplier and owned equipment remain legal');
console.log('PASS all 392 source-less C4 gear, fake offers, retained wishes/plans, ordinary gear and owned starter');
