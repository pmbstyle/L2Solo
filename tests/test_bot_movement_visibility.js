const assert = require('assert');

require('../src/Global');

const Automation = invoke('GameServer/Automation');
const moveTo = invoke('GameServer/Actor/Generics/MoveTo');

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

console.log('Bot movement visibility checks passed');
