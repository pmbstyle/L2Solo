const assert = require('assert');

require('../src/Global');

const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

function actor() {
    return {
        effects: {},
        aborted: false,
        combatAborted: false,
        queue: false,
        automation: {
            abortAll(target) {
                target.aborted = true;
            }
        },
        attack: {
            timersCleared: false,
            clearTimers() {
                this.timersCleared = true;
            },
            resetQueuedEvent() {
                this.reset = true;
            }
        },
        state: {
            hits: true,
            casts: true,
            combats: true,
            setHits(value) { this.hits = value; },
            setCasts(value) { this.casts = value; },
            setCombats(value) { this.combats = value; }
        },
        abortCombatState() {
            this.combatAborted = true;
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
assert.strictEqual(stunned.attack.timersCleared, true, 'Control debuff should clear active attack timers');
assert.strictEqual(stunned.state.hits, false, 'Control debuff should clear active hit state');
assert.strictEqual(stunned.state.casts, false, 'Control debuff should clear active cast state');
assert.strictEqual(stunned.combatAborted, true, 'Control debuff should abort NPC-style combat loops when available');
assert.strictEqual(stunnedSession.moveTimer, null, 'Control debuff should clear active move timer');

const sleeping = actor();
EffectStore.apply(sleeping, { key: 'sleep', id: 1069, type: 'debuff', durationMs: 10000 });
EffectRestrictions.wakeOnDamage(sleeping);
assert.strictEqual(EffectStore.hasDebuff(sleeping, 'sleep'), false, 'Damage should wake a sleeping target');

const stunnedByDamage = actor();
EffectStore.apply(stunnedByDamage, { key: 'stun', id: 100, type: 'debuff', durationMs: 10000 });
EffectRestrictions.wakeOnDamage(stunnedByDamage);
assert.strictEqual(EffectStore.hasDebuff(stunnedByDamage, 'stun'), true, 'Damage should not remove non-sleep control debuffs');

const rejectSession = session();
EffectRestrictions.reject(rejectSession);
assert.strictEqual(rejectSession.packets.length, 1, 'Rejected control action should send ActionFailed');
clearInterval(rooted.effectTimers?.root);
clearInterval(silenced.effectTimers?.silence);

console.log('Effect restriction checks passed');
