const assert = require('assert');

require('../src/Global');

const Automation = invoke('GameServer/Automation');
const moveTo = invoke('GameServer/Actor/Generics/MoveTo');
const RuntimeWorld = invoke('GameServer/World/World');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

assert.strictEqual(
    moveTo.shouldUseLowLodWarp({
        startDistance: 1501,
        destinationDistance: 7000,
        isCompanion: false,
        plan: 'hunting'
    }),
    false,
    'A bot inside the 6000-unit client visibility radius must use normal movement'
);
assert.strictEqual(
    moveTo.shouldUseLowLodWarp({
        startDistance: 7000,
        destinationDistance: 5000,
        isCompanion: false,
        plan: 'hunting'
    }),
    false,
    'An offscreen bot walking into client visibility must not silently warp'
);
assert.strictEqual(
    moveTo.shouldUseLowLodWarp({
        startDistance: 7000,
        destinationDistance: 7000,
        isCompanion: false,
        plan: 'hunting'
    }),
    true,
    'Low-detail movement remains available when both endpoints are offscreen'
);
assert.strictEqual(
    moveTo.shouldUseLowLodWarp({
        startDistance: 7000,
        destinationDistance: 7000,
        isCompanion: true,
        plan: 'hunting'
    }),
    false,
    'Party companions must always use visible movement'
);
assert.strictEqual(
    moveTo.shouldPreannounceVisibleMove(6001, 5000),
    true,
    'A player must receive the bot snapshot and route before it crosses into visibility'
);
assert.strictEqual(
    moveTo.shouldPreannounceVisibleMove(5000, 4000),
    false,
    'Normal visible movement must keep using the regular world broadcast'
);

const outsideFrom = { locX: -7000, locY: 0 }, outsideTo = { locX: 7000, locY: 0 };
const centerPlayer = { fetchLocX: () => 0, fetchLocY: () => 0 };
assert.equal(moveTo.crossesPlayerVisibility(centerPlayer, outsideFrom, outsideTo), true,
    'an offscreen-to-offscreen segment can cross the player visible area');
assert.equal(moveTo.shouldUseLowLodWarp({ startDistance: 7000, destinationDistance: 7000,
    isCompanion: false, plan: 'hunting', crossesVisibility: true }), false,
    'a visible crossing must never be silently warped');
assert.equal(moveTo.shouldPreannounceVisibleMove(7000, 7000, true), true,
    'a crossing needs a character snapshot even when both endpoints are offscreen');
assert.equal(moveTo.crossesPlayerVisibility({ fetchLocX: () => 0, fetchLocY: () => 7000 }, outsideFrom, outsideTo), false);

const packets = [];
const actor = {
    state: {
        towards: 'move',
        inMotion() { return this.towards; },
        setTowards(value) { this.towards = value; }
    },
    fetchId: () => 42,
    fetchLocX: () => 100,
    fetchLocY: () => 200,
    fetchLocZ: () => -300,
    fetchHead: () => 400,
    session: {
        accountId: 'bot_test',
        moveTimer: setInterval(() => {}, 1000),
        dataSendToMeAndOthers(packet, creature) {
            packets.push({ packet, creature });
        }
    }
};

const automation = new Automation();
automation.abortAll(actor);
assert.strictEqual(actor.state.towards, false, 'Cancelling a route must clear the movement state');
assert.strictEqual(actor.session.moveTimer, null, 'Cancelling a route must clear the server movement timer');
assert.strictEqual(packets.length, 1, 'Cancelling a visible route must notify the client exactly once');
assert.strictEqual(packets[0].packet[0], 0x47, 'Route cancellation must use the C4 StopMove packet');

actor.state.towards = 'move';
automation.abortAll(actor, { notifyClient: false });
assert.strictEqual(packets.length, 1, 'Callers that send StopMove themselves must be able to suppress duplicates');

actor.state.towards = 'move';
actor.session.accountId = 'player_test';
automation.abortAll(actor);
assert.strictEqual(packets.length, 1, 'Player automation keeps its existing explicit StopMove lifecycle');

