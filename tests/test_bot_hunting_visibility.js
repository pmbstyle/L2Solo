const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();

const Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
const Visibility = invoke('GameServer/Bot/AI/BotHuntingVisibility');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const World = invoke('GameServer/World/World');
const restores = [];
function replace(object, key, value) {
    const previous = object[key];
    restores.push(() => { object[key] = previous; });
    object[key] = value;
}

function npc(id, x) {
    return {
        fetchId: () => id, fetchSelfId: () => id, fetchName: () => `mob_${id}`,
        fetchAttackable: () => true, isDead: () => false, fetchKind: () => 'Monster',
        fetchLocX: () => x, fetchLocY: () => 8, fetchLocZ: () => 0,
        fetchLevel: () => 20, fetchHp: () => 100, fetchMaxHp: () => 100
    };
}

async function main() {
    try {
        // Use the real ray check against a synthetic NSWE wall, including
        // the same-cell different-floor case used by overlapping rooms.
        const origin = npc(1, 8), hidden = npc(2, 24);
        replace(Geo, 'hasGeo', () => true);
        replace(Geo, 'getCellData', (x, _y, z) => ({ z, nswe: x < 16 ? 14 : 13 }));
        assert.equal(Visibility.canSee(origin, hidden), false);
        Geo.getCellData = (_x, _y, z) => ({ z: z < 32 ? 0 : 64, nswe: 15 });
        assert.equal(Visibility.canSee(origin, { ...origin, fetchLocZ: () => 64 }), false);
        assert.equal(Visibility.canSee(origin, hidden), true);

        replace(Math, 'random', () => 0.1);
        replace(invoke('GameServer/Bot/AI/BotBuffs'), 'needsNewbieRefresh', () => false);
        replace(invoke('GameServer/Bot/AI/HotTownRebuff'), 'syncVisit', () => null);
        replace(invoke('GameServer/Bot/AI/HotTownRebuff'), 'needsVisit', () => false);
        replace(invoke('GameServer/Inventory/ShotStock'), 'needsActorRestock', () => false);
        replace(invoke('GameServer/Bot/AI/SpotService'), 'findCurrentSpot', () => null);
        replace(invoke('GameServer/Bot/AI/BotDecisionService'), 'suggest', () => ({ action: 'search_locally' }));
        replace(invoke('GameServer/Bot/AI/PartyAwareness'), 'npcThreateningActor', session => session.testIncoming || null);
        replace(World, 'user', { sessions: [] });
        let available = [];
        replace(World, 'npc', { spawns: available });
        replace(World, 'fetchNpcsInRadius', () => available);
        replace(World, 'fetchUser', () => Promise.reject(new Error('NPC')));
        replace(World, 'fetchNpc', id => Promise.resolve(available.find(target => target.fetchId() === id)));
        replace(Geo, 'hasLineOfSight', () => false);

        const bot = {
            ...npc(2000001, 8), moving: false,
            fetchClassId: () => 0, fetchMp: () => 100, fetchMaxMp: () => 100,
            fetchIsOnline: () => true, fetchKarma: () => 0,
            select({ id }) { this.selected = id; }, unselect() { this.selected = null; },
            moves: [], moveTo(coords) { this.moves.push(coords); },
            state: { fetchTowards: () => bot.moving, fetchHits: () => false, fetchCasts: () => false,
                fetchSeated: () => false, fetchDead: () => false },
            automation: { abortAll() { bot.moving = false; bot.aborted = true; } }
        };
        const session = { actor: bot, plan: 'hunting' };
        const attacks = [];
        const ai = { say() {}, getRandomPhrase: () => '', getStatus: () => ({}),
            executeCombat: (_session, _bot, target) => attacks.push(target.fetchId()) };
        const tick = () => Hunting.tick(session, bot, {}, ai);

        available = [npc(10, 100)];
        tick();
        assert.equal(session.currentTargetId, undefined, 'hidden mobs cannot begin combat');
        assert.equal(bot.moves.length, 0, 'random wandering must not choose a point through a wall');
        assert.equal(attacks.length, 0);

        available = [1, 2, 3, 4, 5].map(id => npc(20 + id, id * 100));
        session.noTargetTicks = 0;
        tick();
        assert.equal(session.huntTargetScanPending, true);
        assert.equal(session.noTargetTicks, 0, 'partial scans must not count as an empty hunting ground');
        assert.equal(bot.moves.length, 0, 'partial scans must not trigger wandering');

        session.currentTargetId = available[0].fetchId();
        bot.moving = true;
        tick();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(session.currentTargetId, undefined, 'an unengaged target lost behind a wall must be released');
        assert.equal(bot.aborted, true, 'the old approach must stop when visibility is lost');
        assert.equal(session.lastDecision.reason, 'target_not_visible');

        session.testIncoming = available[0];
        tick();
        assert.equal(attacks.at(-1), available[0].fetchId(), 'an actual attacker still owns self-defense despite lost visibility');

        session.testIncoming = null;
        session.currentTargetId = undefined;
        session.targetRetryAfter = {};
        available = [npc(99, 100)];
        Geo.hasLineOfSight = () => true;
        tick();
        assert.equal(session.currentTargetId, 99, 'ordinary visible hunting resumes');
        assert.equal(attacks.at(-1), 99);

        session.currentTargetId = undefined;
        available = [];
        bot.moving = false;
        bot.moves.length = 0;
        tick();
        assert.equal(bot.moves.length, 1, 'an idle hunter starts a local search walk');
        bot.moving = true;
        tick();
        assert.equal(bot.moves.length, 1, 'a search walk keeps its destination until arrival');
        available = [{ ...npc(100, 100), fetchLevel: () => 10 }];
        tick();
        assert.equal(session.currentTargetId, 100,
            'a visible safe easier mob interrupts the search walk when no normal target exists');
        assert.equal(attacks.at(-1), 100);

        // The cold material hunt names its monster as well as its ground.
        // An ordinary closer mob cannot silently replace that occupation.
        const previousActivity = session.heldEconomy.network.activity;
        session.heldEconomy.network.activity = { activity: 'hunting', itemId: 1874, amount: 1, npcId: 150 };
        session.currentTargetId = undefined;
        bot.moving = false;
        available = [npc(101, 30), npc(150, 200)];
        tick();
        assert.equal(session.currentTargetId, 150, 'the selected material hunt keeps its monster');
        session.testIncoming = available[0];
        tick();
        assert.equal(attacks.at(-1), 101, 'self-defense can still interrupt the selected material hunt');
        session.testIncoming = null;
        session.currentTargetId = undefined;
        session.heldEconomy.network.activity = previousActivity;

        const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
        const Events = invoke('GameServer/Bot/AI/DecisionEvents');
        const oldTravel = Market.canTravelForPurchase, oldReject = Events.rejectSession;
        try {
            Market.canTravelForPurchase = () => false;
            Events.rejectSession = () => { throw Error('a declined journey must not reroll the occupation'); };
            session.heldEconomy.network.activity = { activity: 'shopping', itemId: 736, amount: 1,
                town: 'Oren', rootKey: 'stock:scrolls' };
            available = [npc(201, 100)];
            tick();
            assert.equal(session.currentTargetId, 201, 'an unprofitable separate shopping journey leaves the bot farming locally');
            assert.equal(session.heldEconomy.network.activity.activity, 'shopping', 'local earning preserves the pending occupation');
            assert.equal(session.spotRelocation, undefined, 'waiting for a worthwhile shopping visit cannot choose another field');
        } finally {
            Market.canTravelForPurchase = oldTravel; Events.rejectSession = oldReject;
            session.heldEconomy.network.activity = previousActivity;
            session.currentTargetId = undefined;
        }

        session.currentSpot = { id: '0_0', center: { locX: 8, locY: 8, locZ: 0 } };
        session.noTargetTicks = 2;
        session.currentTargetId = undefined;
        const oldRadiusScan = World.fetchNpcsInRadius;
        World.fetchNpcsInRadius = (_x, _y, radius) => available.filter(target => Math.abs(target.fetchLocX() - 8) <= radius);
        available = [npc(250, 4800), npc(251, 6200)];
        tick();
        assert.equal(session.currentTargetId, 250, 'an exhausted local search expands to a visible mob elsewhere on the same field');
        assert(session.huntingSearchRadius > 6000);
        assert.equal(session.huntingTargetScan.eligibleAttackableNpcs, 1, 'the neighbouring field is not a new hunting destination');
        World.fetchNpcsInRadius = oldRadiusScan;
        session.currentTargetId = undefined;
        session.currentSpot = null;

        // Native action automation is a separate movement path from moveTo.
        // Even an in-range attack/cast must route rather than cross a wall.
        const Automation = invoke('GameServer/Automation');
        const Attack = invoke('GameServer/Actor/Attack');
        session.accountId = 'bot_wall_action';
        bot.state.setTowards = () => {};
        bot.state.setHits = () => {};
        bot.backpack = { fetchTotalWeaponKind: () => 'Weapon.Bow' };
        bot.automation = new Automation();
        bot.session = session;
        bot.moves.length = 0;
        Geo.hasLineOfSight = () => false;
        let completions = 0;
        assert.equal(bot.automation.scheduleAction(session, bot, hidden, 700,
            () => { completions++; }, { action: 'attack', collisionAware: true }), false);
        assert.equal(completions, 0, 'a wall blocks an in-range native attack callback');
        assert.equal(bot.moves.length, 1);
        assert.equal(bot.moves[0].targetActor, hidden, 'native actions delegate to the normal geodata route');
        bot.automation.scheduleAction(session, bot, hidden, 900, () => { completions++; });
        assert.equal(completions, 0, 'spell approach uses the same wall boundary');

        const nativeAttack = new Attack();
        nativeAttack.blockedPvpDefense = () => false;
        nativeAttack.checkParticipants = () => false;
        nativeAttack.meleeHit(session, hidden);
        assert.equal(bot.moves.length, 3, 'repeating native attacks also recheck a wall before the next swing');

        const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
        replace(Restrictions, 'canMove', () => false);
        bot.automation.scheduleAction(session, bot, hidden, 900, () => { completions++; });
        assert.equal(bot.moves.length, 3, 'a rooted bot cannot start a route to bypass an obstructed action');
        assert.equal(completions, 0);
        Geo.hasLineOfSight = () => true;
        bot.automation.scheduleAction(session, bot, hidden, 700, () => { completions++; }, { action: 'attack' });
        assert.equal(completions, 1, 'a visible in-range attack remains usable while rooted');

        // A target can disappear while the old straight approach finishes.
        // Recheck before its callback, rather than striking through the wall.
        Restrictions.canMove = () => true;
        bot.fetchCollectiveRunSpd = () => 100;
        bot.setLocXYZ = () => {};
        session.dataSendToMeAndOthers = () => {};
        bot.automation.startMoveInterpolation = () => {};
        let arrival;
        replace(invoke('GameServer/Timer'), 'start', (_timer, callback) => { arrival = callback; });
        bot.automation.scheduleAction(session, bot, hidden, 0, () => { completions++; });
        assert.equal(typeof arrival, 'function');
        Geo.hasLineOfSight = () => false;
        const routesBeforeArrival = bot.moves.length;
        arrival();
        assert.equal(completions, 1, 'losing visibility during an approach must suppress its old callback');
        assert.equal(bot.moves.length, routesBeforeArrival + 1);
        bot.automation.abortAll(bot);
        console.log('Hunting visibility: walls, floors, bounded scans, approach cancellation, wandering and self-defense passed');
    } finally {
        restores.reverse().forEach(restore => restore());
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
