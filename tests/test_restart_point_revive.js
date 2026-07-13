const assert = require('assert');

require('../src/Global');

const revive = invoke('GameServer/Actor/Generics/Revive');

const packets = [];
const actor = {
    hp: 0,
    mp: 0,
    fetchId: () => 42,
    fillupVitals() {
        this.hp = 100;
        this.mp = 100;
    },
    automation: {
        stopReplenishCalled: false,
        stopReplenish() { this.stopReplenishCalled = true; },
        replenishVitals() { throw new Error('town restart must not wait for gradual regeneration'); }
    },
    state: {
        dead: true,
        setDead(value) { this.dead = value; }
    }
};
const session = {
    dataSendToMeAndOthers(packet) { packets.push(packet); }
};

revive(session, actor, { delayMs: 0, restoreFullVitals: true });

assert.strictEqual(actor.state.dead, false, 'town restart should immediately clear the dead state');
assert.strictEqual(actor.hp, 100, 'town restart should restore HP before teleport validation');
assert.strictEqual(actor.mp, 100, 'town restart should restore MP before teleport validation');
assert.strictEqual(actor.automation.stopReplenishCalled, true, 'town restart should stop stale regeneration timers');
assert.strictEqual(packets.length, 2, 'town restart should send revive and stand-up packets immediately');
assert.strictEqual(packets[0][0], 0x07, 'first packet should be Revive');
assert.strictEqual(packets[1][0], 0x2d, 'second packet should be SocialAction stand-up');

console.log('Restart point revive checks passed');
