const assert = require('assert');

require('../src/Global');

const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const ReceivedHit = invoke('GameServer/Actor/Generics/ReceivedHit');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Formulas = invoke('GameServer/Formulas');

function actor() {
    return {
        level: 1,
        classId: 0,
        hp: 100,
        mp: 100,
        cp: 0,
        effects: {},
        fetchLevel() { return this.level; },
        fetchClassId() { return this.classId; },
        fetchCon() { return 43; },
        fetchMen() { return 25; },
        fetchStr() { return 40; },
        fetchDex() { return 30; },
        fetchInt() { return 21; },
        fetchWit() { return 11; },
        fetchHp() { return this.hp; },
        fetchMp() { return this.mp; },
        fetchCp() { return this.cp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMaxMp() { return this.maxMp; },
        fetchMaxCp() { return this.maxCp; },
        fetchPAtk() { return 4; },
        fetchMAtk() { return 6; },
        fetchPDef() { return 80; },
        fetchMDef() { return 41; },
        fetchAccur() { return 0; },
        fetchEvasion() { return 0; },
        fetchCritical() { return 40; },
        fetchAtkSpd() { return 300; },
        fetchWalkSpd() { return 80; },
        fetchRunSpd() { return 115; },
        isSpellcaster() { return 0; },
        setMaxHp(value) { this.maxHp = value; },
        setHp(value) { this.hp = value; },
        setMaxMp(value) { this.maxMp = value; },
        setMp(value) { this.mp = value; },
        setMaxCp(value) { this.maxCp = value; },
        setCp(value) { this.cp = value; },
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
            fetchTotalWeaponPAtk: () => 4,
            fetchTotalWeaponMAtk: () => 6,
            fetchTotalArmorPDef: () => 76,
            fetchTotalArmorMDef: () => 41,
            fetchTotalWeaponAccur: () => 0,
            fetchTotalArmorEvasion: () => 0,
            fetchTotalWeaponCritical: () => 40,
            fetchTotalWeaponAtkSpd: () => 300
        }
    };
}

function combatActor({ hp = 100, cp = 0 } = {}) {
    return {
        id: 2000002,
        hp,
        cp,
        session: null,
        fetchId() { return this.id; },
        fetchHp() { return this.hp; },
        setHp(value) { this.hp = value; },
        fetchCp() { return this.cp; },
        setCp(value) { this.cp = value; },
        state: {
            fetchSeated: () => false,
            fetchCombats: () => false,
            setCombats() {}
        },
        automation: {
            replenishVitals() {}
        },
        statusUpdateVitals() {}
    };
}

function hitSession(attacker) {
    return {
        actor: attacker,
        dataSendToMeAndOthers() {}
    };
}

const fighter = actor();
calculateStats({}, fighter);
assert.strictEqual(Math.round(fighter.fetchMaxCp()), Math.round(Formulas.calcCp(1, 0, 43)), 'max CP should be calculated from sourced class template parameters');
assert.strictEqual(fighter.fetchCp(), fighter.fetchMaxCp(), 'first CP stat calculation should fill legacy zero CP to max');

fighter.setCp(10);
EffectStore.apply(fighter, { id: 9001, key: 'cp-set-bonus', stats: { maxCpMul: 1.5 } });
calculateStats({}, fighter);
assert.strictEqual(Math.round(fighter.fetchMaxCp()), Math.round(Formulas.calcCp(1, 0, 43) * 1.5), 'maxCpMul effects should increase max CP');
assert.strictEqual(fighter.fetchCp(), 10, 'recalculating max CP should not refill existing current CP');

fighter.setCp(999999);
calculateStats({}, fighter);
assert.strictEqual(fighter.fetchCp(), fighter.fetchMaxCp(), 'current CP should clamp down to max CP');

const playerVictim = combatActor({ hp: 100, cp: 30 });
ReceivedHit(hitSession({ fetchId: () => 2000001 }), playerVictim, 20);
assert.strictEqual(playerVictim.fetchCp(), 10, 'PvP damage should consume CP before HP');
assert.strictEqual(playerVictim.fetchHp(), 100, 'PvP damage fully absorbed by CP should not reduce HP');

ReceivedHit(hitSession({ fetchId: () => 2000001 }), playerVictim, 40);
assert.strictEqual(playerVictim.fetchCp(), 0, 'PvP overflow damage should consume remaining CP');
assert.strictEqual(playerVictim.fetchHp(), 70, 'PvP overflow damage should reduce HP after CP is gone');

const npcHitVictim = combatActor({ hp: 100, cp: 30 });
ReceivedHit(hitSession({ fetchId: () => 3000001, fetchKind: () => 'Monster' }), npcHitVictim, 20);
assert.strictEqual(npcHitVictim.fetchCp(), 30, 'NPC damage should not consume player CP');
assert.strictEqual(npcHitVictim.fetchHp(), 80, 'NPC damage should still reduce HP directly');

console.log('CP stat checks passed');
