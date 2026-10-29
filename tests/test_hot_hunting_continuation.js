'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Decision = invoke('GameServer/Bot/AI/BotDecisionService');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const SpotTravel = invoke('GameServer/Bot/AI/BotSpotTravel');
const World = invoke('GameServer/World/World');
const town = { locX: 82992, locY: 53171, locZ: -1496 };
const primary = { id: '25_12', name: 'Original hunt', density: 12,
    minLevel: 55, maxLevel: 59, avgLevel: 57, center: { locX: 151966, locY: 74719, locZ: -3276 } };
const alternative = { ...primary, id: '13_0', name: 'Accepted detour',
    center: { locX: 82000, locY: 3200, locZ: -2880 } };
const leaf = { activity: 'hunting', spotId: primary.id };
const restores = [];
function stub(object, key, value) {
    const original = object[key]; object[key] = value;
    restores.push(() => { object[key] = original; });
}
let available = [], searchCalls = [], nextId = 972000;
stub(Spots, 'ensureIndexed', () => [primary, alternative]);
stub(Spots, 'findBestSpot', (status, options) => {
    searchCalls.push({ status, options }); return { spot: primary, score: 10 };
});
stub(Events, 'held', session => session.heldEconomy);
stub(World, 'user', { sessions: [] });
stub(World, 'npc', { spawns: [] });
stub(World, 'fetchNpcsInRadius', () => available);
stub(invoke('GameServer/Bot/BotManager'), 'sessions', []);
stub(invoke('GameServer/Geodata/GeodataEngine'), 'hasLineOfSight', () => true);
stub(invoke('GameServer/Bot/AI/PartyAwareness'), 'npcThreateningActor', () => null);
stub(invoke('GameServer/Bot/AI/HotTownRebuff'), 'syncVisit', () => null);
stub(invoke('GameServer/Bot/AI/HotTownRebuff'), 'needsVisit', () => false);
stub(invoke('GameServer/Bot/AI/BotBuffs'), 'needsNewbieRefresh', () => false);
stub(invoke('GameServer/Bot/AI/TownChatter'), 'say', () => {});
stub(Math, 'random', () => 0.75);
stub(SpotTravel, 'start', (session, _bot, spot) => {
    session.spotRelocation = { spotId: spot.id, method: 'soe_gatekeeper' };
    session.trips.push(spot.id); return true;
});
function fixture(location, chosen = leaf, stats = {}) {
    const loc = { ...location }, id = ++nextId;
    const bot = { fetchId: () => id, fetchName: () => `HuntContinuation${id}`,
        fetchLevel: () => 57, fetchClassId: () => 6, fetchRace: () => 0, fetchKarma: () => 0,
        fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ,
        fetchHp: () => 5000, fetchMaxHp: () => 5000, fetchMp: () => 500, fetchMaxMp: () => 500,
        fetchPAtk: () => 2000, fetchCollectivePAtk: () => 2000, fetchPDef: () => 2000,
        fetchCollectivePDef: () => 2000, fetchMAtk: () => 200, fetchMaxLoad: () => 100000,
        fetchIsOnline: () => true, isDead: () => false,
        state: { fetchDead: () => false, fetchTowards: () => false, fetchHits: () => false,
            fetchCasts: () => false, fetchSeated: () => false, setCasts() {} },
        backpack: { fetchItems: () => [], fetchTotalLoad: () => 0, fetchTotalAdena: () => 1000000,
            fetchTotalWeaponKind: () => 'Weapon.Sword', fetchItemFromSelfId: () => null },
        automation: { abortAll() {} }, select() {}, unselect() {},
        moveTo(move) { session.moves.push(move); }
    };
    const session = { actor: bot, plan: 'hunting', currentSpot: primary, moves: [], trips: [], attacks: [],
        coldLifeState: { characterId: id, activity: 'hunting', spotId: primary.id, loc: { ...loc },
            stats: { classId: 6, decisionSeq: 1, ...stats }, inventory: {} },
        heldEconomy: { decided: true, network: { activity: chosen }, stock: () => ({ itemId: 0, usePerHour: 0 }) } };
    bot.session = session;
    session.botStatus = { available: true, mode: 'hunting', characterId: id, classId: 6, level: 57,
        loc: { ...loc }, blockers: [], nearby: { attackableNpcs: 0, eligibleAttackableNpcs: 0 } };
    const ai = { say() {}, getRandomPhrase: () => '', getStatus: s => s.botStatus,
        executeCombat: (s, _bot, npc) => s.attacks.push(npc.fetchId()),
        getClosestTown: () => ({ name: 'Oren', x: town.locX, y: town.locY, z: town.locZ }) };
    return { session, bot, ai, loc, tick: () => Hunting.tick(session, bot, {}, ai) };
}
function npcNear(point) {
    return { fetchId: () => 990101, fetchSelfId: () => 990101, fetchName: () => 'Local mob',
        fetchLocX: () => point.locX + 100, fetchLocY: () => point.locY, fetchLocZ: () => point.locZ,
        fetchLevel: () => 57, fetchKind: () => 'Monster', fetchAttackable: () => true, isDead: () => false,
        fetchHp: () => 500, fetchMaxHp: () => 500, fetchPAtk: () => 100, fetchPDef: () => 100,
        fetchMDef: () => 100 };
}
const tests = [];
function test(name, work) { tests.push({ name, work }); }

