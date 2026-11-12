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
        const realRay = Geo.hasLineOfSight;
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
        available = [{ ...npc(98, 100), fetchLocZ: () => -1689, fetchDestId: () => bot.fetchId() }];
        session.currentTargetId = 98;
        bot.moving = false;
        tick();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(session.currentTargetId, undefined, 'a retained underground attacker cannot pin a surface hunter');
        assert.equal(session.lastDecision.reason, 'vertical_gap');

        session.currentTargetId = undefined;
        session.targetRetryAfter = {};
        available = [npc(99, 100)];
        Geo.hasLineOfSight = () => true;
        tick();
        assert.equal(session.currentTargetId, 99, 'ordinary visible hunting resumes');
        assert.equal(attacks.at(-1), 99);

        session.currentTargetId = undefined;
        const questMonster = { ...npc(100, 50), fetchTitle: () => 'Quest Monster' };
        available = [questMonster, npc(101, 100)];
        tick();
        assert.equal(session.currentTargetId, 101, 'ordinary hunting skips the closer quest monster');
        assert.equal(attacks.at(-1), 101);
        session.currentTargetId = undefined;
        session.testIncoming = questMonster;
        tick();
        assert.equal(attacks.at(-1), 100, 'the hunting restriction must still permit defense against a quest monster');
        session.testIncoming = null;

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
        // On its spot, an ordinary closer mob cannot silently replace that occupation.
        const previousActivity = session.heldEconomy.network.activity;
        session.heldEconomy.network.activity = { activity: 'hunting', itemId: 1874, amount: 1, npcId: 150 };
        session.currentSpot = { id: '0_0' };
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

        // A blocked scan resumes at the mob it stopped at. When that mob is no longer a
        // fight the bot can take, the next batch starts at the next ready mob after it,
        // not among the refused ones: a visible ready mob is found, the bot does not sit.
        const Readiness = invoke('GameServer/Bot/AI/BotEncounterReadiness');
        const unready = new Set();
        replace(Readiness, 'evaluate', (_remaining, target) => ({ ready: !unready.has(target.maxHp), reason: 'fixture' }));
        const rows = [1, 2, 3, 4, 5, 6, 7].map(rank => ({ ...npc(300 + rank, rank * 100), fetchHp: () => 300 + rank }));
        const scanSession = { actor: bot, plan: 'hunting' };
        available = rows;
        bot.moving = false;
        let visible = new Set();
        Geo.hasLineOfSight = (_x, _y, _z, x) => visible.has(x);
        assert.equal(Hunting.findPreferredMonster(scanSession, bot, 2000, { readyOnly: true }), null);
        assert.equal(scanSession.huntTargetScanPending, true, 'four blocked ready mobs leave the scan pending');
        unready.add(305);
        visible = new Set([500, 600]);
        assert.equal(Hunting.findPreferredMonster(scanSession, bot, 2000, { readyOnly: true })?.fetchId(), 306,
            'the next batch starts at the ready mob after the one that stopped being ready');
        assert.equal(scanSession.lastEncounterReadiness?.ready, true);
        // Ranks 1-6, only 4 and 5 ready, all behind walls: once the batches reach the
        // refused mobs they go on there, the ready ones are not checked again, the scan ends.
        unready.clear(); [301, 302, 303, 306].forEach(hp => unready.add(hp));
        available = rows.slice(0, 6); visible = new Set();
        const wallSession = { actor: bot, plan: 'hunting' };
        let ticks = 0;
        do { Hunting.findPreferredMonster(wallSession, bot, 2000, { readyOnly: true }); ticks++; }
        while (wallSession.huntTargetScanPending && ticks < 10);
        assert.equal(wallSession.huntTargetScanPending, false, 'a blocked scan of ready and refused mobs ends');
        assert(ticks <= 3, `it ends within a few ticks (${ticks})`);

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

        // A hunter that ended inside a tree's skirt: its cell opens on every
        // side, the ground round it does not open back into it. It takes the
        // mob it can walk out to; with none in sight it walks off to search.
        Geo.hasLineOfSight = realRay;
        Geo.getCellData = (x, y, z) => {
            const cx = x >> 4, cy = y >> 4;
            const nswe = cy === 0 && cx === 1 ? 13 : cy === 0 && cx === -1 ? 14 : cx === 0 && cy === 1 ? 7 : cx === 0 && cy === -1 ? 11 : 15;
            return { z, nswe };
        };
        const skirtHunter = { ...bot, moves: [], moveTo(coords) { this.moves.push(coords); } };
        skirtHunter.state = { ...bot.state, fetchTowards: () => false };
        const skirtSession = { actor: skirtHunter, plan: 'hunting' };
        assert.equal(Visibility.canSee(skirtHunter, npc(500, 100)), true, 'a hunter on a one-way cell sees the mob it can walk out to');
        assert.equal(Visibility.canSee(npc(500, 100), skirtHunter), false, 'the cell is still not walked into');
        available = [npc(500, 100)];
        Hunting.tick(skirtSession, skirtHunter, {}, ai);
        assert.equal(skirtSession.currentTargetId, 500, 'a hunter on a one-way cell takes the mob in front of it');
        assert.equal(attacks.at(-1), 500);
        skirtSession.currentTargetId = undefined;
        available = [];
        Hunting.tick(skirtSession, skirtHunter, {}, ai);
        assert.equal(skirtHunter.moves.length, 1, 'with no mob in sight it walks off its cell to search');
        console.log('Hunting visibility: walls, floors, bounded scans, approach cancellation, wandering and self-defense passed');
    } finally {
        restores.reverse().forEach(restore => restore());
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