actor.fetchCollectiveRunSpd = () => 100000;
actor.setLocXYZ = () => {};
actor.session.actor = actor;
actor.session.accountId = 'bot_test';
actor.session.moveTimer = setInterval(() => {}, 1000);
const staleCoordinateTimer = actor.session.moveTimer;
assert.strictEqual(
    automation.scheduleMoveToCoords(actor.session, actor, { locX: 110, locY: 210, locZ: -300 }),
    true,
    'finite coordinate movement must be accepted'
);
assert.notStrictEqual(actor.session.moveTimer, staleCoordinateTimer,
    'a replacement coordinate route must replace the actor session\'s stale interpolator');
automation.abortAll(actor, { notifyClient: false });
const packetsBeforeInvalidMove = packets.length;
assert.strictEqual(
    automation.scheduleMoveToCoords(actor.session, actor, { locX: NaN, locY: 210, locZ: -300 }),
    false,
    'non-finite coordinate movement must be rejected'
);
assert.strictEqual(packets.length, packetsBeforeInvalidMove, 'a rejected coordinate move must not announce or schedule a route');

const previewPlan = {
    finalTarget: { locX: 500, locY: 0, locZ: 0 },
    waypoint: { locX: 250, locY: 100, locZ: 0 },
    createdAt: Date.now(),
    updatedAt: 123,
    reason: 'test'
};
const previewSession = {
    accountId: 'bot_preview',
    townRoutePlan: previewPlan
};
const previewActor = {
    session: previewSession,
    state: { fetchDead: () => false },
    fetchName: () => 'PreviewBot',
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    fetchLocZ: () => 0
};
const nearbyPlayer = {
    accountId: 'player_preview',
    actor: {
        fetchIsOnline: () => true,
        fetchLocX: () => 0,
        fetchLocY: () => 0
    }
};
RuntimeWorld.user = { sessions: [previewSession, nearbyPlayer] };
const originalFindPath = GeodataEngine.findPath;
const originalHasLineOfSight = GeodataEngine.hasLineOfSight;
try {
    GeodataEngine.findPath = () => null;
    GeodataEngine.hasLineOfSight = () => true;
    const diagnostics = moveTo(previewSession, previewActor, {
        from: { locX: 0, locY: 0, locZ: 0 },
        to: { locX: 500, locY: 0, locZ: 0 },
        previewOnly: true
    });
    assert.strictEqual(diagnostics.routeUsable, true, 'preview should preserve a usable direct fallback');
    assert.deepStrictEqual(diagnostics.route, [previewPlan.waypoint], 'preview diagnostics should expose the route MoveTo will execute');
    assert.strictEqual(previewPlan.updatedAt, 123, 'previewing a sticky town route must not mutate the live route plan');

    GeodataEngine.hasLineOfSight = () => false;
    const blockedDiagnostics = moveTo(previewSession, previewActor, {
        from: { locX: 0, locY: 0, locZ: 0 },
        to: { locX: 500, locY: 0, locZ: 0 },
        previewOnly: true
    });
    assert.strictEqual(blockedDiagnostics.routeUsable, false, 'blocked direct fallback must remain unusable');
    assert.deepStrictEqual(blockedDiagnostics.route, [], 'blocked direct fallback must not announce a through-wall segment');
} finally {
    GeodataEngine.findPath = originalFindPath;
    GeodataEngine.hasLineOfSight = originalHasLineOfSight;
}

