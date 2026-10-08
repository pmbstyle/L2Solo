'use strict';
process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Visit = require('../src/GameServer/Bot/Economy/TownVisitInterval');
const Walk = require('../src/GameServer/Bot/Economy/WalkBack');
const Trip = invoke('GameServer/Bot/Population/ColdTrip');
const Routes = invoke('GameServer/Bot/Travel/TravelRoutes');
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
const deps = { spots, knowledgeEnabled: false };
const warrior = { characterId: 718001, level: 30, phase: 'hot', activity: 'hunting', adena: 100000,
    stats: { classId: 1, exp: Data.experience[29] + 1 }, inventory: {}, loc: {},
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
for (const [, items] of Providers.gearCandidates(warrior)) {
    const item = items[0]; if (item) warrior.inventory[item.selfId] = { selfId: item.selfId,
        amount: 1, equipped: true, equippedCount: 1, slot: Number(item.etc.slot), enchant: 0 };
}
const native = Economy.basics(warrior, deps), stock = native.stock('shots');
// ARCH-NOTE: the validated table yields 1728.4568/h; use its exact rate and ceil, rather than rounding the fixture to the prose example.
assert.equal(Math.round(stock.usePerHour), 1728);
const use = stock.usePerHour;
const withShots = Table.value(native.bestSpotId, native.tableRole, 30, true);
const withoutShots = Table.value(native.bestSpotId, native.tableRole, 30, false);
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
// ARCH-NOTE: empty positive-use kit stacks consume their future slots while
// sizing E9's interval, so a refill does not sell itself back to the NPC.
const plannedKitSlots = Number(stock.usePerHour > 0 && !warrior.inventory[stock.itemId]?.amount)
    + Number(native.stock('potions').usePerHour > 0 && !warrior.inventory[native.stock('potions').itemId]?.amount);
const freeSlots = Math.max(0, Floor.inventoryLimit(0) - Floor.stateInventory(warrior, Data.items).slots - plannedKitSlots);
const noHistoryT = withShots.stacks === null ? 2 : withShots.stacks === 0 ? 24
    : Math.max(.5, Math.min(24, freeSlots / withShots.stacks));
const b = 1 - withoutShots.exp / withShots.exp;
assert(b >= withShots.shots * stock.unitPrice / native.hourAdena);
for (const commitment of [.1, .9]) {
    const state = { ...warrior, stats: { ...warrior.stats, persona: { traits: { commitment } } } };
    const own = Economy.basics(state, deps).stock('shots');
    assert.equal(own.target, Math.ceil(use * noHistoryT)); assert.equal(own.targetHours, noHistoryT);
    assert.equal(own.benefitHours, b * noHistoryT);
}
for (const [visitEvery, hours] of [[[22, 4], 4], [[10, 0], noHistoryT], [[22, 30], 24], [[22, .1], .5]]) {
    const own = Economy.basics({ ...warrior, stats: { ...warrior.stats, visitEvery } }, deps).stock('shots');
    assert.equal(own.targetHours, hours); assert.equal(own.target, Math.ceil(use * hours));
}
const cached = Economy.forState(warrior, deps);
const changed = Economy.forState({ ...warrior, stats: { ...warrior.stats, visitEvery: [22, 4] } }, deps);
assert.notEqual(changed, cached, 'a visit interval change invalidates the derived stock');
assert.equal(changed.stock('shots').target, Math.ceil(use * 4));
const session = { coldLifeState: { stats: { playedHours: 10 } } };
for (const [hour, expected] of [[10, [10, 0]], [13, [13, 3]], [18, [18, 4]], [22, [22, 4]]]) {
    session.coldLifeState.stats.playedHours = hour;
    Events.raiseDecision(session, 'town');
    assert.deepEqual(session.coldLifeState.stats.visitEvery, expected);
}
assert.deepEqual(Visit.arrived(session.coldLifeState.stats), [22, 4], 'repeated end of the same visit stores no zero interval');

const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
async function coldVisits() {
    let state = { ...warrior, phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
        // This clock-only fixture has no unpaid stock need; actual merchant
        // payment/delivery is exercised by test_npc_purchase_consumers.
        inventory: { ...warrior.inventory, [stock.itemId]: { selfId: stock.itemId, amount: stock.target },
            736: { selfId: 736, amount: 2 },
            [native.stock('potions').itemId]: { selfId: native.stock('potions').itemId,
                amount: Math.ceil(native.stock('potions').usePerHour * 24) } },
        stats: { ...warrior.stats, playedHours: 10 } };
    state = await ColdMarket.finishTownErrands(state); assert.deepEqual(state.stats.visitEvery, [10, 0]);
    state = await ColdMarket.finishTownErrands({ ...state, stats: { ...state.stats, playedHours: 13 } });
    assert.deepEqual(state.stats.visitEvery, [13, 3]);
}

const poor = { ...warrior, characterId: 718002, spotId: native.bestSpotId,
    stats: { ...warrior.stats, huntEfficiency: [{ spotId: native.bestSpotId,
        signature: Hunt.signature(warrior), at: Date.now(), samples: 3,
        cycleMs: 3600000, exp: withShots.exp, kills: withShots.kills, adena: 1, loot: 0 }] } };
const poorContext = Economy.forState(poor, deps);
assert(Math.abs(poorContext.hunt.perHour - 1) < 1e-12);
assert.equal(poorContext.stock('shots').usePerHour, 0);
assert.equal(poorContext.kitCost(stock.itemId), 0);
assert(!poorContext.projection.nodes.some(row => row.key === 'stock:shots'));
const noShotReserve = poorContext.stock('potions').survivalMissing * poorContext.stock('potions').unitPrice
    + poorContext.price(736);
assert.equal(poorContext.survivalReserve, noShotReserve);

const plan = Trip.spotPlan, honest = Config.coldHonestTravel;
try {
    const center = { locX: 88000, locY: 151904, locZ: -3400 };
    const probe = [{ id: 'return-probe', center }];
    let calls = 0;
    Trip.spotPlan = (...args) => { calls++; return plan(...args); };
    Walk.reset(); Config.coldHonestTravel = true;
    const walk = Walk.hours('return-probe', warrior, probe);
    assert(walk > 0);
    assert.equal(calls, 1);
    for (let i = 0; i < 100; i++) assert.equal(Walk.hours('return-probe', warrior, probe), walk);
    assert.equal(calls, 1, 'a hundred builds reuse the route map');
    const expOnly = Valuation.deathHours(warrior, { expPerHour: native.hunt.expPerHour, walkBackHours: 0 });
    const returned = Valuation.deathHours(warrior, { expPerHour: native.hunt.expPerHour, walkBackHours: walk });
    assert(Math.abs(returned - expOnly - walk) < 1e-12);
    Config.coldHonestTravel = false;
    assert.equal(Walk.hours('return-probe', warrior, probe), 25 / 3600);
    assert.equal(Walk.hours('return-probe', { stats: { karma: 100 } }, probe),
        Trip.runMs(Routes.landingTown(center), center) / 3600000);
    assert.equal(Walk.hours(null, warrior, probe), 0);
    assert.equal(Walk.hours('unknown', warrior, probe), 0); assert.equal(Walk.summary().missing, 1);
    calls = 0; Walk.reset(); Walk.hours(spots[0].id, warrior, spots);
    assert.equal(calls, spots.length); assert(Walk.summary().buildMs < 1000);
    for (let i = 0; i < 100; i++) Economy.basics(warrior, deps);
    assert.equal(calls, spots.length);
    console.log(`Stock/death: native 1728/h, profitable-shot gate, town clocks, cached ${spots.length} return routes in ${Walk.summary().buildMs.toFixed(1)} ms passed`);
} finally { Trip.spotPlan = plan; Config.coldHonestTravel = honest; Walk.reset(); }
coldVisits().then(() => { assert.equal(invoke('Database').isReady(), false); console.log('Cold visit end interval writer passed'); })
    .catch(error => { console.error(error); process.exitCode = 1; });
