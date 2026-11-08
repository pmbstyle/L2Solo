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
const Situations = invoke('GameServer/Bot/Situations');
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
// Main never chooses a spot (situations.md §8): it walks to the spot its held
// decisions name or raises the earning spot's situation. searchCalls: the earning
// spot searches (none on main).
let available = [], searchCalls = [], nextId = 972000;
stub(Spots, 'ensureIndexed', () => [primary, alternative]);
const IncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const nativeSearch = IncomeRoute.search;
stub(IncomeRoute, 'search', (...args) => { searchCalls.push(args); return nativeSearch(...args); });
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
// The held earning answer naming a spot (EquipmentIncomeRoute.answerOf's layout), its decision not woken.
const holds = spot => ({ woken: 0, earning: { spotId: spot.id, shots: true, income: 1000, expected: 1000, earning: 1000, error: 0, at: 1 } });
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
    const session = { actor: bot, accountId: 'bot_hunt_continuation', plan: 'hunting', currentSpot: primary, moves: [], trips: [], attacks: [],
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

test('a visit\'s end sends a collector to its gear plan\'s source, as the worker\'s route does', () => {
    const plan = { status: 'active', strategy: 'direct_drop', next: { spotId: alternative.id } };
    const f = fixture(town, null, { ...holds(primary), equipmentPlan: { ...plan, routedSpotId: alternative.id } });
    f.session.pendingFarmDepartureAnnouncement = true;
    assert.equal(Decision.suggest(f.session.botStatus, f.session).spot?.id, alternative.id,
        'the source the route takes before the held earning answer');
    const refused = fixture(town, null, { ...holds(primary), equipmentPlan: plan });
    refused.session.pendingFarmDepartureAnnouncement = true;
    assert.equal(Decision.suggest(refused.session.botStatus, refused.session).spot?.id, primary.id,
        'a source the route refuses: the held earning answer');
    assert.equal(searchCalls.length, 0, 'main searches no spot');
});

test('a body\'s visit end reads its place and party as a far row\'s does', () => {
    // Death pressure at the spot it hunted rules that spot out, as for a far bot.
    const pressed = fixture(town, null, { ...holds(primary),
        spotRisk: { version: 2, spotId: primary.id, windowFights: 3, windowWins: 0, windowDeaths: 2 } });
    pressed.session.pendingFarmDepartureAnnouncement = true;
    assert.equal(Decision.suggest(pressed.session.botStatus, pressed.session).action, 'search_locally',
        'not back to the spot that killed it');
    // A party member's hunt is its party's: its own earning answer names none.
    const member = fixture(town, null, holds(primary));
    member.session.pendingFarmDepartureAnnouncement = true;
    member.session.hotBackgroundPartyId = 'hunt-continuation-party';
    assert.equal(Decision.suggest(member.session.botStatus, member.session).action, 'search_locally',
        'a party member is not sent to its solo answer');
});

test('a completed shopping visit with an accepted null leaf starts the farming route', async () => {
    const f = fixture(town, null, holds(primary));
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
        assert.deepEqual(f.session.trips, [primary.id], 'the bot returns to its held earning answer');
        assert.equal(searchCalls.length, 0, 'main searches no spot');
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
    const f = fixture(town, null, holds(primary));
    f.session.currentSpot = null;
    f.tick();
    assert.deepEqual(f.session.trips, [primary.id]);
    assert.equal(searchCalls.length, 0);
});

test('with no held earning spot, or one it could not reach, a body in town waits for its answer', () => {
    const none = fixture(town, null);
    none.session.currentSpot = null;
    none.tick();
    assert.deepEqual(none.session.trips, []);
    assert.equal(Decision.suggest(none.session.botStatus, none.session).reason, 'no_hunting_route');
    const marked = fixture(town, null, { ...holds(primary), spotMarks: [{ spotId: primary.id, reason: 'walk_timeout', answer: 1 }] });
    marked.session.currentSpot = null;
    marked.tick();
    assert.deepEqual(marked.session.trips, [], 'a spot it could not reach is not walked to again');
    assert.equal(searchCalls.length, 0, 'and main searches no other');
});

test('a held answer with no spot asks once more, then rests in town: never a loop', () => {
    const empty = at => ({ woken: 0, earning: { spotId: null, shots: true, income: 0, expected: 0, earning: 0, error: 0, at } });
    const f = fixture(town, null, empty(1));
    f.session.currentSpot = null;
    // The body's stats are replaced at each write (DecisionEvents.replaceStats): read them fresh.
    const stats = () => f.session.coldLifeState.stats, raised = () => Number(stats().situationSeq || 0);
    const noSpot = () => Situations.counts().raised['earning:no_spot'] || 0;
    assert.equal(Decision.suggest(f.session.botStatus, f.session).reason, 'no_hunting_route');
    assert(Situations.woken(stats(), 'earning_spot'), 'it asks the decision again (spot_empty)');
    assert.equal(raised(), 1);
    Decision.suggest(f.session.botStatus, f.session);
    assert.equal(raised(), 1, 'once per answer');
    const before = noSpot();
    f.session.coldLifeState = { ...f.session.coldLifeState, stats: { ...stats(), ...empty(2) } }; // the answer to its ask: still none
    assert.equal(Decision.suggest(f.session.botStatus, f.session).reason, 'no_hunting_spot', 'it rests in town');
    Decision.suggest(f.session.botStatus, f.session);
    assert.equal(noSpot(), before + 1, 'counted once');
    assert.equal(raised(), 1, 'and asks no more');
    assert.equal(searchCalls.length, 0);
});

test('a body that arrived on a neighbouring cell of its spot does not walk again', () => {
    // A spot whose center lies just past a cell border: the body on the cell before it stands on its ground.
    const border = { ...primary, id: '26_12', name: 'Border field', center: { locX: 156200, locY: 74719, locZ: -3276 } };
    const restoreAt = restores.length;
    try {
        stub(Spots, 'ensureIndexed', () => [primary, alternative, border]);
        const f = fixture({ ...border.center, locX: 155700 }, { activity: 'hunting', spotId: border.id });
        assert.equal(Spots.findCurrentSpot(f.loc)?.id, primary.id, 'fixture: its cell is the neighbour\'s');
        assert.notEqual(Decision.suggest(f.session.botStatus, f.session).action, 'move_to_spot', 'it has arrived: no relocation');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('a deferred purchase recovers from an empty field without losing its wish or cancelling the trip', () => {
    const purchase = { activity: 'shopping', rootKey: 'power:148:7', itemId: 1459,
        amount: 24, town: 'Aden', kind: 'buy', sourceType: 'afk' };
    const f = fixture(alternative.center, purchase, holds(primary));
    f.session.currentSpot = alternative;
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/AI/BotTownTravel'), 'request', () => 'deferred'); // its trip deferred (a fight, its road)
        // Its ground admits none of its fights (the hunt's own look, groundLook).
        stub(invoke('GameServer/Bot/AI/BotTargetMatchup'), 'admitsNone', () => true);
        available = [];
        f.tick();
        assert.deepEqual(f.session.trips, [], 'an ordinary empty scan must not reroute a deferred errand');
        assert.equal(searchCalls.length, 0);
        f.session.noTargetTicks = 3;
        f.tick();
        const stats = f.session.coldLifeState.stats;
        assert(Situations.woken(stats, 'earning_spot'), 'sustained empty scans on ground that admits none raise spot_empty');
        assert.equal(stats.emptyGround, alternative.id, 'once a stay');
        assert.deepEqual(f.session.trips, [primary.id], 'and it walks to its held earning answer');
        assert.equal(searchCalls.length, 0, 'main searches no recovery ground');
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

test('a deferred errand whose held answer is its own empty ground raises once and stays', () => {
    const f = fixture(alternative.center, { activity: 'shopping', itemId: 1459, amount: 24, town: 'Aden' }, holds(alternative));
    f.session.currentSpot = alternative;
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/AI/BotTownTravel'), 'request', () => 'deferred'); // its trip deferred (a fight, its road)
        stub(invoke('GameServer/Bot/AI/BotTargetMatchup'), 'admitsNone', () => true);
        f.session.huntingTargetScan = { eligibleAttackableNpcs: 0 };
        for (let n = 0; n < 2; n++) {
            f.session.noTargetTicks = 3;
            f.tick();
        }
        assert.equal(f.session.coldLifeState.stats.situationSeq, 1, 'spot_empty is raised once a stay');
        assert.deepEqual(f.session.trips, [], 'its held answer is where it stands: it waits for the next one');
        assert.equal(searchCalls.length, 0);
        assert.equal(f.session.heldEconomy.network.activity.activity, 'shopping');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('unsafe ground raises spot_dangerous once and walks to the held spot, else stands off', () => {
    const unsafe = { ...alternative, id: 'unsafe-ground', name: 'Party ground', tags: ['party_required'], tagsAuthoritative: true };
    const onUnsafe = chosen => {
        const f = fixture(town, chosen);
        f.session.currentSpot = unsafe;
        return f;
    };
    const leaving = onUnsafe(leaf);
    leaving.tick();
    assert(Situations.woken(leaving.session.coldLifeState.stats, 'earning_spot'), 'spot_dangerous wakes the earning spot');
    assert.deepEqual(leaving.session.trips, [primary.id], 'the held spot is other ground it may hunt: it goes');
    const waiting = onUnsafe({ activity: 'hunting', spotId: unsafe.id });
    waiting.tick(); waiting.tick();
    assert.deepEqual(waiting.session.trips, [], 'no other held spot: it stands off');
    assert.equal(waiting.session.lastDecision.action, 'avoid_hunting_ground');
    assert.equal(waiting.session.coldLifeState.stats.situationSeq, 1, 'raised once a ground');
    assert.equal(searchCalls.length, 0, 'main searches no spot');
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

test('a deferred errand leaves only ground that admits none of its fights, as a hunt does', () => {
    const f = fixture(alternative.center, { activity: 'shopping', itemId: 1459, amount: 24, town: 'Aden' });
    f.session.currentSpot = alternative;
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/AI/BotTownTravel'), 'request', () => 'deferred'); // its trip deferred (a fight, its road)
        stub(invoke('GameServer/Geodata/GeodataEngine'), 'hasLineOfSight', () => false);
        Object.assign(f.session.coldLifeState.stats, holds(primary));
        available = [npcNear(alternative.center)];
        for (let i = 0; i < 4; i++) f.tick();
        assert.deepEqual(f.session.attacks, []);
        assert(f.session.huntingTargetScan.eligibleAttackableNpcs > 0, 'the ranked mob exists, but is hidden behind a wall');
        assert.deepEqual(f.session.trips, [], 'ground whose spawns admit its fights is not empty for it (groundLook)');
        assert.equal(f.session.coldLifeState.stats.situationSeq, undefined, 'and raises nothing');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('a deferred purchase still hunts a safe local mob without taking a recovery trip', () => {
    const f = fixture(primary.center, { activity: 'shopping', itemId: 1459, amount: 24, town: 'Aden' });
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/AI/BotTownTravel'), 'request', () => 'deferred'); // its trip deferred (a fight, its road)
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
        stub(invoke('GameServer/Bot/AI/BotTownTravel'), 'request', () => 'deferred'); // its trip deferred (a fight, its road)
        available = [{ ...npcNear(primary.center), fetchLevel: () => f.bot.fetchLevel() - 16 }];
        f.tick();
        assert.deepEqual(f.session.attacks, [990101], 'a proven-safe local fight beats another empty wander');
        assert.deepEqual(f.session.trips, []);
        assert.deepEqual(f.session.moves, []);
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('a player\'s spot command is the body\'s held answer at once, raised for the background thread', () => {
    const f = fixture(primary.center, leaf, holds(primary));
    const restoreAt = restores.length;
    try {
        const Life = invoke('GameServer/Bot/Population/BotLifeState');
        stub(Life, 'cachedState', () => ({ phase: 'hot' }));
        stub(Life, 'notifyNearFacts', () => {});
        Events.raiseDecision(f.session, 'player_command', { payload: { spotId: alternative.id, at: 1 } });
        assert.equal(f.session.coldLifeState.stats.earning.spotId, alternative.id, 'the commanded spot is held');
        assert.equal(f.session.coldLifeState.stats.earning.earning, 1000, 'with the bot\'s hour kept');
        assert.deepEqual(f.session.nearRaise.names.map(entry => entry.name), ['player_command'], 'it rides the body\'s bag');
        assert.equal(Decision.suggest(f.session.botStatus, f.session).reason, 'awaiting_command_answer',
            'the card naming the old spot does not pull it back while the answer is pending');
        assert.equal(searchCalls.length, 0, 'no search');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('a body never waits for a command answer that will not come', () => {
    const f = fixture(primary.center, leaf, holds(primary));
    const restoreAt = restores.length;
    const FailureLog = require('../src/FailureLog');
    const failures = site => FailureLog.snapshot()?.[site] || 0;
    try {
        const Life = invoke('GameServer/Bot/Population/BotLifeState');
        let phase = 'hot';
        stub(Life, 'cachedState', () => ({ phase }));
        stub(Life, 'notifyNearFacts', () => {});
        const command = () => {
            Events.raiseDecision(f.session, 'player_command', { payload: { spotId: alternative.id, at: 1 } });
            f.session.nearRaise.commandPost = 7; // the post that carried it (detectNear stamps it)
        };
        const waits = () => Decision.suggest(f.session.botStatus, f.session).reason === 'awaiting_command_answer';
        command();
        assert(waits(), 'fixture: the command waits');
        Events.settle(f.session, { raiseSeq: f.session.nearRaise.seq - 1, nearSeq: 6 });
        assert(waits(), 'an answer to an earlier post leaves it waiting');
        Events.settle(f.session, { raiseSeq: f.session.nearRaise.commandSeq, nearSeq: 7 });
        assert(!waits(), 'the answer that took it ends the wait');
        command();
        const lost = failures('near.command_lost');
        Events.settle(f.session, { raiseSeq: f.session.nearRaise.commandSeq - 1, nearSeq: 7 });
        assert(!waits(), 'an answer to its post without it ends the wait');
        assert.equal(failures('near.command_lost'), lost + 1, 'counted');
        command();
        const dropped = failures('near.command_dropped');
        phase = 'cold';
        assert(!waits(), 'a body no longer near waits for nothing');
        assert.equal(failures('near.command_dropped'), dropped + 1, 'counted');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
});

test('an unreachable mark, a pending command, survival and explicit non-hunting work keep their priority', () => {
    const f = fixture(town);
    const stats = f.session.coldLifeState.stats;
    stats.spotMarks = [{ spotId: primary.id, reason: 'walk_route_unavailable', answer: null }];
    assert.equal(Decision.suggest(f.session.botStatus, f.session).reason, 'planned_route_unavailable');
    stats.spotMarks = null;
    assert.equal(Decision.suggest(f.session.botStatus, f.session).action, 'move_to_spot');
    const restoreAt = restores.length;
    try {
        stub(invoke('GameServer/Bot/Population/BotLifeState'), 'cachedState', () => ({ phase: 'hot' }));
        f.session.nearRaise = { seq: 1, commandSeq: 1, names: [{ name: 'player_command', payload: { spotId: alternative.id }, seq: 1 }] };
        assert.equal(Decision.suggest(f.session.botStatus, f.session).reason, 'awaiting_command_answer',
            'a player\'s command waits for its answer, not the spot its card still names');
    } finally { while (restores.length > restoreAt) restores.pop()(); }
    f.session.nearRaise = null;
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