// NPCs and summons use their target/owner session to send packets. Their
// movement must not freeze the bot whose session happens to carry them.
const CompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const saved = {
    now: Date.now, timeout: global.setTimeout, clear: global.clearTimeout,
    clearInterval: global.clearInterval, world: RuntimeWorld.user,
    findPath: GeodataEngine.findPath, height: GeodataEngine.getHeight,
    updatePosition: CompanionService.updatePosition
};
let clock = 100000;
const pending = new Map();
try {
    Date.now = () => clock;
    global.setTimeout = (callback, ms) => {
        const timer = { _idleTimeout: ms };
        pending.set(timer, { callback, at: clock + ms });
        return timer;
    };
    global.clearTimeout = global.clearInterval = (timer) => pending.delete(timer);
    GeodataEngine.findPath = (x, y, z, tx, ty, tz) => [
        { locX: x, locY: y, locZ: z }, { locX: tx, locY: ty, locZ: tz }
    ];
    GeodataEngine.getHeight = (x, y, z) => z;
    CompanionService.updatePosition = () => {};
    const makeActor = (id) => {
        const loc = { locX: 0, locY: 0, locZ: 0 };
        return {
            state: { towards: false, inMotion() { return this.towards; }, setTowards(v) { this.towards = v; } },
            effects: {}, automation: new Automation(),
            fetchId: () => id, fetchHead: () => 0, isDead: () => false, isBlocked: () => false,
            fetchIsOnline: () => true, fetchCollectiveRunSpd: () => 150,
            fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ,
            setLocXYZ(next) { Object.assign(loc, next); }
        };
    };
    for (const method of ['scheduleAction', 'scheduleMoveToCoords']) {
        const bot = makeActor(100), npc = makeActor(200);
        const session = { actor: bot, accountId: 'bot_flee', dataSendToMeAndOthers() {} };
        bot.session = session;
        RuntimeWorld.user = { sessions: [session, nearbyPlayer] };
        moveTo(session, bot, {
            from: { locX: 0, locY: 0, locZ: 0 }, to: { locX: 900, locY: 0, locZ: 0 }
        });
        if (method === 'scheduleAction') {
            npc.automation.scheduleAction(session, npc, bot, 0, () => {});
        } else {
            npc.automation.scheduleMoveToCoords(session, npc, { locX: 100, locY: 0, locZ: 0 });
        }
        for (let step = 0; step < 60; step++) {
            clock += 100;
            for (const [timer, entry] of [...pending]) {
                if (entry.at <= clock && pending.delete(timer)) entry.callback();
            }
        }
        assert.strictEqual(bot.fetchLocX(), 900, `${method}: an NPC chase must let the bot finish its escape`);
        assert.strictEqual(session.moveTimer, null, 'escape must finish without a stranded movement timer');
        npc.automation.abortAll(npc);
    }
    // A client animates a chasing NPC immediately after MoveToPawn. Server
    // range checks must follow that position before the arrival callback.
    for (const method of ['scheduleAction', 'scheduleMoveToCoords']) {
        const bot = makeActor(300), npc = makeActor(400);
        bot.setLocXYZ({ locX: 900, locY: 0, locZ: 0 });
        const session = { actor: bot, accountId: 'bot_chased', dataSendToMeAndOthers() {} };
        bot.session = session;
        const start = clock;
        if (method === 'scheduleAction') npc.automation.scheduleAction(session, npc, bot, 0, () => {});
        else npc.automation.scheduleMoveToCoords(session, npc, { locX: 900, locY: 0, locZ: 0 });
        for (let step = 0; step < 30; step++) {
            clock += 100;
            for (const [timer, entry] of [...pending]) {
                if (entry.at <= clock && pending.delete(timer)) entry.callback();
            }
        }
        assert(npc.fetchLocX() >= 400 && npc.fetchLocX() <= 460,
            `${method}: the server must observe the NPC midway through its visible chase`);
        assert.strictEqual(session.moveTimer, undefined, 'NPC interpolation must not own the chased bot session timer');
        const AttackRange = invoke('GameServer/Actor/AttackRange');
        assert.strictEqual(AttackRange.isWithinRange(makeActor(500), npc, 40), false,
            'a melee attacker at the old NPC origin must not hit the visibly distant NPC');
        const previousX = npc.fetchLocX();
        clock += 50;
        npc.automation.abortAll(npc);
        assert(npc.fetchLocX() >= previousX, 'cancellation must retain current progress rather than snapping to the origin');
        const stoppedX = npc.fetchLocX();
        clock = start + 10000;
        for (const [timer, entry] of [...pending]) {
            if (entry.at <= clock && pending.delete(timer)) entry.callback();
        }
        assert.strictEqual(npc.fetchLocX(), stoppedX, 'cancelled movement must never fire a stale arrival');
    }
    // Timer lateness must not slow server progress and create an arrival snap.
    const delayedBot = makeActor(600), stationaryTarget = makeActor(700);
    stationaryTarget.setLocXYZ({ locX: 900, locY: 0, locZ: 0 });
    const delayedSession = { actor: delayedBot, accountId: 'bot_delayed', dataSendToMeAndOthers() {} };
    delayedBot.session = delayedSession;
    delayedBot.automation.scheduleAction(delayedSession, delayedBot, stationaryTarget, 0, () => {});
    clock += 3000;
    for (const [timer, entry] of [...pending]) {
        if (entry.at <= clock && pending.delete(timer)) entry.callback();
    }
    assert(delayedBot.fetchLocX() >= 400 && delayedBot.fetchLocX() <= 460,
        'a delayed movement callback must catch up by elapsed time, not count just one step');
    const beforeReplacement = delayedBot.fetchLocX();
    delayedBot.automation.scheduleMoveToCoords(delayedSession, delayedBot, { locX: -900, locY: 0, locZ: 0 });
    assert.strictEqual(delayedBot.fetchLocX(), beforeReplacement, 'replacing a chase must start at its current position');
    clock += 1000;
    for (const [timer, entry] of [...pending]) {
        if (entry.at <= clock && pending.delete(timer)) entry.callback();
    }
    assert(delayedBot.fetchLocX() < beforeReplacement - 100, 'the replacement must advance along the new direction');
    delayedBot.automation.abortAll(delayedBot);
    assert.strictEqual(delayedSession.moveTimer, null, 'cancellation must clear the owned interpolation timer');

    const advanceClock = (ms, moveTarget = () => {}) => {
        for (let elapsed = 0; elapsed < ms; elapsed += 100) {
            clock += 100;
            moveTarget();
            for (const [timer, entry] of [...pending]) {
                if (entry.at <= clock && pending.delete(timer)) entry.callback();
            }
        }
    };
    // The owner pulls a mob while its summon runs out to attack. C4 follows
    // the live mob; reaching its old position would force a second approach.
    const summoner = makeActor(800), servitor = makeActor(801), pulledMob = makeActor(802);
    servitor.fetchIsSummon = () => true;
    pulledMob.setLocXYZ({ locX: 900, locY: 0, locZ: 0 });
    const summonPackets = [];
    const summonSession = { actor: summoner, accountId: 'bot_summoner',
        dataSendToMeAndOthers(packet) { summonPackets.push(packet); } };
    let firstSwing = null;
    servitor.automation.scheduleAction(summonSession, servitor, pulledMob, 40, () => {
        firstSwing = { at: clock, distance: Math.abs(servitor.fetchLocX() - pulledMob.fetchLocX()) };
    }, { collisionAware: true, action: 'attack' });
    const pullStarted = clock;
    advanceClock(3500, () => pulledMob.setLocXYZ({
        locX: Math.max(0, 900 - (clock - pullStarted) * 0.15), locY: 0, locZ: 0
    }));
    assert(firstSwing, 'a summon must attack when it meets a mob running towards its owner');
    assert(firstSwing.at - pullStarted < 3500, 'the first swing must not wait for arrival at the mob\'s old position');
    assert(firstSwing.distance <= 40, 'the first swing must use the mob\'s current melee range');
    assert.strictEqual(summonPackets.length, 1, 'following a moving mob must keep one continuous MoveToPawn');
    const firstSwingX = servitor.fetchLocX();
    advanceClock(4000);
    assert.strictEqual(servitor.fetchLocX(), firstSwingX, 'the original arrival deadline must not snap the summon to the old mob position');
    servitor.automation.abortAll(servitor);

    // A moving owner can outlive the first arrival estimate and turn away.
    // Both servitors and item pets must keep following at their actual speed.
    for (const flag of ['fetchIsSummon', 'fetchIsPet']) {
        const owner = makeActor(810), follower = makeActor(811);
        follower[flag] = () => true;
        owner.setLocXYZ({ locX: 300, locY: 0, locZ: 0 });
        const ownerTimer = { ownerMovement: true };
        const followPackets = [];
        const followSession = { actor: owner, accountId: 'bot_moving_owner', moveTimer: ownerTimer,
            dataSendToMeAndOthers(packet) { followPackets.push(packet); } };
        let arrived = false;
        follower.automation.scheduleAction(followSession, follower, owner, 80, () => { arrived = true; });
        advanceClock(3000, () => {
            owner.setLocXYZ({ locX: owner.fetchLocX() + 20, locY: owner.fetchLocY() + 10, locZ: 0 });
            const previous = [follower.fetchLocX(), follower.fetchLocY()];
            // Save the previous position before the interpolator advances.
            follower.previousPosition = previous;
        });
        assert.strictEqual(arrived, false, `${flag}: a fleeing owner must not finish a stale arrival`);
        assert(follower.fetchLocX() > 350, `${flag}: following must continue beyond the owner's old stopping point`);
        assert(follower.fetchLocY() > 50, `${flag}: server movement must follow the owner's turn`);
        const lastStep = Math.hypot(follower.fetchLocX() - follower.previousPosition[0],
            follower.fetchLocY() - follower.previousPosition[1]);
        assert(lastStep <= 16, `${flag}: retargeting must preserve the 150-unit movement speed`);
        advanceClock(6000);
        assert.strictEqual(arrived, true, `${flag}: the follower must catch its owner after the owner stops`);
        const stopPosition = [follower.fetchLocX(), follower.fetchLocY()];
        assert(Math.hypot(owner.fetchLocX() - stopPosition[0], owner.fetchLocY() - stopPosition[1]) <= 80,
            `${flag}: follow completion must use the owner's current position`);
        assert.strictEqual(followPackets.length, 1, `${flag}: following must not spam movement restarts`);
        assert.strictEqual(followSession.moveTimer, ownerTimer, `${flag}: following must preserve the owner's movement timer`);
        follower.automation.abortAll(follower);
        advanceClock(1000);
        assert.deepStrictEqual([follower.fetchLocX(), follower.fetchLocY()], stopPosition,
            `${flag}: stopped following must not fire stale movement`);
    }

    // The client and the server must agree through walking, a mid-leg speed
    // change and arrival on terrain whose height differs from the requested Z.
    const walker = makeActor(830);
    let walking = true, liveRunSpeed = 150;
    walker.state.fetchWalkin = () => walking;
    walker.fetchCollectiveWalkSpd = () => 75;
    walker.fetchCollectiveRunSpd = () => liveRunSpeed;
    const walkingPackets = [];
    const walkingSession = { actor: walker, accountId: 'bot_walking',
        dataSendToMeAndOthers(p) { walkingPackets.push(p); } };
    walker.session = walkingSession;
    RuntimeWorld.user = { sessions: [walkingSession, nearbyPlayer] };
    GeodataEngine.getHeight = () => 64;
    moveTo(walkingSession, walker, { from: { locX: 0, locY: 0, locZ: 0 },
        to: { locX: 900, locY: 0, locZ: 0 } });
    assert.equal(walkingPackets.find(p => p[0] === 1).readInt32LE(13), 64,
        'announce the terrain height rather than the caller stale Z');
    const traffic = invoke('GameServer/Bot/AI/TownTraffic');
    const originalTrafficUpdate = traffic.update, originalSteer = traffic.steer;
    const trafficSpeeds = [];
    walkingSession.activeMoveGoal.town = 'Dion';
    try {
        traffic.update = (id, point, to, speed) => { if (id === 830) trafficSpeeds.push(speed);
            else originalTrafficUpdate(id, point, to, speed); };
        traffic.steer = () => null;
        advanceClock(2000);
        assert.equal(walker.fetchLocX(), 150, 'a walking body must use its walk speed');
        walking = false;
        liveRunSpeed = 300;
        advanceClock(1000);
        assert.equal(walker.fetchLocX(), 450, 'a speed change must affect the current server leg');
        advanceClock(2000);
        assert.equal(walker.fetchLocX(), 900);
        assert.equal(walker.fetchLocZ(), 64, 'arrival must not snap the actor back under the terrain');
        assert.equal(walkingSession.activeMoveSegment, null, 'arrival retires its visible leg');
        assert(trafficSpeeds.includes(75) && trafficSpeeds.includes(300),
            'town collision forecasts must observe the same changing speed as movement');
    } finally {
        traffic.update = originalTrafficUpdate;
        traffic.steer = originalSteer;
    }
    GeodataEngine.getHeight = saved.height;

    // A player may leave while a bot is still on a route that originally
    // approached him. Later legs must not recreate that bot across the map.
    const leavingObserverPosition = { x: 0, y: 0 };
    const observedPackets = [];
    const leavingObserver = { accountId: 'leaving_observer', actor: {
        fetchIsOnline: () => true, fetchLocX: () => leavingObserverPosition.x,
        fetchLocY: () => leavingObserverPosition.y },
        dataSendToMe(p) { observedPackets.push(p); } };
    const crossingBot = makeActor(840);
    crossingBot.setLocXYZ({ locX: -7000, locY: 0, locZ: 0 });
    const crossingSession = { actor: crossingBot, accountId: 'bot_crossing', dataSendToMeAndOthers() {} };
    crossingBot.session = crossingSession;
    const movementResponse = invoke('GameServer/Network/Response');
    const originalInfo = movementResponse.charInfo, previousPath = GeodataEngine.findPath;
    try {
        movementResponse.charInfo = () => Buffer.from([3]);
        GeodataEngine.getHeight = (x, y, z) => z;
        GeodataEngine.findPath = () => [{ locX: -7000, locY: 0, locZ: 0 },
            { locX: -6500, locY: 0, locZ: 0 }, { locX: 7000, locY: 0, locZ: 0 }];
        RuntimeWorld.user = { sessions: [crossingSession, leavingObserver] };
        moveTo(crossingSession, crossingBot, { from: { locX: -7000, locY: 0, locZ: 0 },
            to: { locX: 7000, locY: 0, locZ: 0 } });
        const sentBeforeLeaving = observedPackets.length;
        leavingObserverPosition.y = 20000;
        advanceClock(4000);
        assert.equal(observedPackets.length, sentBeforeLeaving,
            'a former approaching observer must receive no later route legs after leaving visibility');
    } finally {
        crossingBot.automation.abortAll(crossingBot);
        movementResponse.charInfo = originalInfo;
        GeodataEngine.findPath = previousPath;
        GeodataEngine.getHeight = saved.height;
    }

    const cancelledPet = makeActor(820), distantOwner = makeActor(821);
    cancelledPet.fetchIsSummon = () => true;
    distantOwner.setLocXYZ({ locX: 900, locY: 0, locZ: 0 });
    let cancelledArrival = false;
    cancelledPet.automation.scheduleAction(summonSession, cancelledPet, distantOwner, 80,
        () => { cancelledArrival = true; });
    advanceClock(1000);
    cancelledPet.automation.abortAll(cancelledPet);
    const cancelledX = cancelledPet.fetchLocX();
    advanceClock(10000);
    assert.strictEqual(cancelledArrival, false, 'cancelling a live-pawn follow must cancel its arrival callback');
    assert.strictEqual(cancelledPet.fetchLocX(), cancelledX, 'cancelling a live-pawn follow must retain its current position');
} finally {
    Date.now = saved.now;
    global.setTimeout = saved.timeout;
    global.clearTimeout = saved.clear;
    global.clearInterval = saved.clearInterval;
    RuntimeWorld.user = saved.world;
    GeodataEngine.findPath = saved.findPath;
    GeodataEngine.getHeight = saved.height;
    CompanionService.updatePosition = saved.updatePosition;
}

console.log('Bot movement visibility checks passed');
