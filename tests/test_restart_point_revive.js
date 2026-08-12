const assert = require('assert');

require('../src/Global');

const die = invoke('GameServer/Actor/Generics/Die');
const revive = invoke('GameServer/Actor/Generics/Revive');
const StateModel = invoke('GameServer/Model/State');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');

const dyingActor = {
    state: new StateModel(),
    level: 20,
    classId: 0,
    hp: 100,
    mp: 100,
    charges: 0,
    fetchId: () => 41,
    fetchLevel() { return this.level; },
    fetchClassId() { return this.classId; },
    fetchCon: () => 30,
    fetchMen: () => 30,
    fetchStr: () => 30,
    fetchDex: () => 30,
    fetchInt: () => 30,
    fetchWit: () => 30,
    fetchHp() { return this.hp; },
    fetchMp() { return this.mp; },
    fetchCharges() { return this.charges; },
    fetchMaxHp() { return this.maxHp; },
    fetchMaxMp() { return this.maxMp; },
    fetchPAtk: () => 10,
    fetchMAtk: () => 10,
    fetchPDef: () => 10,
    fetchMDef: () => 10,
    fetchAccur: () => 0,
    fetchEvasion: () => 0,
    fetchCritical: () => 40,
    fetchAtkSpd: () => 300,
    fetchWalkSpd: () => 80,
    fetchRunSpd: () => 120,
    isSpellcaster: () => 0,
    setMaxHp(value) { this.maxHp = value; },
    setHp(value) { this.hp = value; },
    setMaxMp(value) { this.maxMp = value; },
    setMp(value) { this.mp = value; },
    setCharges(value) { this.charges = value; },
    setMaxLoad(value) { this.maxLoad = value; },
    setLoad(value) { this.load = value; },
    setCollectivePAtk(value) { this.collectivePAtk = value; },
    setCollectiveMAtk(value) { this.collectiveMAtk = value; },
    setCollectivePDef(value) { this.collectivePDef = value; },
    setCollectiveMDef(value) { this.collectiveMDef = value; },
    setCollectiveAccur(value) { this.collectiveAccur = value; },
    setCollectiveEvasion(value) { this.collectiveEvasion = value; },
    setCollectiveCritical(value) { this.collectiveCritical = value; },
    setCollectiveAtkSpd(value) { this.collectiveAtkSpd = value; },
    setCollectiveCastSpd(value) { this.collectiveCastSpd = value; },
    setCollectiveWalkSpd(value) { this.collectiveWalkSpd = value; },
    setCollectiveRunSpd(value) { this.collectiveRunSpd = value; },
    backpack: {
        fetchTotalArmorBonusMp: () => 0,
        fetchTotalLoad: () => 0,
        fetchTotalWeaponPAtk: () => 100,
        fetchTotalWeaponMAtk: () => 50,
        fetchTotalArmorPDef: () => 100,
        fetchTotalArmorMDef: () => 80,
        fetchTotalWeaponAccur: () => 5,
        fetchTotalArmorEvasion: () => 2,
        fetchTotalWeaponCritical: () => 40,
        fetchTotalWeaponAtkSpd: () => 300
    },
    isDead() { return this.state.fetchDead(); },
    destructor() {}
};
dyingActor.state.setHits(true);
dyingActor.state.setCasts(true);
dyingActor.state.setSeated(true);
dyingActor.state.setAnimated(true);
dyingActor.state.setPickinUp(true);
EffectStore.apply(dyingActor, { key: 'shield', id: 1040, type: 'buff', stats: { pDefMul: 1.12 }, durationMs: 60000 });
dyingActor.activeBuffs = { shield: Date.now() + 60000 };
dyingActor.supportReservations = { shield: { expiresAt: Date.now() + 5000 } };
calculateStats({}, dyingActor);
const buffedPDef = dyingActor.collectivePDef;
ChargeLifecycle.increase({}, dyingActor, 3, 7);
assert(dyingActor.chargeExpiryTimer, 'charges should have an active expiry timer before death');

die({ dataSendToMeAndOthers() {} }, dyingActor);

assert.strictEqual(dyingActor.state.fetchDead(), true, 'death should mark the actor dead');
assert.strictEqual(dyingActor.state.isBlocked(), false, 'death should clear action flags whose cancellation would otherwise permanently block movement after a restart');
assert.deepStrictEqual(EffectStore.list(dyingActor), [], 'death should remove active effects');
assert.deepStrictEqual(dyingActor.activeBuffs, {}, 'death should clear legacy buff markers');
assert.deepStrictEqual(dyingActor.supportReservations, {}, 'death should clear stale support reservations');
assert.ok(dyingActor.collectivePDef < buffedPDef, 'death should recalculate stats without removed buff bonuses');
assert.strictEqual(dyingActor.fetchCharges(), 0, 'death should clear all force and sonic charges');
assert.strictEqual(dyingActor.chargeExpiryTimer, undefined, 'death should cancel the charge expiry timer');

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

