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
} finally {
    GeodataEngine.findPath = originalFindPath;
    GeodataEngine.hasLineOfSight = originalHasLineOfSight;
}

console.log('Bot movement visibility checks passed');
