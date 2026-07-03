const assert = require('assert');

require('../src/Global');

const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const C4EquipmentItemSkills = invoke('GameServer/Items/C4EquipmentItemSkills');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const Formulas = invoke('GameServer/Formulas');
const Attack = invoke('GameServer/Actor/Attack');

function equipmentItem(id, selfId, equipped = true) {
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchEquipped: () => equipped,
        setEquipped(value) { equipped = value; }
    };
}

function actorWithEquipment(items) {
    const actor = {
        level: 20,
        classId: 0,
        hp: 100,
        mp: 100,
        effects: {},
        activeBuffs: {},
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
            fetchItems: () => items,
            syncEquipmentItemSkills(target) {
                return C4EquipmentItemSkills.sync(target, items);
            },
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

assert.strictEqual(Object.keys(C4EquipmentItemSkills.ITEM_SKILLS).length, 233, 'C4 equipment item_skill mapping should cover sourced equip entries');
assert.deepStrictEqual(
    C4EquipmentItemSkills.resolveItem(4682),
    { skillId: 3010, level: 1, name: 'Stormbringer - Focus', kind: 'Weapon' },
    'Stormbringer - Focus should map to sourced SA Focus 3010-1'
);
assert.deepStrictEqual(
    C4EquipmentItemSkills.resolveItem(6660),
    { skillId: 3562, level: 1, name: 'Ring of Queen Ant', kind: 'Armor' },
    'Ring of Queen Ant should map to sourced armor passive 3562-1'
);
assert.strictEqual(C4EquipmentItemSkills.statsFor(3010, 1).stats.pCritRateAdd, 86.7, 'SA Focus 3010-1 should preserve sourced rCrit +86.7');
assert.strictEqual(C4EquipmentItemSkills.statsFor(3562, 1).stats.pCritDamageMul, 1.15, 'Queen Ant ring should preserve sourced cAtk x1.15');
assert.strictEqual(
    C4EquipmentItemSkills.statsFor(3027, 1, { actor: { fetchHp: () => 61, fetchMaxHp: () => 100 } }).stats.pCritRateAdd,
    undefined,
    'Rsk. Focus should not apply above sourced HP <= 60 condition'
);
assert.strictEqual(
    C4EquipmentItemSkills.statsFor(3027, 1, { actor: { fetchHp: () => 60, fetchMaxHp: () => 100 } }).stats.pCritRateAdd,
    138.7,
    'Rsk. Focus should apply at sourced HP <= 60 condition'
);

const focusWeapon = equipmentItem(1, 4682, true);
const queenAntRing = equipmentItem(2, 6660, true);
const actor = actorWithEquipment([focusWeapon, queenAntRing]);
calculateStats({}, actor);

assert.strictEqual(EffectStats.add(actor, 'pCritRateAdd'), 86.7, 'equipped SA Focus should apply pCritRateAdd');
assert.strictEqual(EffectStats.add(actor, 'pAccuracyCombatAdd'), 2, 'equipped Queen Ant ring should apply accuracy');
assert.strictEqual(EffectStats.multiplier(actor, 'pCritDamageMul'), 1.15, 'equipped Queen Ant ring should apply critical damage multiplier');
assert.strictEqual(
    actor.collectiveCritical,
    Formulas.calcCritical(30, 40) + 86.7,
    'equipment item skills should affect recalculated critical rate'
);
assert.strictEqual(
    actor.collectiveAccur,
    Formulas.calcAccur(20, 30, 5) + 2,
    'armor passive item_skill should affect recalculated accuracy'
);

focusWeapon.setEquipped(false);
queenAntRing.setEquipped(false);
calculateStats({}, actor);
assert.strictEqual(EffectStats.add(actor, 'pCritRateAdd'), 0, 'unequipped SA Focus should be removed on recalculation');
assert.strictEqual(EffectStats.multiplier(actor, 'pCritDamageMul'), 1, 'unequipped armor passive should be removed on recalculation');

assert.strictEqual(
    Formulas.calcMeleeDamage(100, 0, 50, { critical: true, criticalDamageMultiplier: 1, criticalDamageAdd: 50 }),
    350,
    'cAtkAdd should follow Lisvus formula: base critical damage plus add * 70 / defence'
);

const rskFocus = equipmentItem(3, 4727, true);
const riskActor = actorWithEquipment([rskFocus]);
riskActor.hp = 61;
riskActor.maxHp = 100;
calculateStats({}, riskActor);
assert.strictEqual(EffectStats.add(riskActor, 'pCritRateAdd'), 0, 'Rsk. Focus should remain inactive above 60% HP');
riskActor.hp = 60;
riskActor.maxHp = 100;
calculateStats({}, riskActor);
assert.strictEqual(EffectStats.add(riskActor, 'pCritRateAdd'), 138.7, 'Rsk. Focus should activate at 60% HP');

const backBlow = equipmentItem(4, 4685, true);
const backBlowActor = actorWithEquipment([backBlow]);
backBlowActor.fetchCollectiveCritical = () => 100;
backBlowActor.fetchLocX = () => -100;
backBlowActor.fetchLocY = () => 0;
const backBlowTarget = {
    fetchHead: () => 0,
    fetchLocX: () => 0,
    fetchLocY: () => 0
};
const attack = new Attack();
assert.strictEqual(attack.fetchSituationalCriticalRate(backBlowActor, backBlowTarget), 167, 'Back Blow 3018-2 should apply sourced basemul rCrit x1.67 from behind');
backBlowActor.fetchLocX = () => 100;
assert.strictEqual(attack.fetchSituationalCriticalRate(backBlowActor, backBlowTarget), 100, 'Back Blow should not apply when not behind the target');

const infinityStinger = equipmentItem(5, 6617, true);
const infinityActor = actorWithEquipment([infinityStinger]);
infinityActor.fetchCollectiveCritical = () => 100;
infinityActor.fetchLocX = () => -100;
infinityActor.fetchLocY = () => 0;
assert.strictEqual(attack.fetchSituationalCriticalRate(infinityActor, backBlowTarget), 320, 'Infinity Stinger should add sourced behind rCrit +220');

console.log('C4 equipment item_skill checks passed');
