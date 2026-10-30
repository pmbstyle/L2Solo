'use strict';

// Domain service: the outcome of one hit from two fighters' numbers
// (CombatantView) and the hit's context. The hot Attack (prepareMeleeHit,
// prepareNpcMeleeHit, prepareSkillDamage) and the cold fight
// (BackgroundResolver) both resolve hits here, so a rule changed here changes
// both. The hit roll itself (Formulas.hitChance) is the caller's: a normal
// attack can miss, a skill cannot.
//
// Context: soulshot / spiritshot / blessedSpiritshot (loaded), facing (the
// defender faces the attacker: its shield can block), bow (the attacker
// shoots: a shield blocks more), modifier (the product of the target's
// weapon, element, race and undead terms the adapter knows), and for a melee
// anger() (the attacker's critical anger bonus, read only on a critical
// that is not blocked) and spreadRng (the weapon spread's roll; hot leaves it
// to Math.random). Returns { damage, critical, shield }.
const Formulas = invoke('GameServer/Formulas');

function shieldRoll(defender, { facing = true, bow = false } = {}, rng) {
    return Formulas.rollShieldUse({ shieldRate: defender.shieldRate, dex: defender.dex, facing, bow }, rng);
}

function guardedPDef(defender, shield) {
    return defender.pDef + (shield === Formulas.SHIELD_DEFENSE_SUCCEED ? defender.shieldPDef : 0);
}

function melee(attacker, defender, context = {}, rng = Math.random) {
    const shield = shieldRoll(defender, context, rng);
    const critical = Formulas.rollCritical(attacker.critRate, rng);
    const blocked = shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK;
    const anger = critical && !blocked && context.anger ? Number(context.anger()) || 0 : 0;
    const damage = blocked ? 1 : Math.round(Formulas.calcMeleeDamage(attacker.pAtk, attacker.pAtkRnd, guardedPDef(defender, shield), {
        critical,
        soulshot: context.soulshot === true,
        criticalDamageMultiplier: attacker.critDamageMul,
        criticalDamageAdd: attacker.critDamageAdd + anger,
        rng: context.spreadRng
    }) * (context.modifier ?? 1));
    return { damage, critical, shield, anger: anger > 0 };
}

// A physical skill's critical rate (per mille): its base rate x 10 by the
// attacker's STR (Lisvus calcCrit for skills); none without a base rate.
function physicalSkillCritRate(semantic, str) {
    const base = Number(semantic?.baseCritRate) || 0;
    return base > 0 ? base * 10 * Formulas.calcBaseMod.STR(Math.max(1, Math.round(Number(str) || 1))) : 0;
}

// context.power (the skill's, after Fatal / Death Link), blow (a blow's
// formula), skillCritRate (physicalSkillCritRate).
function physicalSkill(attacker, defender, context = {}, rng = Math.random) {
    const shield = shieldRoll(defender, context, rng);
    if (shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK) return { damage: 1, critical: false, shield };
    const formula = context.blow ? Formulas.calcBlowDamage : Formulas.calcPhysicalDamage;
    let damage = Math.round(formula.call(Formulas, attacker.pAtk, attacker.pAtkRnd, guardedPDef(defender, shield), context.power, {
        soulshot: context.soulshot === true,
        criticalDamageMultiplier: attacker.critDamageMul,
        criticalDamageAdd: attacker.critDamageAdd,
        rng
    }) * (context.modifier ?? 1));
    const critical = context.skillCritRate > 0 && Formulas.rollCritical(context.skillCritRate, rng);
    if (critical) damage *= 2;
    return { damage, critical, shield };
}

function magicSkill(attacker, defender, context = {}, rng = Math.random) {
    const critical = Formulas.rollCritical(attacker.mCritRate, rng);
    const damage = Math.round(Formulas.calcMagicDamage(attacker.mAtk, context.power, defender.mDef, {
        spiritshot: context.spiritshot === true, blessedSpiritshot: context.blessedSpiritshot === true, magicCritical: critical
    }) * (context.modifier ?? 1));
    return { damage, critical, shield: Formulas.SHIELD_DEFENSE_FAILED };
}

