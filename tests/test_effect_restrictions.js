const assert = require('assert');

require('../src/Global');

const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const validatePosition = invoke('GameServer/Network/Request/ValidatePosition');
const World = invoke('GameServer/World/World');

function actor() {
    return {
        effects: {},
        fetchId: () => 2000001,
        fetchLocX: () => 10,
        fetchLocY: () => 20,
        fetchLocZ: () => 30,
        fetchHead: () => 40,
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
        },
        dataSendToMeAndOthers(packet) {
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

const feared = actor();
EffectStore.apply(feared, { key: 'fear', id: 1092, type: 'debuff', durationMs: 10000 });
assert.strictEqual(EffectRestrictions.canMove(feared), false, 'Fear should block player-directed movement');
assert.strictEqual(EffectRestrictions.canAttack(feared), false, 'Fear should block attacks');
assert.strictEqual(EffectRestrictions.canCast(feared), false, 'Fear should block casts');

const stunned = actor();
const stunnedSession = session({ moveTimer: true });
const stunEffect = EffectStore.apply(stunned, { key: 'stun', id: 100, type: 'debuff', durationMs: 10000 });
EffectRestrictions.interruptOnApply(stunnedSession, stunned, stunEffect);
assert.strictEqual(EffectRestrictions.canMove(stunned), false, 'Stun should block movement');
assert.strictEqual(EffectRestrictions.canAttack(stunned), false, 'Stun should block attacks');
assert.strictEqual(EffectRestrictions.canCast(stunned), false, 'Stun should block casting');
assert.strictEqual(EffectStore.abnormalMask(stunned), 0x0040, 'Stun should expose the C4 abnormal-effect mask');
assert.strictEqual(stunned.aborted, true, 'Control debuff should abort current movement/action');
assert.strictEqual(stunned.attack.timersCleared, true, 'Control debuff should clear active attack timers');
assert.strictEqual(stunned.state.hits, false, 'Control debuff should clear active hit state');
assert.strictEqual(stunned.state.casts, false, 'Control debuff should clear active cast state');
assert.strictEqual(stunned.combatAborted, true, 'Control debuff should abort NPC-style combat loops when available');
assert.strictEqual(stunnedSession.moveTimer, null, 'Control debuff should clear active move timer');
assert(stunnedSession.packets.some((packet) => packet[0] === 0x47), 'Control debuff should send StopMove to halt an in-flight client move');

stunnedSession.actor = stunned;
const validatedWhileStunned = validatePosition(stunnedSession, Buffer.alloc(21));
assert.strictEqual(validatedWhileStunned, false, 'ValidatePosition must not bypass an active control debuff');

const sleeping = actor();
EffectStore.apply(sleeping, { key: 'sleep', id: 1069, type: 'debuff', durationMs: 10000 });
assert.strictEqual(EffectStore.abnormalMask(sleeping), 0x0080, 'Sleep should expose the C4 abnormal-effect mask');
EffectRestrictions.wakeOnDamage(sleeping);
assert.strictEqual(EffectStore.hasDebuff(sleeping, 'sleep'), false, 'Damage should wake a sleeping target');

const stunnedByDamage = actor();
EffectStore.apply(stunnedByDamage, { key: 'stun', id: 100, type: 'debuff', durationMs: 10000 });
EffectRestrictions.wakeOnDamage(stunnedByDamage);
assert.strictEqual(EffectStore.hasDebuff(stunnedByDamage, 'stun'), true, 'Damage should not remove non-sleep control debuffs');

const confusedMob = actor();
confusedMob.fetchAttackable = () => true;
confusedMob.state.fetchCombats = () => true;
confusedMob.abortCombatState = () => { confusedMob.confusionCombatAborted = true; };
confusedMob.enterCombatState = (_session, target) => { confusedMob.confusionTarget = target; };
const confusionTarget = {
    fetchAttackable: () => true,
    fetchLocX: () => 100,
    fetchLocY: () => 100,
    fetchLocZ: () => 0
};
World.npc = { spawns: [confusedMob, confusionTarget] };
World.user = { sessions: [] };
const confusionEffect = EffectStore.apply(confusedMob, {
    key: 'confusion', id: 2, type: 'debuff', durationMs: 10000, confusionMobOnly: true
});
EffectRestrictions.interruptOnApply(session(), confusedMob, confusionEffect);
assert.strictEqual(confusedMob.confusionCombatAborted, true, 'ConfuseMob should replace an NPC combat loop before retargeting');
assert.strictEqual(confusedMob.confusionTarget, confusionTarget, 'ConfuseMob should make an NPC attack a nearby attackable NPC');
EffectRestrictions.stopConfusion(confusedMob);
EffectStore.remove(confusedMob, 'confusion');

const fearTarget = {
    ...actor(),
    effects: {},
    loc: { locX: 100, locY: 100, locZ: 0 },
    model: { stateRun: false },
    fetchId: () => 3000001,
    fetchLocX() { return this.loc.locX; },
    fetchLocY() { return this.loc.locY; },
    fetchLocZ() { return this.loc.locZ; },
    setLocXYZ(coords) { this.loc = coords; },
    fetchCollectiveRunSpd: () => 1000,
    setStateRun(value) { this.model.stateRun = value; },
    fetchStateRun() { return this.model.stateRun; }
};
const fearSource = {
    fetchLocX: () => 0,
    fetchLocY: () => 0
};
const fearSession = session();
const fearEffect = EffectStore.apply(fearTarget, { key: 'fear', id: 1092, type: 'debuff', durationMs: 10000 });
EffectRestrictions.interruptOnApply(fearSession, fearTarget, fearEffect, fearSource);
assert.strictEqual(fearTarget.aborted, true, 'Fear should abort current target automation');
assert.strictEqual(fearTarget.combatAborted, true, 'Fear should abort NPC-style combat loops');
assert.strictEqual(fearTarget.isAfraid, true, 'Fear should mark the target as afraid');
const fearMove = fearSession.packets.find((packet) => packet[0] === 0x01);
assert(fearMove, 'Fear should broadcast a flee MoveToLocation packet');
assert.strictEqual(fearMove.readInt32LE(5), 600, 'Fear should move the target 500 units away on X');
assert.strictEqual(fearMove.readInt32LE(9), 600, 'Fear should move the target 500 units away on Y');
assert(fearTarget.effectTimers.fear, 'Fear should keep ticking while the debuff is active');
EffectRestrictions.stopFear(fearTarget);

const rejectSession = session();
EffectRestrictions.reject(rejectSession);
assert.strictEqual(rejectSession.packets.length, 1, 'Rejected control action should send ActionFailed');
clearInterval(rooted.effectTimers?.root);
clearInterval(silenced.effectTimers?.silence);
EffectStore.remove(feared, 'fear');

console.log('Effect restriction checks passed');