test('an accepted cold detour continues native local combat', () => {
    const f = fixture(alternative.center, leaf, { standIn: { leaf: primary.id, ground: alternative.id } });
    f.session.currentSpot = alternative;
    f.session.coldLifeState.spotId = alternative.id;
    available = [npcNear(alternative.center)];
    f.session.botStatus.nearby = { attackableNpcs: 1, eligibleAttackableNpcs: 1 };
    assert(Sections.occupationPlanned(f.session.coldLifeState, leaf));
    assert.equal(Decision.suggest(f.session.botStatus, f.session).action, 'search_locally');
    f.tick();
    assert.deepEqual(f.session.trips, [], 'an accepted detour must not start a new field trip');
    assert.deepEqual(f.session.attacks, [990101], 'the early hunting decision must allow the local fight');
    assert.equal(f.session.currentSpot.id, alternative.id);
    assert.equal(searchCalls.length, 0, 'an accepted occupation needs no independent spot search');
});

test('a safe blue mob starts the next fight instead of a search walk', () => {
    const f = fixture(primary.center);
    available = [{ ...npcNear(primary.center), fetchLevel: () => 42,
        fetchLocX: () => primary.center.locX + 1800 }];
    f.tick();
    assert.deepEqual(f.session.attacks, [990101]);
    assert.deepEqual(f.session.moves, [], 'a nearby safe target must prevent idle wandering');
    assert.deepEqual(f.session.trips, [], 'the next fight needs no return to the spot center');
    assert(f.session.lastTargetEvaluation.score < 0);
    assert.equal(f.session.noTargetTicks, 0);
});

test('an expanded search keeps nearby mobs across the spot boundary', () => {
    const edge = { ...primary.center, locX: 155950 };
    for (const [distance, height] of [[100, 0], [2400, 1000]]) {
        const f = fixture(edge);
        f.session.noTargetTicks = 2;
        available = [{ ...npcNear(edge), fetchLocX: () => edge.locX + distance,
            fetchLocZ: () => edge.locZ + height }];
        assert.equal(Spots.containsLocation(primary, { ...edge, locX: edge.locX + distance }), false);
        f.tick();
        assert.deepEqual(f.session.attacks, [990101], 'expanding the search must retain the ordinary local radius');
        assert.deepEqual(f.session.moves, []);
    }
});

test('an expanded search does not chase distant mobs on another spot', () => {
    const edge = { ...primary.center, locX: 155950 };
    const f = fixture(edge);
    f.session.noTargetTicks = 2;
    available = [{ ...npcNear(edge), fetchLocX: () => edge.locX + 3000 }];
    f.tick();
    assert.deepEqual(f.session.attacks, []);
    assert.equal(f.session.huntingTargetScan.attackableNpcs, 0);
});

test('a stale field and stale status coordinates cannot strand the body in town', () => {
    const f = fixture(town);
    assert.equal(Spots.findCurrentSpot(town), null, 'the town has no hunting sector in this catalogue');
    f.session.botStatus.loc = { ...primary.center };
    assert.equal(Decision.suggest(f.session.botStatus, f.session).spot?.id, primary.id);
    f.tick();
    assert.deepEqual(f.session.trips, [primary.id], 'the real actor location requires a return route');
    assert.equal(searchCalls.length, 0, 'a selected hunt keeps its destination');
});

test('returning from town resumes the accepted detour rather than the full primary field', () => {
    const f = fixture(town, leaf, { standIn: { leaf: primary.id, ground: alternative.id } });
    f.session.currentSpot = alternative;
    assert.equal(Decision.suggest(f.session.botStatus, f.session).spot?.id, alternative.id);
    f.tick();
    assert.deepEqual(f.session.trips, [alternative.id]);
});

