const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const Formulas = invoke('GameServer/Formulas');

function actor() {
    return {
        soulshotLoaded: false,
        spiritshotLoaded: false,
        fetchId: () => 2000001,
        fetchLocX: () => 1,
        fetchLocY: () => 2,
        fetchLocZ: () => 3,
        fetchCollectivePAtk: () => 100,
        fetchCollectiveMAtk: () => 100,
        fetchCollectiveAtkSpd: () => 333,
        fetchCollectiveCastSpd: () => 666,
        backpack: {
            fetchTotalWeaponPAtkRnd: () => 0
        }
    };
}

function target() {
    return {
        fetchCollectivePDef: () => 100,
        fetchCollectiveMDef: () => 50,
        fetchDex: () => 30,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHead: () => 8192
    };
}

function skill({ spell, power }) {
    return {
        fetchSpell: () => spell,
        fetchPower: () => power
    };
}

const magicNoShot = Math.round(Formulas.calcMagicDamage(100, 10, 50));
const magicWithSpiritshot = Math.round(Formulas.calcMagicDamage(100, 10, 50, { spiritshot: true }));
assert.strictEqual(magicNoShot, 182, 'magic damage should use 91 * sqrt(MAtk) * power / MDef');
assert.strictEqual(magicWithSpiritshot, 257, 'spiritshot should multiply MAtk before sqrt, not final damage');

const physicalWithSoulshot = Math.round(Formulas.calcPhysicalDamage(100, 0, 100, 25, { soulshot: true }));
assert.strictEqual(physicalWithSoulshot, 158, 'physical skills should add skill power after soulshot boosts PAtk');
assert.strictEqual(Math.round(Formulas.calcMeleeAtkTime(1000)), 470, 'melee attack time should use the L2J 470000/rate constant');
assert.strictEqual(Formulas.calcMeleeAtkTime(1), 2700, 'melee attack time should keep the L2J low-rate guard');
assert.strictEqual(Math.round(Formulas.calcRemoteAtkTime(1500, 333)), 1500, 'skill hit time should scale with the 333/rate constant');

const attack = new Attack();
const magicActor = actor();
magicActor.spiritshotLoaded = true;
const castDamage = attack.prepareSkillDamage(magicActor, target(), skill({ spell: true, power: 10 }), true, () => 0.99);
assert.strictEqual(castDamage, 257, 'magic skill damage should follow C4 magic formula with spiritshot');
assert.strictEqual(magicActor.spiritshotLoaded, false, 'magic skill should clear used spiritshot charge');

const physicalActor = actor();
physicalActor.soulshotLoaded = true;
const strikeDamage = attack.prepareSkillDamage(physicalActor, target(), skill({ spell: false, power: 25 }), false, () => 0.99);
assert.strictEqual(strikeDamage, 158, 'physical skill damage should follow C4 physical formula with soulshot');
assert.strictEqual(physicalActor.soulshotLoaded, false, 'physical skill should clear used soulshot charge');

const physicalChargeActor = actor();
let soulshotConsumed = false;
let spiritshotConsumed = false;
physicalChargeActor.backpack.consumeSoulshot = (session, callback) => {
    soulshotConsumed = true;
    callback(true);
};
physicalChargeActor.backpack.consumeSpiritshot = (session, callback) => {
    spiritshotConsumed = true;
    callback(true);
};
attack.chargeShotForSkill({
    actor: physicalChargeActor,
    dataSendToMeAndOthers() {}
}, physicalChargeActor, false);
assert.strictEqual(soulshotConsumed, true, 'physical skill should try to charge soulshot');
assert.strictEqual(spiritshotConsumed, false, 'physical skill should not try to charge spiritshot');
assert.strictEqual(physicalChargeActor.soulshotLoaded, true, 'physical skill should load soulshot on successful consume');

const magicChargeActor = actor();
soulshotConsumed = false;
spiritshotConsumed = false;
magicChargeActor.backpack.consumeSoulshot = (session, callback) => {
    soulshotConsumed = true;
    callback(true);
};
magicChargeActor.backpack.consumeSpiritshot = (session, callback) => {
    spiritshotConsumed = true;
    callback(true);
};
attack.chargeShotForSkill({
    actor: magicChargeActor,
    dataSendToMeAndOthers() {}
}, magicChargeActor, true);
assert.strictEqual(soulshotConsumed, false, 'magic skill should not try to charge soulshot');
assert.strictEqual(spiritshotConsumed, true, 'magic skill should try to charge spiritshot');
assert.strictEqual(magicChargeActor.spiritshotLoaded, true, 'magic skill should load spiritshot on successful consume');

console.log('Skill damage formula checks passed');
