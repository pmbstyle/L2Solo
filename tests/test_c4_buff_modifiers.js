const assert = require('assert');

require('../src/Global');

const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const Formulas = invoke('GameServer/Formulas');

function actorWithBuffs() {
    const actor = {
        level: 20,
        classId: 0,
        hp: 100,
        mp: 100,
        activeBuffs: {
            might: Date.now() + 60000,
            shield: Date.now() + 60000,
            haste: Date.now() + 60000,
            windWalk: Date.now() + 60000
        },
        fetchLevel() { return this.level; },
        fetchClassId() { return this.classId; },
        fetchCon() { return 30; },
        fetchMen() { return 30; },
        fetchStr() { return 30; },
        fetchDex() { return 30; },
        fetchInt() { return 30; },
        fetchWit() { return 30; },
        fetchHp() { return this.hp; },
        fetchMp() { return this.mp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMaxMp() { return this.maxMp; },
        fetchPAtk() { return 10; },
        fetchMAtk() { return 10; },
        fetchPDef() { return 10; },
        fetchMDef() { return 10; },
        fetchAccur() { return 0; },
        fetchEvasion() { return 0; },
        fetchCritical() { return 40; },
        fetchAtkSpd() { return 300; },
        fetchWalkSpd() { return 80; },
        fetchRunSpd() { return 120; },
        isSpellcaster() { return 0; },
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
        }
    };
    return actor;
}

const actor = actorWithBuffs();
calculateStats({}, actor);

assert.strictEqual(
    actor.collectivePAtk,
    Math.round(Formulas.calcPAtk(20, 30, 100) * 1.12),
    'Might level 2 should use the C4/L2J 1.12 PAtk multiplier'
);
assert.strictEqual(
    actor.collectivePDef,
    Math.round(Formulas.calcPDef(20, 100) * 1.12),
    'Shield level 2 should use the C4/L2J 1.12 PDef multiplier'
);
assert.strictEqual(
    actor.collectiveAtkSpd,
    Math.round(Formulas.calcAtkSpd(30, 300) * 1.33),
    'Haste level 2 should use the C4/L2J 1.33 PAtkSpd multiplier'
);
assert.strictEqual(
    actor.collectiveRunSpd,
    Formulas.calcSpeed(30, 120) + 33,
    'Wind Walk level 2 should add 33 run speed'
);

console.log('C4 buff modifier checks passed');
