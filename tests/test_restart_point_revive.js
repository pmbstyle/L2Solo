const assert = require('assert');

require('../src/Global');

const die = invoke('GameServer/Actor/Generics/Die');
const revive = invoke('GameServer/Actor/Generics/Revive');
const StateModel = invoke('GameServer/Model/State');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');

const dyingActor = {
    state: new StateModel(),
    level: 20,
    classId: 0,
    hp: 100,
    mp: 100,
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

die({ dataSendToMeAndOthers() {} }, dyingActor);

assert.strictEqual(dyingActor.state.fetchDead(), true, 'death should mark the actor dead');
assert.strictEqual(dyingActor.state.isBlocked(), false, 'death should clear action flags whose cancellation would otherwise permanently block movement after a restart');
assert.deepStrictEqual(EffectStore.list(dyingActor), [], 'death should remove active effects');
assert.deepStrictEqual(dyingActor.activeBuffs, {}, 'death should clear legacy buff markers');
assert.deepStrictEqual(dyingActor.supportReservations, {}, 'death should clear stale support reservations');
assert.ok(dyingActor.collectivePDef < buffedPDef, 'death should recalculate stats without removed buff bonuses');

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
