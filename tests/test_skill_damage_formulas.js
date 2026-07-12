const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Formulas = invoke('GameServer/Formulas');

function actor() {
    return {
        soulshotLoaded: false,
        spiritshotLoaded: false,
        fetchId: () => 2000001,
        fetchLocX: () => 1,
        fetchLocY: () => 2,
        fetchLocZ: () => 3,
        fetchHp: () => 1000,
        fetchMaxHp: () => 1000,
        fetchCollectivePAtk: () => 100,
        fetchCollectiveMAtk: () => 100,
        fetchCollectiveAtkSpd: () => 333,
        fetchCollectiveCastSpd: () => 666,
        backpack: {
            fetchTotalWeaponPAtkRnd: () => 0,
            isAutoShotEnabled: () => false,
            fetchAutoSpiritshotKind: () => null
        }
    };
}

function target() {
    return {
        effects: {},
        fetchCollectivePDef: () => 100,
        fetchCollectiveMDef: () => 50,
        fetchDex: () => 30,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHead: () => 8192
    };
}

function skill({ spell, power, trait, skillType }) {
    return {
        fetchSpell: () => spell,
        fetchPower: () => power,
        fetchSemantic: () => ({
            ...(trait ? { trait } : {}),
            ...(skillType ? { skillType } : {})
        })
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

const shieldedMagicTarget = target();
shieldedMagicTarget.fetchHead = () => 0;
shieldedMagicTarget.backpack = {
    fetchTotalShieldRate: () => 100,
    fetchTotalShieldPDef: () => 100
};
const shieldedMagicActor = actor();
shieldedMagicActor.fetchLocX = () => 1;
shieldedMagicActor.fetchLocY = () => 0;
const shieldedMagicDamage = attack.prepareSkillDamage(shieldedMagicActor, shieldedMagicTarget, skill({ spell: true, power: 10 }), true, () => 0.99);
assert.strictEqual(
    shieldedMagicDamage,
    magicNoShot,
    'magic skill damage should ignore shield P.Def and shield block rolls'
);

const blessedMagicActor = actor();
blessedMagicActor.spiritshotLoaded = true;
blessedMagicActor.blessedSpiritshotLoaded = true;
const blessedCastDamage = attack.prepareSkillDamage(blessedMagicActor, target(), skill({ spell: true, power: 10 }), true, () => 0.99);
assert.strictEqual(blessedCastDamage, Math.round(Formulas.calcMagicDamage(100, 10, 50, { blessedSpiritshot: true })), 'magic skill damage should use blessed spiritshot MAtk boost');
assert.strictEqual(blessedMagicActor.spiritshotLoaded, false, 'magic skill should clear used blessed spiritshot charge');
assert.strictEqual(blessedMagicActor.blessedSpiritshotLoaded, false, 'magic skill should clear blessed spiritshot marker');

const surrenderedTarget = target();
EffectStore.apply(surrenderedTarget, {
    key: 'surrender_to_earth',
    id: 1223,
    level: 15,
    type: 'debuff',
    stats: { earthVuln: 1.3 },
    durationMs: 15000
});
const earthDamage = attack.prepareSkillDamage(actor(), surrenderedTarget, skill({ spell: true, power: 10, trait: 'earth' }), true, () => 0.99);
assert.strictEqual(
    earthDamage,
    Math.round(Formulas.calcMagicDamage(100, 10, 50) * 1.3),
    'magic skill damage should apply sourced elemental vulnerability multipliers by trait'
);

const fullHpDeathLinkPower = Formulas.calcDeathLinkPower(108, 1000, 1000);
const lowHpDeathLinkPower = Formulas.calcDeathLinkPower(108, 250, 1000);
assert(Math.abs(fullHpDeathLinkPower - (108 * Math.pow(1.7165 - 1, 2) * 0.577)) < 1e-9, 'Death Link power should follow sourced full-HP L2J formula');
assert(lowHpDeathLinkPower > fullHpDeathLinkPower, 'Death Link power should increase as caster HP drops');
const deathLinkActor = actor();
deathLinkActor.fetchHp = () => 250;
deathLinkActor.fetchMaxHp = () => 1000;
const deathLinkDamage = attack.prepareSkillDamage(deathLinkActor, target(), skill({ spell: true, power: 108, trait: 'dark', skillType: 'deathLink' }), true, () => 0.99);
assert.strictEqual(
    deathLinkDamage,
    Math.round(Formulas.calcMagicDamage(100, lowHpDeathLinkPower, 50)),
    'Curse Death Link should scale magic damage with sourced caster-HP power modifier'
);
assert.strictEqual(
    Formulas.calcDrainHeal({ damage: 300, targetHp: 100, absorbPart: 0.8 }),
    80,
    'Drain should absorb from actual HP damage instead of overkill damage'
);
assert.strictEqual(
    Formulas.calcDrainHeal({ damage: 0, targetHp: 0, absorbAbs: 243 }),
    243,
    'Corpse drain should restore sourced absolute HP without damage'
);

const poisonVulnerableTarget = target();
EffectStore.apply(poisonVulnerableTarget, {
    key: 'surrender_to_poison',
    id: 1224,
    level: 17,
    type: 'debuff',
    stats: { poisonVuln: 1.3 },
    durationMs: 15000
});
const poisonDirectDamage = attack.prepareSkillDamage(actor(), poisonVulnerableTarget, skill({ spell: true, power: 10, trait: 'poison' }), true, () => 0.99);
assert.strictEqual(
    poisonDirectDamage,
    Math.round(Formulas.calcMagicDamage(100, 10, 50)),
    'non-elemental poison vulnerability should not be applied as direct magic damage'
);

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
assert.strictEqual(soulshotConsumed, false, 'physical skill should not charge soulshot before the hotbar toggle is enabled');
physicalChargeActor.backpack.isAutoShotEnabled = () => true;
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
const chargePackets = [];
magicChargeActor.backpack.consumeSoulshot = (session, callback) => {
    soulshotConsumed = true;
    callback(true);
};
magicChargeActor.backpack.consumeSpiritshot = (session, callback) => {
    spiritshotConsumed = true;
    callback(true, { skillId: 2157 });
};
magicChargeActor.backpack.fetchAutoSpiritshotKind = () => 'spiritshot';
attack.chargeShotForSkill({
    actor: magicChargeActor,
    dataSendToMeAndOthers(packet) { chargePackets.push(packet); }
}, magicChargeActor, true);
assert.strictEqual(soulshotConsumed, false, 'magic skill should not try to charge soulshot');
assert.strictEqual(spiritshotConsumed, true, 'magic skill should try to charge spiritshot');
assert.strictEqual(magicChargeActor.spiritshotLoaded, true, 'magic skill should load spiritshot on successful consume');
assert(chargePackets.some((packet) => packet[0] === 0x48 && packet.readInt32LE(9) === 2157), 'magic skill should broadcast the consumed spiritshot grade animation');

console.log('Skill damage formula checks passed');
