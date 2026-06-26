const assert = require('assert');

require('../src/Global');

const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

function actor() {
    return {
        effects: {},
        aborted: false,
        queue: false,
        automation: {
            abortAll(target) {
                target.aborted = true;
            }
        },
        attack: {
            resetQueuedEvent() {
                this.reset = true;
            }
        }
    };
}

function session(options = {}) {
    return {
        packets: [],
        moveTimer: options.moveTimer ? setInterval(() => {}, 1000) : null,
        dataSendToMe(packet) {
            this.packets.push(packet);
        }
    };
}

const rooted = actor();
EffectStore.apply(rooted, { key: 'root', id: 102, type: 'debuff', durationMs: 10000 });
assert.strictEqual(EffectRestrictions.canMove(rooted), false, 'Root should block movement');
assert.strictEqual(EffectRestrictions.canAttack(rooted), true, 'Root should not block attacking by itself');
assert.strictEqual(EffectRestrictions.canCast(rooted), true, 'Root should not block casting by itself');

const silenced = actor();
EffectStore.apply(silenced, { key: 'silence', id: 1064, type: 'debuff', durationMs: 10000 });
assert.strictEqual(EffectRestrictions.canCast(silenced), false, 'Silence should block casting');
assert.strictEqual(EffectRestrictions.canMove(silenced), true, 'Silence should not block movement');

const stunned = actor();
const stunnedSession = session({ moveTimer: true });
const stunEffect = EffectStore.apply(stunned, { key: 'stun', id: 100, type: 'debuff', durationMs: 10000 });
EffectRestrictions.interruptOnApply(stunnedSession, stunned, stunEffect);
assert.strictEqual(EffectRestrictions.canMove(stunned), false, 'Stun should block movement');
assert.strictEqual(EffectRestrictions.canAttack(stunned), false, 'Stun should block attacks');
assert.strictEqual(EffectRestrictions.canCast(stunned), false, 'Stun should block casting');
assert.strictEqual(stunned.aborted, true, 'Control debuff should abort current movement/action');
assert.strictEqual(stunnedSession.moveTimer, null, 'Control debuff should clear active move timer');

const rejectSession = session();
EffectRestrictions.reject(rejectSession);
assert.strictEqual(rejectSession.packets.length, 1, 'Rejected control action should send ActionFailed');
clearInterval(rooted.effectTimers?.root);
clearInterval(silenced.effectTimers?.silence);

console.log('Effect restriction checks passed');