// Expected damage of one hit, for planning (the solo gate: BotTargetMatchup):
// the mean of the very rules above over their rolls, so the gate and the
// fight read one formula. The shield's outcomes by Formulas.shieldChances,
// a critical by its rate, the weapon spread at its mean; context as the
// rolled rule's, plus hitChance (a normal attack's hit roll, the caller's:
// Formulas.hitChance) and landChance (a blow's, in 0..1).
const MEAN_ROLL = () => 0.5;
function overShield(defender, context, hit) {
    const { perfect, succeed } = Formulas.shieldChances({ shieldRate: defender.shieldRate, dex: defender.dex,
        facing: context.facing ?? true, bow: context.bow === true });
    return perfect * 1 + succeed * hit(guardedPDef(defender, Formulas.SHIELD_DEFENSE_SUCCEED))
        + (1 - perfect - succeed) * hit(defender.pDef);
}
function expectedMelee(attacker, defender, context = {}) {
    const critical = Math.min(1, Math.max(0, attacker.critRate) / 1000);
    const damage = overShield(defender, context, pDef => {
        const hit = crit => Formulas.calcMeleeDamage(attacker.pAtk, attacker.pAtkRnd, pDef, { critical: crit,
            soulshot: context.soulshot === true, criticalDamageMultiplier: attacker.critDamageMul,
            criticalDamageAdd: attacker.critDamageAdd, rng: MEAN_ROLL });
        return (1 - critical) * hit(false) + critical * hit(true);
    });
    return damage * (context.modifier ?? 1) * (context.hitChance ?? 1);
}
function expectedPhysicalSkill(attacker, defender, context = {}) {
    const formula = context.blow ? Formulas.calcBlowDamage : Formulas.calcPhysicalDamage;
    const critical = Math.min(1, Math.max(0, Number(context.skillCritRate) || 0) / 1000);
    const damage = overShield(defender, context, pDef => formula.call(Formulas, attacker.pAtk, attacker.pAtkRnd, pDef, context.power, {
        soulshot: context.soulshot === true, criticalDamageMultiplier: attacker.critDamageMul,
        criticalDamageAdd: attacker.critDamageAdd, rng: MEAN_ROLL }) * (1 + critical));
    return damage * (context.modifier ?? 1) * (context.landChance ?? 1);
}
function expectedMagicSkill(attacker, defender, context = {}) {
    const critical = Math.min(1, Math.max(0, attacker.mCritRate) / 1000);
    const hit = magicCritical => Formulas.calcMagicDamage(attacker.mAtk, context.power, defender.mDef, {
        spiritshot: context.spiritshot === true, blessedSpiritshot: context.blessedSpiritshot === true, magicCritical });
    return ((1 - critical) * hit(false) + critical * hit(true)) * (context.modifier ?? 1);
}

// An effect's resistance stats by its trait (Lisvus: stun via shock, cancel
// via the banes), and its land chance in percent (Lisvus calcSkillSuccess,
// Formulas.calcSkillEffectSuccessRate): attacker { level, mAtk, soulshot,
// spiritshot, blessedSpiritshot }, target { level, mDef }, resistModifier
// (traitResistModifier of the target's resist and vulnerability).
const RESIST_FAMILY_BY_TRAIT = {
    shock: { resist: 'stunResist', vulnerability: 'stunVuln' },
    warrior_bane: { resist: 'cancelResist', vulnerability: 'cancelVuln' },
    mage_bane: { resist: 'cancelResist', vulnerability: 'cancelVuln' }
};
function resistStats(trait) {
    return RESIST_FAMILY_BY_TRAIT[trait] || { resist: `${trait}Resist`, vulnerability: `${trait}Vuln` };
}
function traitResistModifier(resist, vulnerability) {
    const vuln = Number(vulnerability);
    return Math.max(0, 1 - ((Number(resist) || 0) / 100)) * Math.max(0, Number.isFinite(vuln) ? vuln : 1);
}
function effectLandChance(semantic, magic, attacker, target, resistModifier = 1) {
    const effectTrait = semantic.effectTrait || semantic.trait;
    // Lisvus calcSkillSuccess defaults unset lvlDepend to 1 for PARALYZE
    // and FEAR, and to 2 for every other effect type.
    const levelDepend = semantic.levelDepend || (
        semantic.effect === 'paralyze' || semantic.effect === 'fear' || effectTrait === 'paralyze' || effectTrait === 'fear' ? 1 : 2);
    return Formulas.calcSkillEffectSuccessRate({
        baseChance: semantic.baseLandRate, magic, mAtk: attacker.mAtk, mDef: target.mDef,
        soulshot: !!attacker.soulshot, spiritshot: !!attacker.spiritshot, blessedSpiritshot: !!attacker.blessedSpiritshot,
        attackerLevel: attacker.level, targetLevel: target.level, magicLevel: semantic.magicLevel, levelDepend, resistModifier
    });
}

// A blow's land chance in percent (L2J C4 Formulas.calcBlow): a blow that
// needs the rear lands only from behind; one that needs a critical (Deadly
// Blow, Mortal Blow) lands 70% from behind, 60% from the side, 50% from the
// front, by DEX and blowRateMul (rateMul: the attacker's whole multiplier at
// that position); any other lands.
const COND_BEHIND = 0x0008, COND_CRIT = 0x0010;
function blowLandChance(semantic, { dex = 20, rateMul = 1, behind = false, front = false } = {}) {
    const condition = Number(semantic?.requires?.condition) || 0;
    if ((condition & COND_BEHIND) !== 0 && !behind) return 0;
    if ((condition & COND_CRIT) === 0) return 100;
    const base = behind ? 70 : front ? 50 : 60;
    return Math.max(0, base * (1 + ((Number(dex) || 20) - 20) / 100) * rateMul);
}
// Whether a blow lands: only one that needs a critical rolls (rng).
function blowLands(semantic, position, rng = Math.random) {
    const chance = blowLandChance(semantic, position);
    if (chance <= 0) return false;
    return (Number(semantic?.requires?.condition) & COND_CRIT) === 0 || chance >= rng() * 100;
}

module.exports = { melee, physicalSkill, magicSkill, expectedMelee, expectedPhysicalSkill, expectedMagicSkill, physicalSkillCritRate, blowLandChance, blowLands, resistStats, traitResistModifier,
    effectLandChance };
