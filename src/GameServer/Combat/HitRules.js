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
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

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

// The target's terms of a hit, one copy for the hot Attack, the cold fight
// and the solo gate (BotTargetMatchup, T124). A spell meets its element's
// weakness; a weapon hit its weapon's (bow, blunt), a physical skill also the
// dagger one (by its trait or a knife), and both the attacker's bonus against
// an undead target and against the target's race. hit { magic, skill, trait,
// weaponKind (the attacker's), race, undead (the target's) }; targetMul(stat)
// the target's multiplier of a weakness stat (1 without one); attackerMul(stat)
// the attacker's multiplier of a bonus stat.
const ELEMENTAL_DAMAGE_TRAITS = new Set(['fire', 'water', 'wind', 'earth', 'holy', 'dark']);
const PHYSICAL_RACE_STATS = Object.freeze({
    animal: 'pAtk-animals',
    beast: 'pAtk-monsters',
    construct: 'pAtk-mcreatures',
    dragon: 'pAtk-dragons',
    giant: 'pAtk-giants',
    insect: 'pAtk-insects',
    plant: 'pAtk-plants'
});
function elementVulnStat(trait) {
    return ELEMENTAL_DAMAGE_TRAITS.has(trait) ? `${trait}Vuln` : null;
}
function weaponVulnStat(weaponKind = '', trait = '', skill = false) {
    if (trait === 'bow' || weaponKind === 'Weapon.Bow') return 'bowWpnVuln';
    if (weaponKind === 'Weapon.Blunt' || weaponKind === 'Weapon.BigBlunt') return 'bluntWpnVuln';
    if (skill && (trait === 'dagger' || weaponKind === 'Weapon.Knife')) return 'daggerWpnVuln';
    return null;
}
function raceStat(race) {
    return PHYSICAL_RACE_STATS[String(race || '').toLowerCase()] || null;
}
function targetModifier(hit, targetMul, attackerMul) {
    if (hit.magic) {
        const stat = elementVulnStat(hit.trait);
        return stat ? targetMul(stat) : 1;
    }
    const weapon = weaponVulnStat(hit.weaponKind, hit.trait, hit.skill === true);
    let modifier = weapon ? targetMul(weapon) : 1;
    if (hit.undead === true) modifier *= attackerMul('pAtkUndeadMul');
    const race = raceStat(hit.race);
    if (race) modifier *= attackerMul(race);
    return modifier;
}

// A skill's power by its caster's HP (Lisvus): Death Link grows as the HP
// falls (Formulas.calcDeathLinkPower), Fatal from none at full HP; any other
// skill keeps its power.
function skillPower(semantic, power, hp, maxHp) {
    if (semantic?.skillType === C4SkillRules.DEATH_LINK) return Formulas.calcDeathLinkPower(power, hp, maxHp);
    if (semantic?.skillType === C4SkillRules.FATAL) return Formulas.calcFatalPower(power, hp, maxHp);
    return Number(power) || 0;
}

// The older C4 magic level-fail roll (Lisvus calcMagicSuccess via
// Formulas.calcMagicSuccessRate): an offensive spell whose effect has no
// land rate of its own (a nuke, a drain) fails whole by the target's level
// over the skill's magic level. rollsMagicLevel: whether a skill rolls it;
// magicLevelChance: its chance in percent; magicLevelLands: the roll.
const EFFECT_FORMULA_TYPES = new Set([C4SkillRules.EFFECT, C4SkillRules.DAMAGE_EFFECT, C4SkillRules.CANCEL, C4SkillRules.BANE,
    C4SkillRules.AGGRO_REMOVE, C4SkillRules.AGGRO_REDUCE_CHAR]);