test('an unrelated old detour cannot override a newly selected hunt', () => {
    const f = fixture(alternative.center, leaf, { standIn: { leaf: 'old_goal', ground: alternative.id } });
    f.session.currentSpot = alternative;
    assert.equal(Decision.suggest(f.session.botStatus, f.session).spot?.id, primary.id);
});

test('a first worker answer is awaited separately from an accepted empty occupation', () => {
    const f = fixture(town, null);
    f.session.pendingFarmDepartureAnnouncement = true;
    f.session.heldEconomy.decided = false;
    assert.equal(Decision.suggest(f.session.botStatus, f.session).action, 'search_locally');
    assert.equal(searchCalls.length, 0);
});

test('a completed shopping visit with an accepted null leaf starts the farming route', async () => {
    const f = fixture(town, null);
    f.session.plan = 'shopping';
    f.session.shoppingLiveShotStopChecked = true;
    f.session.shoppingTarget = { town: 'Oren' };
    f.session.dataSendToOthers = () => {};
    const timers = [], restoreAt = restores.length;
    try {
        stub(global, 'setTimeout', fn => { timers.push(fn); return 1; });
        stub(Events, 'raiseDecision', () => {});
        stub(invoke('GameServer/Bot/Population/BotLifeState'), 'hotRow', () => ({ phase: 'hot' }));
        const Shots = invoke('GameServer/Inventory/ShotStock');
        stub(Shots, 'planForActor', () => ({ selfId: 1835 }));
        stub(Shots, 'purchaseActorRestock', async () => ({ ok: true, delta: 0, cost: 0 }));
        const Restock = invoke('GameServer/Bot/Economy/NpcRestockPlan');
        stub(Restock, 'quoteFor', () => null);
        stub(Restock, 'purchaseForActor', async () => ({ ok: true, receipts: [] }));
        const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
        stub(Potions, 'purchasePotionFor', () => ({ selfId: 1060 }));
        stub(Potions, 'localNpcPrice', () => 0);
        stub(invoke('GameServer/Network/Response'), 'skillStarted', () => Buffer.alloc(0));
        stub(invoke('GameServer/Bot/AI/BotEventJournal'), 'record', async () => {});
        Shopping.scheduleRestock(f.session, f.bot, {}, f.ai);
        assert.equal(timers.length, 2);
        await timers.shift()(); await timers.shift()();
        assert.equal(f.session.plan, 'hunting');
        assert.equal(f.session.pendingFarmDepartureAnnouncement, true);
        // The worker may accept no new wish after the purchase. The town
        // continuation must still dispatch real farming travel in HuntingState.
        f.session.currentSpot = null;
        f.tick();
        assert.deepEqual(f.session.trips, [primary.id]);
        assert.equal(searchCalls.length, 1);
        assert.deepEqual(searchCalls[0].status.loc, town);
        assert.equal(f.session.pendingFarmDepartureAnnouncement, undefined, 'departure is consumed once');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('an accepted empty occupation in the field keeps local hunting', () => {
    const f = fixture(alternative.center, null);
    f.session.currentSpot = alternative;
    assert.equal(Decision.suggest(f.session.botStatus, f.session).action, 'search_locally');
    assert.equal(searchCalls.length, 0, 'an empty NPC scan in the field is not a new route request');
});

test('an unreachable sale route yields to local hunting during its retry', () => {
    const f = fixture(primary.center, null);
    const restoreAt = restores.length;
    try {
        f.session.plan = 'shopping';
        f.session.shoppingTarget = { actorId: 12345, name: 'Remote buyer', town: 'Giran',
            locX: 83510, locY: 148120, locZ: -3400 };
        f.session.shoppingEquipmentPlanChecked = true;
        f.session.shoppingWarehouseDone = true;
        f.session.shoppingLiveBuyerChecked = true;
        stub(invoke('GameServer/Bot/AI/TownNpcApproach'), 'plan', () => null);
        stub(invoke('GameServer/Bot/AI/CompanionNavigationRecovery'), 'move', () => ({ status: 'exhausted' }));
        Shopping.tick(f.session, f.bot, {}, f.ai);
        assert.equal(f.session.plan, 'hunting');
        assert.equal(f.session.shoppingTarget, undefined);
        assert(f.session.townTravelRetryAt > Date.now(), 'a plain sale route must also establish a retry');
        const travel = invoke('GameServer/Bot/AI/BotTownTravel');
        assert.equal(travel.request(f.session, f.bot, f.ai, 'Sell loot.'), 'deferred');
        assert.deepEqual(f.session.moves, [], 'a failed route cannot restart on the next tick');
        stub(invoke('GameServer/Bot/Economy/ItemDisposition'), 'inventoryCleanupNeed',
            () => ({ reason: 'npc_only_inventory' }));
        available = [npcNear(primary.center)];
        f.tick();
        assert.equal(f.session.plan, 'hunting', 'forced cleanup must let the bot hunt while its route waits');
        assert.deepEqual(f.session.attacks, [990101]);
        assert.deepEqual(f.session.moves, []);
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('an accepted empty occupation can leave town without a remembered field or announcement', () => {
    const f = fixture(town, null);
    f.session.currentSpot = null;
    f.tick();
    assert.deepEqual(f.session.trips, [primary.id]);
    assert.equal(searchCalls.length, 1);
});

test('an unavailable default route is searched once per tick and observes the movement cooldown', () => {
    const f = fixture(town, null);
    f.session.currentSpot = null;
    const original = Spots.findBestSpot;
    try {
        Spots.findBestSpot = (status, options) => { searchCalls.push({ status, options }); return null; };
        f.tick();
        assert.deepEqual(f.session.trips, []);
        assert.equal(searchCalls.length, 1, 'the empty NPC scan must reuse the same route verdict');
        f.session.lastSpotMoveAt = Date.now();
        searchCalls = [];
        assert.equal(Decision.suggest(f.session.botStatus, f.session).reason, 'spot_move_cooldown');
        assert.equal(searchCalls.length, 0);
    } finally { Spots.findBestSpot = original; }
});

test('a deferred purchase recovers from an empty field without losing its wish or cancelling the trip', () => {
    const purchase = { activity: 'shopping', rootKey: 'power:148:7', itemId: 1459,
        amount: 24, town: 'Aden', kind: 'buy', sourceType: 'afk' };
    const f = fixture(alternative.center, purchase);
    f.session.currentSpot = alternative;
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/Economy/ColdMarketService'), 'canTravelForPurchase', () => false);
        available = [];
        f.tick();
        assert.deepEqual(f.session.trips, [], 'an ordinary empty scan must not reroute a deferred errand');
        assert.equal(searchCalls.length, 0);
        f.session.noTargetTicks = 3;
        f.tick();
        assert.deepEqual(f.session.trips, [primary.id], 'sustained empty live scans must choose safe recovery ground');
        assert.equal(searchCalls.length, 1);
        assert.equal(searchCalls[0].options.allowEasierSpots, true);
        assert(searchCalls[0].options.matchupProfiles.length, 'the route must be checked against the live kit');
        assert.equal(f.session.heldEconomy.network.activity, purchase, 'the acquisition wish stays held');
        assert.equal(f.session.spotRelocation.deferredOccupation, Decision.occupationKey(purchase));
        // A worker can republish the same logical wish in another object.
        f.session.heldEconomy.network.activity = { ...purchase };
        f.tick();
        assert.deepEqual(f.session.trips, [primary.id], 'the same deferred wish must let its recovery journey finish');
        assert(f.session.spotRelocation);
        assert.deepEqual(f.session.attacks, []);
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('deferred scroll restocking can recover below the ordinary hunting band', () => {
    const purchase = { activity: 'shopping', rootKey: 'stock:scrolls', itemId: 736,
        amount: 1, town: 'Aden', kind: 'buy', sourceType: 'npc' };
    const f = fixture(alternative.center, purchase);
    f.session.currentSpot = alternative;
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/Economy/ColdMarketService'), 'canTravelForPurchase', () => false);
        stub(Spots, 'findBestSpot', (status, options) => {
            searchCalls.push({ status, options });
            return options.minLevelGap === 1 - status.level ? { spot: primary } : null;
        });
        f.session.noTargetTicks = 3;
        f.session.huntingTargetScan = { eligibleAttackableNpcs: 0 };
        f.tick();
        assert.deepEqual(f.session.trips, [primary.id], 'consumables must not trap a hunter on unsafe ground');
        assert.equal(searchCalls.length, 2);
        assert.equal(searchCalls[1].options.minLevelGap, 1 - f.bot.fetchLevel());
        assert(searchCalls[1].options.matchupProfiles.length, 'easier ground still needs the real survival profile');
        assert.equal(f.session.heldEconomy.network.activity, purchase);
        f.tick();
        assert.deepEqual(f.session.trips, [primary.id], 'the deferred supply wish must allow its recovery trip to finish');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('a deferred errand with no recovery route retries on the movement cooldown', () => {
    const f = fixture(alternative.center, { activity: 'shopping', itemId: 1459, amount: 24, town: 'Aden' });
    f.session.currentSpot = alternative;
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/Economy/ColdMarketService'), 'canTravelForPurchase', () => false);
        stub(Spots, 'findBestSpot', (status, options) => { searchCalls.push({ status, options }); return null; });
        f.session.noTargetTicks = 3;
        f.session.huntingTargetScan = { eligibleAttackableNpcs: 0 };
        f.tick();
        f.tick();
        assert.equal(searchCalls.length, 2, 'both recovery bands are checked once within the movement cooldown');
        assert.deepEqual(f.session.trips, []);
        assert.equal(f.session.heldEconomy.network.activity.activity, 'shopping');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('a pending bounded visibility scan keeps ownership until its candidates are checked', () => {
    const purchase = { activity: 'shopping', itemId: 1459, amount: 24, town: 'Aden' };
    const f = fixture(alternative.center, purchase);
    f.session.deferredOccupation = Decision.occupationKey(purchase);
    f.session.noTargetTicks = 4;
    f.session.huntingTargetScan = { eligibleAttackableNpcs: 10 };
    f.session.huntTargetScanPending = true;
    assert.equal(Decision.suggest(f.session.botStatus, f.session).action, 'continue_occupation');
    assert.equal(searchCalls.length, 0, 'a partially checked scan is not evidence of an empty field');
});

test('a completed blocked visibility scan cannot pin a deferred errand to an unreachable field', () => {
    const f = fixture(alternative.center, { activity: 'shopping', itemId: 1459, amount: 24, town: 'Aden' });
    f.session.currentSpot = alternative;
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/Economy/ColdMarketService'), 'canTravelForPurchase', () => false);
        stub(invoke('GameServer/Geodata/GeodataEngine'), 'hasLineOfSight', () => false);
        available = [npcNear(alternative.center)];
        for (let i = 0; i < 4; i++) f.tick();
        assert.deepEqual(f.session.attacks, []);
        assert(f.session.huntingTargetScan.eligibleAttackableNpcs > 0, 'the ranked mob exists, but is hidden behind a wall');
        assert.deepEqual(f.session.trips, [primary.id], 'completed empty visibility scans must allow recovery');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('a deferred purchase still hunts a safe local mob without taking a recovery trip', () => {
    const f = fixture(primary.center, { activity: 'shopping', itemId: 1459, amount: 24, town: 'Aden' });
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/Economy/ColdMarketService'), 'canTravelForPurchase', () => false);
        available = [npcNear(primary.center)];
        f.tick();
        assert.deepEqual(f.session.attacks, [990101]);
        assert.deepEqual(f.session.trips, []);
        assert.equal(searchCalls.length, 0);
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('deferred scroll restocking can hunt a safe local mob below the ordinary level floor', () => {
    const f = fixture(primary.center, { activity: 'shopping', rootKey: 'stock:scrolls',
        itemId: 736, amount: 1, town: 'Aden' });
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/Economy/ColdMarketService'), 'canTravelForPurchase', () => false);
        available = [{ ...npcNear(primary.center), fetchLevel: () => f.bot.fetchLevel() - 16 }];
        f.tick();
        assert.deepEqual(f.session.attacks, [990101], 'a proven-safe local fight beats another empty wander');
        assert.deepEqual(f.session.trips, []);
        assert.deepEqual(f.session.moves, []);
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('route retries, survival and explicit non-hunting work keep their priority', () => {
    const f = fixture(town);
    f.session.spotRetryAfter = { [primary.id]: Date.now() + 60000 };
    assert.equal(Decision.suggest(f.session.botStatus, f.session).action, 'search_locally');
    f.session.spotRetryAfter = {};
    f.session.lastSpotMoveAt = Date.now();
    assert.equal(Decision.suggest(f.session.botStatus, f.session).action, 'search_locally');
    assert.equal(Decision.suggest({ ...f.session.botStatus, blockers: ['low_hp'] }, f.session).action, 'rest');
    f.session.heldEconomy.network.activity = { activity: 'shopping', town: 'Oren' };
    assert.equal(Decision.suggest(f.session.botStatus, f.session).action, 'continue_occupation');
});

(async () => {
    let failed = 0;
    try {
        for (const { name, work } of tests) {
            available = []; searchCalls = [];
            try { await work(); console.log(`PASS ${name}`); }
            catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
        }
    } finally { restores.reverse().forEach(restore => restore()); }
    if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
