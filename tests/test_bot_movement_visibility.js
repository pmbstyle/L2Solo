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
