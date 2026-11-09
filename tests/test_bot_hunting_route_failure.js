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
const Situations = invoke('GameServer/Bot/Situations');
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
    // The spot the worker's one choice names, published in the body's mind.
    const session = { actor: bot, plan: 'hunting', noTargetTicks: 5, decisionStats: { huntSpot: { spotId: spot.id } },
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
    // The walk that could not reach its spot is the earning spot's situation (spot_unreachable): its mark keeps
    // the body off that spot, whatever time passes, until the bot's next own situation re-decides it.
    const failedStats = failed.session.decisionStats;
    assert.deepStrictEqual(failedStats.spotMarks, [{ spotId: spot.id, reason: 'spot_unreachable' }]);
    assert(Situations.woken(failedStats, 'earning_spot'), 'spot_unreachable wakes the earning spot');
    // and the build: the spot walked to is the hunting leaf's (a material hunt's source spot too), which the build chose.
    assert(Situations.woken(failedStats, 'build'), 'spot_unreachable wakes the build that named the spot');
    // The same spot failed again before the answer is no news: the decisions its mark woke answer it.
    const seq = failedStats.situationSeq;
    const again = { spotId: spot.id, reason: failedStats.spotMarks[0].reason };
    Situations.raise(failedStats, 'spot_unreachable', again, Situations.OPEN);
    assert.strictEqual(failedStats.situationSeq, seq, 'a spot already marked raises nothing new');
    assert(scans > 0, 'local target search must resume in the same tick after a failed retry');
    const status = failed.session.botStatus;
    assert.strictEqual(Decision.suggest(status, failed.session).action, 'search_locally', 'the marked spot is not walked to');
    status.nearby.attackableNpcs = 0;
    status.nearby.eligibleAttackableNpcs = 0;
    assert.strictEqual(Decision.suggest(status, failed.session).action, 'search_locally', 'empty surroundings keep the mark');
    Situations.raise(failedStats, 'spot_empty', null, Situations.OPEN);
    failedStats.earning = { spotId: spot.id, shots: true, income: 1, expected: 1, earning: 1, error: 0, at: 5 };
    assert.strictEqual(Decision.suggest(status, failed.session).action, 'search_locally', 'a wake or a new answer does not drop the mark');
    // The outing ends (a new grade, a town trip, a death): the mark is forgotten, and the worker's choice
    // naming the spot again sends the body there.
    Situations.raise(failedStats, 'grade_changed', null, Situations.OPEN);
    assert.strictEqual(Decision.suggest(status, failed.session).spot.id, spot.id, 'and the held spot is walked to again');

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
    assert.strictEqual(usable.session.decisionStats?.spotMarks, undefined);

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
    expired.session.decisionStats = {}; // no next walk after the timeout: only the timeout is read
    tick(expired);
    assert.strictEqual(expired.session.spotRelocation, undefined);
    assert(!(expired.session.decisionStats?.spotMarks || []).length,
        'a timeout (fights on the way) marks nothing: an execution retry, bounded by the relocation timeout');

    // A hot bot with karma never uses SoE or a gatekeeper: it walks to its chosen spot.
    const farSpot = { ...spot, id: '31_8', name: 'Far field',
        center: { locX: start.locX + 30000, locY: start.locY, locZ: start.locZ } };
    Spots.ensureIndexed = () => [farSpot];
    const redStatus = { ...fixture().session.botStatus, nearby: { attackableNpcs: 0, eligibleAttackableNpcs: 0 } };
    const white = fixture(true);
    const red = fixture(true);
    red.bot.fetchKarma = () => 500;
    for (const f of [white, red]) {
        f.session.heldEconomy.network.activity.spotId = farSpot.id;
        f.session.decisionStats = { huntSpot: { spotId: farSpot.id } };
    }
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

    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Events = require('../src/GameServer/Bot/AI/DecisionEvents');
    const TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
    const savedPurchase = { state: Economy.stateForActor, held: Events.held, travel: TownTravel.request };
    const purchaseState = { characterId: 2002505, activity: 'hunting' };
    const purchaseEconomy = { network: { decisionSeq: 1, activityLeaf: 7, activity: { activity: 'shopping', itemId: 1835,
        amount: 8, town: 'Giran', valueHours: 0.002, rootKey: 'stock:shots' } } };
    let purchaseTrips = 0;
    try {
        Events.held = () => purchaseEconomy;
        Economy.stateForActor = () => purchaseState;
        TownTravel.request = () => { purchaseTrips++; return 'escape'; };
        // The held shopping leaf is its build's decision (its visit weighed there): its trip
        // starts once per decision, no tick weighs it again.
        const accepted = fixture();
        accepted.session.spotRelocation = undefined;
        accepted.session.townRoutePlan = null;
        accepted.bot.automation = { abortAll() {} };
        tick(accepted);
        assert.strictEqual(purchaseTrips, 1, 'the held leaf starts its trip');
        accepted.session.plan = 'hunting';
        accepted.session.spotRelocation = undefined;
        tick(accepted);
        assert.strictEqual(purchaseTrips, 1, 'the same decision does not start it again');
        purchaseEconomy.network.decisionSeq = 2;
        tick(accepted);
        assert.strictEqual(purchaseTrips, 2, 'a new decision of the leaf does');
        // The bag's town trip a build decided (stats.cleanupDue) starts
        // while the live bag needs it; an emptied bag ends the hold with no trip, so no
        // second trip starts before the next answer lands.
        {
            const trips = [], request = TownTravel.request;
            TownTravel.request = (_session, _bot, _ai, reason) => { trips.push(reason); return 'escape'; };
            Events.held = () => ({ network: { activity: { activity: 'hunting', spotId: spot.id } }, stock: () => ({ itemId: 0 }) });
            const book = invoke('GameServer/DataCache').items.find(item => item.template.kind === 'Other.Spellbook');
            const bagged = items => {
                const f = fixture();
                f.session.spotRelocation = undefined;
                f.bot.automation = { abortAll() {} };
                f.bot.backpack = { fetchItems: () => items };
                f.session.decisionStats = { cleanupDue: { reason: 'no_slot' } };
                return f;
            };
            try {
                const emptied = bagged([]);
                tick(emptied);
                assert.deepStrictEqual(trips, [], 'an emptied bag takes no trip');
                assert.strictEqual(emptied.session.decisionStats.cleanupDue, null, 'and its hold ends');
                const full = bagged(Array.from({ length: 81 }, (_, i) => ({ selfId: book.selfId, amount: 1, id: 9800000 + i })));
                tick(full);
                assert.deepStrictEqual(trips, ['Inventory no_slot. Heading to town.'], 'a full bag carries the decided trip to town');
                assert.strictEqual(full.session.decisionStats.cleanupDue, null, 'which ends the hold');
                // A trip the executor refuses raises its failure for the build (no hold left to retry each tick).
                TownTravel.request = () => false;
                const refused = bagged(Array.from({ length: 81 }, (_, i) => ({ selfId: book.selfId, amount: 1, id: 9810000 + i })));
                refused.session.decisionStats = { ...refused.session.decisionStats, woken: 0, situationSeq: 0,
                    wishSections: {}, equipmentPlan: {}, earning: {} };
                Hunting.tick(refused.session, refused.bot, {}, { ...ai, getClosestTown: () => ({ name: 'Giran' }) });
                assert.strictEqual(refused.session.decisionStats.cleanupDue, null, 'a refused trip ends the hold');
                assert(Situations.woken(refused.session.decisionStats, 'build'), 'its failure wakes the build');
            } finally { TownTravel.request = request; Events.held = () => purchaseEconomy; }
        }
        // A failed gear errand waits for the worker's answer (DecisionEvents.failureWaits).
        const gearFailure = () => ({ seq: 1, names: [{ name: 'goal_failed', payload: { kind: 'gear_errand', key: 1 }, seq: 1 }],
            impossible: true, impossibleSeq: 1 });
        const unreachable = fixture();
        unreachable.session.spotRelocation = undefined;
        unreachable.session.nearRaise = gearFailure();
        unreachable.session.roleDecision = { reason: 'shopping_route_unreachable' };
        tick(unreachable);
        assert.strictEqual(purchaseTrips, 2, 'a failed physical route is deferred even for stock instead of restarting each tick');
        assert.strictEqual(unreachable.session.plan, 'hunting');
        assert.strictEqual(unreachable.session.spotRelocation, undefined);
        purchaseState.inventory = { 1835: { amount: 20 } };
        purchaseEconomy.network.activity.heldAtDecision = 12;
        purchaseEconomy.network.decisionSeq = 3;
        const completed = fixture();
        completed.session.spotRelocation = undefined;
        tick(completed);
        assert.strictEqual(purchaseTrips, 2, 'a completed purchase waits for its next decision instead of ordering the same quantity again');
        purchaseState.inventory = {};
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
        Economy.stateForActor = savedPurchase.state;
        Events.held = savedPurchase.held;
        TownTravel.request = savedPurchase.travel;
    }

    // A solo hunter walks to the Newbie Guide only when its rebuff answered the guide
    // (Bot/AI/Rebuff), once per answer, to a guide within its town radius; a guide out of
    // reach holds the answer done (no retry until the next situation).
    const guideAt = offset => ({ ...ai,
        getClosestNewbieGuide: () => ({ locX: start.locX + offset, locY: start.locY, locZ: start.locZ }) });
    const buffTrip = (answered, BotAI, after = null) => {
        const f = fixture(true);
        f.session.spotRelocation = undefined;
        f.session.townRoutePlan = null;
        if (answered) Events.replaceStats(f.session, { ...Events.statsFor(f.session), rebuff: { via: 'guide', providerId: null, at: 1 } });
        f.bot.automation = { abortAll() {} };
        Hunting.tick(f.session, f.bot, {}, BotAI);
        if (after) after(f);
        return f.session.plan;
    };
    assert.strictEqual(buffTrip(false, guideAt(2000)), 'hunting', 'no answer: no guide trip, buffs or not');
    assert.strictEqual(buffTrip(true, guideAt(2000)), 'getting_buffed', 'the guide answer sends the hunter to the guide');
    assert.strictEqual(buffTrip(true, guideAt(7600), f => {
        assert.equal(Events.statsFor(f.session).rebuff.done, true, 'a guide out of reach holds the answer done');
        f.session.plan = 'hunting';
        Hunting.tick(f.session, f.bot, {}, guideAt(7400));
        assert.equal(f.session.plan, 'hunting', 'a done answer starts no later trip');
    }), 'hunting', 'no trip to a guide beyond its town radius');
    assert.strictEqual(buffTrip(true, guideAt(7400)), 'getting_buffed', 'a guide within its town radius is in reach');

    console.log('Bot hunting route failure checks passed');
} finally {
    Math.random = originalRandom;
}