function deadCompanion(id) {
    return {
        id,
        unselected: false,
        fetchId: () => id,
        isDead: () => true,
        unselect() { this.unselected = true; }
    };
}

const leaderSession = { actor: { fetchId: () => 43 } };
const fallenA = deadCompanion(44);
const fallenB = deadCompanion(45);
const aliveCompanion = { fetchId: () => 46, isDead: () => false };
const fallenSessionA = {
    actor: fallenA,
    partyCompanion: true,
    followPlayerSession: leaderSession,
    plan: 'resting',
    deathTimerStart: Date.now(),
    currentTargetId: 999
};
const fallenSessionB = {
    actor: fallenB,
    partyCompanion: true,
    followPlayerSession: leaderSession,
    plan: 'resting',
    deathTimerStart: Date.now(),
    incomingThreatId: 1000
};
const aliveSession = {
    actor: aliveCompanion,
    partyCompanion: true,
    followPlayerSession: leaderSession,
    botStay: true,
    stayLocation: { locX: 12, locY: 34, locZ: 56 }
};
const companionCalls = [];
const movedCompanions = TeleportTo.syncPartyCompanions(leaderSession, {
    locX: 1000,
    locY: 2000,
    locZ: -3000
}, {
    revive(session, actor, options) { companionCalls.push({ type: 'revive', session, actor, options }); },
    teleportTo(session, actor, coords) { companionCalls.push({ type: 'teleport', session, actor, coords }); }
}, [fallenSessionA, fallenSessionB, aliveSession]);

assert.strictEqual(movedCompanions, 3, 'a leader teleport should move every active companion in the same party');
assert.deepStrictEqual(companionCalls.filter((call) => call.type === 'revive').map((call) => call.actor.fetchId()), [44, 45], 'only fallen companions should be revived');
assert.deepStrictEqual(companionCalls.filter((call) => call.type === 'teleport').map((call) => call.coords), [
    { locX: 1080, locY: 2000, locZ: -3000 },
    { locX: 920, locY: 2000, locZ: -3000 },
    { locX: 1000, locY: 2080, locZ: -3000 }
], 'all companions should arrive beside the player teleport point');
assert.strictEqual(fallenSessionA.plan, 'following', 'teleported companion must remain in the party follow state');
assert.strictEqual(fallenSessionA.deathTimerStart, undefined, 'leader teleport must clear the stale death timeout');
assert.strictEqual(fallenSessionA.currentTargetId, undefined, 'leader teleport must clear stale combat targets');
assert.strictEqual(fallenSessionB.incomingThreatId, undefined, 'leader teleport must clear stale incoming threats');
assert.strictEqual(fallenA.unselected, true, 'teleported companion must clear its old target');
assert.strictEqual(aliveSession.plan, 'following', 'living companions must return to follow when the leader teleports');
assert.strictEqual(aliveSession.botStay, true, 'leader teleport must preserve an explicit Hold order');
assert.deepStrictEqual(aliveSession.stayLocation, { locX: 1000, locY: 2080, locZ: -3000 }, 'a held companion must use its new teleport location as the hold anchor');

const formationCalls = [];
const fullParty = Array.from({ length: 8 }, (_value, index) => ({
    actor: { fetchId: () => 60 + index, isDead: () => false, unselect() {} },
    partyCompanion: true,
    followPlayerSession: leaderSession
}));
TeleportTo.syncPartyCompanions(leaderSession, { locX: 3000, locY: 4000, locZ: -2000 }, {
    revive() { throw new Error('living companions must not be revived'); },
    teleportTo(_session, _actor, coords) { formationCalls.push(coords); }
}, fullParty);
assert.strictEqual(new Set(formationCalls.map((coords) => `${coords.locX}:${coords.locY}:${coords.locZ}`)).size, 8, 'a full party must receive distinct teleport landing positions');

const botSourceCalls = [];
assert.strictEqual(TeleportTo.syncPartyCompanions({
    constructor: { name: 'BotSession' }
}, { locX: 1, locY: 2, locZ: 3 }, {
    revive() { botSourceCalls.push('revive'); },
    teleportTo() { botSourceCalls.push('teleport'); }
}, [fallenSessionA]), 0, 'a bot teleport must not recursively move its party');
assert.deepStrictEqual(botSourceCalls, [], 'a bot teleport must leave other companions untouched');

console.log('Restart point revive checks passed');
