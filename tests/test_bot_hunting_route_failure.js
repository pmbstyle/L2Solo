const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
// The near body holds a decision without wishes (DecisionEvents.held): these
// fixtures have no economy datapack.
invoke('GameServer/Bot/AI/DecisionEvents').held = session => session.heldEconomy ||= {
    // A real context always carries its stock reader; these bots use no shots.
    stock: () => ({ itemId: 0, usePerHour: 0 }),
    network: { activity: null }, statsPacket: { decisionSeq: session.coldLifeState?.stats?.decisionSeq || 0,
        activityLeaf: 0, money: [1, 1, 0, 0] }
};
const Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Decision = invoke('GameServer/Bot/AI/BotDecisionService');
const World = invoke('GameServer/World/World');
const destination = { locX: 183244, locY: 51238, locZ: -5122 };
const start = { locX: 177223, locY: 46613, locZ: -4104 };
const spot = { id: '30_8', name: 'Test field', center: destination,
    minLevel: 55, maxLevel: 59, avgLevel: 57, density: 35, levelCounts: { 57: 35 } };
let scans = 0;
World.user = { sessions: [] };
World.npc = { spawns: [] };
World.fetchNpcsInRadius = () => { scans++; return []; };
Spots.findCurrentSpot = () => null;
Spots.ensureIndexed = () => [spot];
invoke('GameServer/Bot/AI/HotTownRebuff').syncVisit = () => null;
invoke('GameServer/Bot/AI/HotTownRebuff').needsVisit = () => false;
invoke('GameServer/Bot/AI/BotBuffs').needsNewbieRefresh = () => false;
invoke('GameServer/Inventory/ShotStock').needsActorRestock = () => false;
invoke('GameServer/Bot/AI/PartyAwareness').npcThreateningActor = () => null;
invoke('GameServer/Bot/AI/TownChatter').say = () => {};
const originalRandom = Math.random;
Math.random = () => 0.5;
function fixture(result = false) {
    const bot = {
        state: { fetchTowards: () => false, fetchHits: () => false, fetchCasts: () => false,
            fetchDead: () => false, fetchSeated: () => false, setCasts() {} },
        fetchId: () => 2002505, fetchLevel: () => 57, fetchClassId: () => 6,
        fetchLocX: () => start.locX, fetchLocY: () => start.locY, fetchLocZ: () => start.locZ,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        unselect() {}, moves: 0,
        moveTo() {
            this.moves++;
            session.lastPathfinding = { requestedTo: { ...destination }, at: Date.now(), routeUsable: result };
        }
    };
    const session = { actor: bot, plan: 'hunting', noTargetTicks: 5,
        heldEconomy: { network: { activity: { activity: 'hunting', spotId: spot.id } },
            stock: () => ({ itemId: 0, usePerHour: 0 }), statsPacket: {} },
        botStatus: { available: true, mode: 'hunting', level: 57, loc: start, blockers: ['no_targets_nearby'],
            nearby: { attackableNpcs: 5, eligibleAttackableNpcs: 5 } },
        spotRelocation: { method: 'walk', spotId: spot.id, destination: { ...destination },
            startedAt: Date.now() - 5000, lastCommandAt: Date.now() - 2000 },
        townRoutePlan: { waypoint: destination } };
    return { bot, session };
}
const ai = { say() {}, getStatus: s => s.botStatus };
const tick = f => Hunting.tick(f.session, f.bot, {}, ai);
try {
    const teleporting = fixture();
    teleporting.session.spotRelocation.method = 'clan_hall';
    teleporting.session.spotRelocation.arrivalPending = true;
    tick(teleporting);
    assert.equal(teleporting.bot.moves, 0, 'wait for the clan hall teleport instead of walking across the map');
    assert(teleporting.session.spotRelocation.arrivalPending);
    const failed = fixture();
    tick(failed);
    assert.strictEqual(failed.session.spotRelocation, undefined, 'empty route must release travel on the first failure');
    assert.strictEqual(failed.bot.moves, 1);
    assert.strictEqual(failed.session.townRoutePlan, null);
    assert.strictEqual(failed.session.lastSpotRelocation.method, 'walk_route_unavailable');
    assert(failed.session.spotRetryAfter[spot.id] > Date.now());
    assert(scans > 0, 'local target search must resume in the same tick after a failed retry');
    assert.strictEqual(Decision.suggest(failed.session.botStatus, failed.session).action, 'search_locally');

    // Exercise real destination selection, including expiry and per-bot isolation.
    const status = failed.session.botStatus;
    assert.strictEqual(Spots.findBestSpot(status).spot.id, spot.id);
    assert.strictEqual(Spots.findBestSpot(status, { spotRetryAfter: failed.session.spotRetryAfter }), null);
    failed.session.lastSpotMoveAt = Date.now() - 16000;
    assert.strictEqual(Decision.suggest(status, failed.session).action, 'search_locally', 'search exhaustion must respect failed spot cooldown');
    status.nearby.attackableNpcs = 0;
    status.nearby.eligibleAttackableNpcs = 0;
    assert.strictEqual(Decision.suggest(status, failed.session).action, 'search_locally', 'empty surroundings must respect failed spot cooldown');
    failed.session.spotRetryAfter[spot.id] = Date.now() - 1;
    assert.strictEqual(Decision.suggest(status, failed.session).spot.id, spot.id, 'destination becomes eligible after cooldown');

    const initial = fixture();
    initial.session.spotRelocation = undefined;
    tick(initial);
    assert.strictEqual(initial.session.spotRelocation, undefined, 'first relocation command must also handle immediate failure');
    assert.strictEqual(initial.session.lastDecision.reason, 'route_unavailable');

    const pending = fixture(null);
    tick(pending);
    assert(pending.session.spotRelocation, 'worker pending is not a failure');
    pending.session.lastPathfinding.routeUsable = false;
    const before = scans;
    tick(pending);
    assert.strictEqual(pending.session.spotRelocation, undefined, 'completed worker failure must release travel');
    assert.strictEqual(pending.bot.moves, 1, 'do not repeat an already failed worker request');
    assert(scans > before);

    const usable = fixture(true);
    tick(usable);
    assert(usable.session.spotRelocation, 'valid route retains travel ownership');
    assert.strictEqual(usable.session.spotRetryAfter, undefined);

    for (const wrongDestination of [false, true]) {
        const stale = fixture(true);
        stale.session.spotRelocation.lastCommandAt = Date.now();
        stale.session.lastPathfinding = { routeUsable: false,
            at: wrongDestination ? Date.now() : Date.now() - 5000,
            requestedTo: wrongDestination ? start : destination };
        tick(stale);
        assert(stale.session.spotRelocation, 'old or unrelated path failures must not cancel travel');
    }
    const expired = fixture();
    expired.session.spotRelocation.startedAt = Date.now() - 121000;
    tick(expired);
    assert.strictEqual(expired.session.spotRelocation, undefined);
    assert(expired.session.spotRetryAfter[spot.id] > Date.now(), 'timeout must not immediately select the same destination');

    // A hot bot with karma never uses SoE or a gatekeeper: it looks for a
    // spot within walking range and walks there.
    const farSpot = { ...spot, id: '31_8', name: 'Far field',
        center: { locX: start.locX + 30000, locY: start.locY, locZ: start.locZ } };
    Spots.ensureIndexed = () => [farSpot];
    const redStatus = { ...fixture().session.botStatus, nearby: { attackableNpcs: 0, eligibleAttackableNpcs: 0 } };
    assert.strictEqual(Spots.findBestSpot(redStatus).spot.id, farSpot.id, 'a far spot is in range for SoE');
    assert.strictEqual(Spots.findBestSpot(redStatus, { walkOnly: true }), null, 'walking range ends at 12000');
    const white = fixture(true);
    const red = fixture(true);
    red.bot.fetchKarma = () => 500;
    for (const f of [white, red]) f.session.heldEconomy.network.activity.spotId = farSpot.id;
    assert.strictEqual(Decision.suggest(redStatus, white.session).spot?.id, farSpot.id, 'a white bot executes the selected far hunt');
    assert.strictEqual(Decision.suggest(redStatus, red.session).spot?.id, farSpot.id, 'karma changes how the chosen hunt is reached, not the occupation');

    const realSuggest = Decision.suggest;
    const realSetTimeout = global.setTimeout;
    const Response = invoke('GameServer/Network/Response');
    const realSkillStarted = Response.skillStarted;
    Decision.suggest = () => ({ action: 'move_to_spot', reason: 'no_targets_nearby', spot: farSpot });
    global.setTimeout = () => 0;
    Response.skillStarted = () => Buffer.alloc(0);
    try {
        for (const f of [white, red]) {
            f.session.spotRelocation = undefined;
            f.session.townRoutePlan = null;
            f.bot.automation = { abortAll() {} };
            tick(f);
        }
    } finally {
        Decision.suggest = realSuggest;
        global.setTimeout = realSetTimeout;
        Response.skillStarted = realSkillStarted;
    }
    assert.strictEqual(white.session.spotRelocation?.method, 'soe_gatekeeper', 'a white bot reads SoE to a far spot');
    assert.strictEqual(red.session.spotRelocation?.method, 'walk', 'a bot with karma walks even to a far spot');
    assert.strictEqual(red.bot.moves, 1, 'a bot with karma starts walking at once');

    const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Events = require('../src/GameServer/Bot/AI/DecisionEvents');
    const TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
    const savedPurchase = { check: Market.canTravelForPurchase, state: Economy.stateForActor,
        held: Events.held, travel: TownTravel.request };
    const purchaseState = { characterId: 2002505, activity: 'hunting' };
    const purchaseEconomy = { network: { activity: { activity: 'shopping', itemId: 1835,
        amount: 8, town: 'Giran', valueHours: 0.002, rootKey: 'stock:shots' } } };
    let purchaseChecks = 0, purchaseTrips = 0, allowed = false;
    let expectedRequest = { selfId: 1835, amount: 8, town: 'Giran', valueHours: 0.002 };
    try {
        Events.held = () => purchaseEconomy;
        Economy.stateForActor = () => purchaseState;
        Market.canTravelForPurchase = (state, request, options) => {
            purchaseChecks++;
            assert.strictEqual(state, purchaseState);
            assert.strictEqual(options.economy, purchaseEconomy, 'the hot guard reuses its existing decision');
            assert.deepStrictEqual(request, expectedRequest);
            return allowed;
        };
        TownTravel.request = () => { purchaseTrips++; return 'escape'; };
        const denied = fixture();
        denied.session.spotRelocation = undefined;
        denied.session.townRoutePlan = null;
        denied.bot.automation = { abortAll() {} };
        tick(denied);
        assert.strictEqual(purchaseChecks, 1);
        assert.strictEqual(purchaseTrips, 0, 'a tiny unprofitable purchase cannot initiate a visible town trip');
        assert.strictEqual(denied.session.lastDecision.action, 'continue_occupation', 'a refused purchase waits for the planner instead of inventing a hunt');
        assert.strictEqual(denied.session.spotRelocation, undefined);
        assert.strictEqual(denied.bot.moves, 0);
        allowed = true;
        const accepted = fixture();
        accepted.session.companionEquipmentRetryAt = Date.now() + 300000;
        accepted.session.spotRelocation = undefined;
        accepted.session.townRoutePlan = null;
        accepted.bot.automation = { abortAll() {} };
        tick(accepted);
        assert.strictEqual(purchaseChecks, 2);
        assert.strictEqual(purchaseTrips, 1, 'the same shared guard admits a worthwhile visible trip');
        const unreachable = fixture();
        unreachable.session.spotRelocation = undefined;
        unreachable.session.companionEquipmentRetryAt = Date.now() + 300000;
        unreachable.session.roleDecision = { reason: 'shopping_route_unreachable' };
        tick(unreachable);
        assert.strictEqual(purchaseTrips, 1, 'a failed physical route is deferred even for stock instead of restarting each tick');
        assert.strictEqual(unreachable.session.plan, 'hunting');
        assert.strictEqual(unreachable.session.spotRelocation, undefined);
        const checked = purchaseChecks;
        purchaseState.inventory = { 1835: { amount: 20 } };
        purchaseEconomy.network.activity.heldAtDecision = 12;
        const completed = fixture();
        completed.session.spotRelocation = undefined;
        tick(completed);
        assert.strictEqual(purchaseChecks, checked, 'a completed purchase waits for its next decision instead of ordering the same quantity again');
        assert.strictEqual(purchaseTrips, 1);
        purchaseState.inventory = {};
        delete purchaseEconomy.network.activity.heldAtDecision;
        purchaseEconomy.network.activity.rootKey = 'power:148:7';
        purchaseEconomy.network.activity.r = 0.001;
        expectedRequest = { ...expectedRequest, r: 0.001 };
        const materialBuy = fixture();
        materialBuy.session.spotRelocation = undefined;
        tick(materialBuy);
        assert.strictEqual(purchaseTrips, 2, 'a material purchase retains the accepted root funding ratio');
        const crafting = fixture();
        Events.held = () => ({ network: { activity: { activity: 'crafting', kind: 'craft', rootKey: 'stock:shots' } } });
        tick(crafting);
        assert.strictEqual(crafting.session.spotRelocation, undefined, 'a craft waiting for its worker details releases an old hunting route');
        assert.strictEqual(crafting.bot.moves, 0, 'the hunt cannot steal the craft waiting window');
        assert.strictEqual(crafting.session.lastDecision.activity, 'crafting');
        const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
        const oldTarget = Shopping.workshopTarget;
        const personalCraft = { strategy: 'craft', recipeId: 99, status: 'ready_to_craft' };
        const workshop = { workshop: true, town: 'Giran' };
        try {
            Shopping.workshopTarget = (_session, _bot, selected) => {
                assert.strictEqual(selected, personalCraft, 'equipment crafting executes the worker\'s selected plan');
                return workshop;
            };
            Events.held = () => ({ network: { activity: { activity: 'crafting', kind: 'craft', rootKey: 'power:148:7' } }, personalCraft });
            const gearCraft = fixture();
            tick(gearCraft);
            assert.strictEqual(gearCraft.session.shoppingTarget, workshop, 'equipment crafting resumes at its workshop too');
            assert.strictEqual(gearCraft.session.shoppingServicePhase, 'workshop');
        } finally { Shopping.workshopTarget = oldTarget; }
    } finally {
        Market.canTravelForPurchase = savedPurchase.check;
        Economy.stateForActor = savedPurchase.state;
        Events.held = savedPurchase.held;
        TownTravel.request = savedPurchase.travel;
    }

    // A solo hunter with expired newbie buffs whose guide trip was abandoned
    // waits for the retry time instead of walking the same route next tick.
    const Buffs = invoke('GameServer/Bot/AI/BotBuffs');
    const guideAt = offset => ({ ...ai,
        getClosestNewbieGuide: () => ({ locX: start.locX + offset, locY: start.locY, locZ: start.locZ }) });
    const buffTrip = (retryAt, BotAI) => {
        const f = fixture(true);
        f.session.spotRelocation = undefined;
        f.session.townRoutePlan = null;
        f.session.newbieGuideRetryAt = retryAt;
        f.bot.automation = { abortAll() {} };
        Hunting.tick(f.session, f.bot, {}, BotAI);
        return f.session.plan;
    };
    Buffs.needsNewbieRefresh = () => true;
    try {
        assert.strictEqual(buffTrip(Date.now() + 60000, guideAt(2000)), 'hunting',
            'expired buffs do not restart a guide trip before its retry time');
        assert.strictEqual(buffTrip(Date.now() - 1, guideAt(2000)), 'getting_buffed',
            'expired buffs send the hunter to the guide once the retry time passed');
        assert.strictEqual(buffTrip(undefined, guideAt(7600)), 'hunting',
            'expired buffs do not send a hunter to a guide beyond its town radius');
        assert.strictEqual(buffTrip(undefined, guideAt(7400)), 'getting_buffed',
            'expired buffs send a hunter to a guide within its town radius');
    } finally {
        Buffs.needsNewbieRefresh = () => false;
    }

    console.log('Bot hunting route failure checks passed');
} finally {
    Math.random = originalRandom;
}
