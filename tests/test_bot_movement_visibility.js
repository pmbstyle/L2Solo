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
assert.strictEqual(
    automation.scheduleMoveToCoords(actor.session, actor, { locX: 110, locY: 210, locZ: -300 }),
    true,
    'finite coordinate movement must be accepted'
);
assert.strictEqual(actor.session.moveTimer, null, 'a replacement coordinate route must clear the actor session\'s stale interpolator');
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