function offensive(semantic) {
    return semantic.target !== 'self' && semantic.effectType !== 'buff';
}
function rollsMagicLevel(semantic, magic) {
    return magic === true && offensive(semantic) && semantic.skillType !== C4SkillRules.BLOW
        && !EFFECT_FORMULA_TYPES.has(semantic.skillType);
}
function magicLevelChance(semantic, attackerLevel, targetLevel) {
    return Formulas.calcMagicSuccessRate({ attackerLevel, targetLevel, magicLevel: semantic.magicLevel, levelDepend: semantic.levelDepend });
}
function magicLevelLands(semantic, attackerLevel, targetLevel, rng = Math.random) {
    return magicLevelChance(semantic, attackerLevel, targetLevel) >= rng() * 100;
}

// A lethal strike after a skill's hit (Lisvus, C4SkillEffects.applyLethal):
// semantic.lethal { sourceFormula } leaves the target at 1 HP by
// Formulas.calcLethalStrikeChance (never a raid boss, a boss, a door or a
// flag: guarded), else killChance (to 1 HP) or halfKillChance (to half its
// max HP). target { level, hp, maxHp, guarded }, attacker { level },
// skillLevel (the magic level's stand-in). Returns null, or { kind:
// 'lethal' | 'kill' | 'half', hp: the HP the target is left at at most }.
function lethalStrike(semantic, attacker, target, skillLevel, rng = Math.random) {
    const lethal = semantic?.lethal;
    if (!lethal) return null;
    const maxHp = Number(target.maxHp) || 0, hp = Number(target.hp) || 0;
    if (maxHp <= 1 || hp <= 1) return null;
    if (lethal.sourceFormula === true) {
        if (target.guarded === true) return null;
        const chance = Formulas.calcLethalStrikeChance(attacker.level, target.level, semantic.magicLevel ?? skillLevel);
        return chance > rng() * 100 ? { kind: 'lethal', hp: 1 } : null;
    }
    const killChance = Number(lethal.killChance) || 0;
    if (killChance > 0 && killChance >= rng() * 100) return { kind: 'kill', hp: 1 };
    const halfKillChance = Number(lethal.halfKillChance) || 0;
    if (halfKillChance > 0 && halfKillChance >= rng() * 100) return { kind: 'half', hp: Math.max(1, Math.floor(maxHp / 2)) };
    return null;
}

// HP a hit gives back to its attacker by life steal (absorbDam, percent:
// a weapon SA, Vampiric Rage; hot Attack.applyDamageAbsorb): of the HP the
// target lost, up to what the attacker misses. A bow hit steals none (the caller's).
function absorbedHp(percent, hpDamage, hp, maxHp) {
    if (!(percent > 0)) return 0;
    return Math.max(0, Math.min(Math.max(0, maxHp - hp), Math.floor(percent / 100 * Math.max(0, Number(hpDamage) || 0))));
}
// Damage a hit sends back to its attacker (reflectDam, percent; hot Attack.applyReflectedDamage).
function reflectedDamage(percent, damage) {
    return Math.floor(Math.max(0, Number(damage) || 0) * Math.max(0, Number(percent) || 0) / 100);
}

// An effect's damage over time (hot C4SkillEffects.dotFromSkill): { count,
// intervalMs, damage } of a skill at its level, or null without one.
function dotOf(semantic, level, power) {
    const dot = semantic?.dot;
    if (!dot) return null;
    let damage = dot.damage;
    if (damage == null && dot.damageByLevel) {
        damage = dot.damageByLevel[Math.max(0, Math.min(dot.damageByLevel.length - 1, (Number(level) || 1) - 1))];
    }
    return { count: dot.count, intervalMs: dot.intervalMs, damage: damage ?? power };
}

module.exports = { melee, physicalSkill, magicSkill, expectedMelee, expectedPhysicalSkill, expectedMagicSkill, physicalSkillCritRate, blowLandChance, blowLands, resistStats, traitResistModifier,
    effectLandChance, ELEMENTAL_DAMAGE_TRAITS, elementVulnStat, weaponVulnStat, raceStat, targetModifier, skillPower,
    rollsMagicLevel, magicLevelChance, magicLevelLands, lethalStrike, absorbedHp, reflectedDamage, dotOf };
