// Per class and level, the C4 template's max HP, MP and CP before the CON/MEN
// bonus (L2J Mobius C4 lvlUpgainData, data/Templates/class-vitals.json; user
// 10-29 "Max HP by class" in docs/game-decisions.md). Levels past the table
// read its last row; an unknown class reads the Human Fighter's.
const CLASS_VITALS = require('../../data/Templates/class-vitals.json').classes;

function classVital(kind, level, classId) {
    const rows = (CLASS_VITALS[Number(classId)] || CLASS_VITALS[0])[kind];
    const index = Math.min(rows.length, Math.max(1, Math.floor(Number(level) || 1))) - 1;
    return rows[index];
}

function magicFailureThreshold(attackerLevel, targetLevel, magicLevel) {
    const effectiveMagicLevel = Number(magicLevel) > 0 ? Number(magicLevel) : (Number(attackerLevel) || 1);
    return Math.round(Math.pow(1.3, (Number(targetLevel) || 1) - effectiveMagicLevel) * 100);
}

const Formulas = {
    SHIELD_DEFENSE_FAILED: 0,
    SHIELD_DEFENSE_SUCCEED: 1,
    SHIELD_DEFENSE_PERFECT_BLOCK: 2,
    DEFAULT_SHIELD_RATE: 20,
    DEFAULT_SHIELD_DEFENCE_ANGLE: 120,
    DEFAULT_PERFECT_SHIELD_BLOCK_RATE: 0,
    // A player's HP and MP regain one tick every 3 s (Automation.replenishVitals).
    REGEN_TICK_MS: 3000,

    calcBaseMod: (() => {
        function func(start, end, base, multiplier) {
            for (let i = start; i < end; i++, base += (base * multiplier));
            return base;
        }

        return {
            STR: (data) => { return func( 1, data, 0.30, 0.036219821012); },
            DEX: (data) => { return func(21, data, 1.01, 0.009553766764); },
            CON: (data) => { return func( 1, data, 0.46, 0.029863478935); },
            INT: (data) => { return func( 6, data, 0.61, 0.019828637467); },
            WIT: (data) => { return func( 0, data, 0.40, 0.049719998399); },
            MEN: (data) => { return func(25, data, 1.28, 0.010330633552); },
        };
    })(),

    getParentClassId(classId) {
        const thirdClass = invoke('GameServer/ClassProgression').getThirdClass(classId);
        if (thirdClass) return this.getParentClassId(thirdClass.parentClassId);
        if (classId >= 0 && classId <= 9) return 0;
        if (classId >= 10 && classId <= 17) return 10;
        if (classId >= 18 && classId <= 24) return 18;
        if (classId >= 25 && classId <= 30) return 25;
        if (classId >= 31 && classId <= 37) return 31;
        if (classId >= 38 && classId <= 43) return 38;
        if (classId >= 44 && classId <= 48) return 44;
        if (classId >= 49 && classId <= 52) return 49;
        if (classId >= 53 && classId <= 57) return 53;
        return 0;
    },

    // Max HP, MP and CP: the class's C4 template value at the level
    // (classVital) times the CON (HP, CP) or MEN (MP) bonus.
    calcHp(level, classId, con) {
        return classVital('hp', level, classId) * this.calcBaseMod.CON(con);
    },

    calcMp(level, classId, men) {
        return classVital('mp', level, classId) * this.calcBaseMod.MEN(men);
    },

    calcCp(level, classId, con) {
        return classVital('cp', level, classId) * this.calcBaseMod.CON(con);
    },

    calcMaxLoad(con) {
        return this.calcBaseMod.CON(con) * 69000;
    },

    calcLevelMod(level) {
        return (level + 89) / 100;
    },

    calcAcquiredExp(level, mod) {
        return Math.pow(level, 2) * mod;
    },

    calcPAtk(level, str, wpnPAtk) {
        let levelMod = this.calcLevelMod(level);
        let strMod   = this.calcBaseMod.STR(str);
        return levelMod * strMod * wpnPAtk;
    },

    calcMAtk(level, int, wpnMAtk) {
        let levelMod = Math.pow(this.calcLevelMod(level), 2);
        let intMod   = Math.pow(this.calcBaseMod.INT(int), 2);
        return levelMod * intMod * wpnMAtk;
    },

    calcPDef(level, armPDef) {
        let levelMod = this.calcLevelMod(level);
        return levelMod * (armPDef + 4);
    },

    calcMDef(level, men, armMDef) {
        let levelMod = this.calcLevelMod(level);
        let menMod   = this.calcBaseMod.MEN(men);
        return levelMod * menMod * armMDef;
    },

    calcAccur(level, dex, wpnAccur) {
        return (utils.sqrt(dex) * 6) + level + wpnAccur;
    },

    calcEvasion(level, dex, armEvasion) {
        return (utils.sqrt(dex) * 6) + level + armEvasion;
    },

    calcCritical(dex, wpnCrit) {
        let dexMod = this.calcBaseMod.DEX(dex);
        return dexMod * wpnCrit;
    },

    calcAtkSpd(dex, wpnAtkSpd) {
        let dexMod = this.calcBaseMod.DEX(dex);
        return dexMod * wpnAtkSpd;
    },

    calcAtkSpdMultiplier(atkSpd, calculatedAtkSpd) {
        return (1.1 * calculatedAtkSpd) / atkSpd;
    },

    calcCastSpd(wit) {
        let witMod = this.calcBaseMod.WIT(wit);
        return 333 * witMod;
    },

    calcSpeed(dex, speed) {
        let dexMod = this.calcBaseMod.DEX(dex);
        return dexMod * speed;
    },

    calcMeleeAtkTime(atkSpd) {
        const rate = Number(atkSpd) || 0;
        return rate < 2 ? 2700 : 470000 / rate;
    },

    calcBowAttackTimes(atkSpd, reuseDelay = 1500, reuseModifier = 1) {
        const rate = Number(atkSpd) || 0;
        if (rate < 2) {
            return { drawMs: 2700, reuseMs: 2700, cycleMs: 5400 };
        }

        // C4 bows have a separate draw and weapon-reuse phase. Both phases
        // scale with physical attack speed using the 345 reference rate.
        const drawMs = (1500 * 345) / rate;
        const baseReuse = Math.max(0, Number(reuseDelay) || 0);
        const modifier = Number.isFinite(Number(reuseModifier))
            ? Math.max(0, Number(reuseModifier))
            : 1;
        const reuseMs = (baseReuse * modifier * 345) / rate;
        return { drawMs, reuseMs, cycleMs: drawMs + reuseMs };
    },

    // One normal attack's draw and whole cycle, as hot players and monsters
    // attack (Attack.js, Npc.js): a bow draws and reloads
    // (calcBowAttackTimes), any other weapon swings once per calcMeleeAtkTime
    // and lands at 64.4% of it.
    attackTimes(atkSpd, { bow = false, reuseDelay = 1500, reuseMul = 1 } = {}) {
        if (bow) return this.calcBowAttackTimes(atkSpd, reuseDelay ?? 1500, reuseMul);
        const cycleMs = this.calcMeleeAtkTime(atkSpd);
        return { drawMs: cycleMs * 0.644, cycleMs };
    },

    normalAttackMs(atkSpd, options = {}) {
        return this.attackTimes(atkSpd, options).cycleMs;
    },

    calcRemoteAtkTime(time, castSpd) {
        return  (time / castSpd) * 333;
    },

    // Lisvus L2Character.doCast (L2Character.java:1422-1466): a skill's cast
    // time scales with the speed the caller passes (cast speed for magic,
    // attack speed for physical skills), a spiritshot cuts a magic cast to
    // 70%, a static skill keeps its base time, and a skill whose base time
    // is at least 500 ms never casts faster than 500 ms.
    calcSkillHitTime(baseHitTime, speed, { magic = false, spiritshot = false, staticHitTime = false } = {}) {
        const base = Math.max(0, Number(baseHitTime) || 0);
        if (staticHitTime) return base;
        let hitTime = this.calcRemoteAtkTime(base, speed);
        if (magic && spiritshot) hitTime = Math.floor(hitTime * 0.70);
        return base >= 500 ? Math.max(500, hitTime) : hitTime;
    },

    // Lisvus C4 calcAtkBreak: a casting target starts at 15%, incoming
    // damage raises the chance, MEN lowers it, and Concentration-style
    // effects modify the final ATTACK_CANCEL stat.
    calcCastBreakChance({ damage = 0, men = 0, cancelAdd = 0 } = {}) {
        let chance = 15 + Math.sqrt(13 * Math.max(0, Number(damage) || 0));
        chance -= (this.calcBaseMod.MEN(Math.max(0, Number(men) || 0)) * 100) - 100;
        chance += Number(cancelAdd) || 0;
        return Math.max(1, Math.min(99, chance));
    },

    calcMeleeHit(pAtk, pAtkRnd, pDef) {
        return this.calcMeleeDamage(pAtk, pAtkRnd, pDef);
    },

    calcMeleeDamage(pAtk, pAtkRnd, pDef, { critical = false, soulshot = false, skillPower = 0, criticalDamageMultiplier = 1, criticalDamageAdd = 0, rng } = {}) {
        const variation = rng ? Math.floor(rng() * (2 * pAtkRnd + 1)) - pAtkRnd : utils.oneFromSpan(-pAtkRnd, pAtkRnd);
        const pAtkRndMul = 1 + variation / 100;
        let damage = (pAtk * (soulshot ? 2 : 1)) + (Number(skillPower) || 0);

        if (critical) {
            damage = 2 * Math.max(0, Number(criticalDamageMultiplier) || 1) * (70 * damage / pDef);
            damage += ((Number(criticalDamageAdd) || 0) * 70) / pDef;
        }
        else {
            damage = 70 * damage / pDef;
        }

        return damage * pAtkRndMul;
    },

    calcPhysicalDamage(pAtk, pAtkRnd, pDef, power, options = {}) {
        return this.calcMeleeDamage(pAtk, pAtkRnd, pDef, {
            ...options,
            skillPower: power
        });
    },

    // Lisvus Formulas.calcBlowDamage: a blow applies the critical-damage
    // multiplier to P.Atk plus skill power, then adds the amplified flat
    // critical-damage bonus before the normal 70 / P.Def scaling.
    // A soulshot doubles P.Atk as on every physical skill (T113: Lisvus
    // Formulas.java:1196-1203, L2J 2007 calcBlowDamage; Mobius C4's 1.458
    // belongs to its H5 formula with 77, marked unconfirmed by its author).
    calcBlowDamage(pAtk, pAtkRnd, pDef, power, { soulshot = false, criticalDamageMultiplier = 1, criticalDamageAdd = 0, rng = Math.random } = {}) {
        let damage = (pAtk * (soulshot ? 2 : 1)) + (Number(power) || 0);
        damage = (Math.max(0, Number(criticalDamageMultiplier) || 1) * damage)
            + ((Number(criticalDamageAdd) || 0) * 6.5);
        return (70 * damage / Math.max(1, pDef))
            + (Math.max(0, Number(pAtkRnd) || 0) * Math.max(0, Math.min(1, Number(rng()) || 0)));
    },

    // Lisvus C4 magic critical rate in per mille (CharStat.getMCriticalHit,
    // FuncMAtkCritical in Formulas.java:390-415): base 8, times the WIT bonus
    // when the caster holds a weapon, times the magic-critical multipliers,
    // plus flat bonuses, capped at 300 (MaxMCritRate). The WIT bonus is the
    // server's own table, the one cast speed uses.
    magicCriticalRate({ multiplier = 1, add = 0, wit = 0, weapon = false } = {}) {
        const witBonus = weapon ? this.calcBaseMod.WIT(Number(wit) || 0) : 1;
        return Math.min(300, Math.max(0, (8 * witBonus * multiplier) + add));
    },

    // The hit chance of a normal attack, 0.2..0.98: 80 + 2 x (accuracy -
    // evasion) %, the attacker higher by 50 +3 % (lower -3 %), from behind
    // +10 %, from the side +5 %. The hot hit (calcHitChance) and the cold
    // fight (BackgroundResolver.hitSucceeds; HuntCycle) both read it.
    hitChance(accuracy, evasion, context = {}, zDiff = 0) {
        let modifier = 100;
        if (zDiff > 50) modifier += 3;
        else if (zDiff < -50) modifier -= 3;
        if (context.behind) modifier += 10;
        else if (context.front === false) modifier += 5;
        if (context.night) modifier -= 10;
        const chance = (80 + 2 * ((Number(accuracy) || 0) - (Number(evasion) || 0))) * 10 * modifier / 100;
        return Math.max(Math.min(chance, 980), 200) / 1000;
    },

    rollCritical(critical, rng = Math.random) {
        return (Number(critical) || 0) > rng() * 1000;
    },

    // The shield's block rate in percent (DEX and a bow's shot applied), 0
    // without a shield or from behind: rollShieldUse rolls it, shieldChances
    // gives its expected outcomes.
    shieldBlockRate({ shieldRate = 0, dex = 0, facing = true, bow = false } = {}) {
        if ((Number(shieldRate) || 0) <= 0 || !facing) return 0;
        const rate = Number(shieldRate) * this.calcBaseMod.DEX(Math.max(0, Math.min(Math.round(Number(dex) || 0), 99)));
        return bow ? rate * 1.3 : rate;
    },

    // The chances of rollShieldUse's outcomes: { perfect, succeed } (the rest fails).
    shieldChances({ perfectBlockRate = this.DEFAULT_PERFECT_SHIELD_BLOCK_RATE, ...shield } = {}) {
        const rate = this.shieldBlockRate(shield);
        if (!(rate > 0)) return { perfect: 0, succeed: 0 };
        const perfect = Math.min(1, Math.max(0, Number(perfectBlockRate || 0) / 100));
        return { perfect, succeed: (1 - perfect) * Math.min(1, rate / 100) };
    },

    rollShieldUse({ shieldRate = 0, dex = 0, facing = true, bow = false, perfectBlockRate = this.DEFAULT_PERFECT_SHIELD_BLOCK_RATE } = {}, rng = Math.random) {
        const rate = this.shieldBlockRate({ shieldRate, dex, facing, bow });
        if (rate <= 0) return this.SHIELD_DEFENSE_FAILED;

        if (100 - Number(perfectBlockRate || 0) < rng() * 100) {
            return this.SHIELD_DEFENSE_PERFECT_BLOCK;
        }

        return rate > rng() * 100
            ? this.SHIELD_DEFENSE_SUCCEED
            : this.SHIELD_DEFENSE_FAILED;
    },

    calcHitChance(attacker, target, rng = Math.random, context = {}) {
        const accuracy = safeNumber(attacker?.fetchCollectiveAccur?.(), safeNumber(attacker?.fetchAccur?.(), 0));
        const evasion = safeNumber(target?.fetchCollectiveEvasion?.(), safeNumber(target?.fetchEvasion?.(), 0));
        const zDiff = safeNumber(attacker?.fetchLocZ?.(), 0) - safeNumber(target?.fetchLocZ?.(), 0);
        return this.hitChance(accuracy, evasion, context, zDiff) >= rng();
    },

    calcMagicDamage(mAtk, power, mDef, { spiritshot = false, blessedSpiritshot = false, magicCritical = false } = {}) {
        let boostedMAtk = Number(mAtk) || 0;
        if (blessedSpiritshot) boostedMAtk *= 4;
        else if (spiritshot) boostedMAtk *= 2;

        let damage = (91 * utils.sqrt(boostedMAtk) * power) / mDef;
        if (magicCritical) damage *= 4;
        return damage;
    },

    // Lisvus/L2J DEATHLINK: L2Skill.getPower scales skill power by caster HP ratio.
    calcDeathLinkPower(power, currentHp, maxHp) {
        const max = Number(maxHp) || 0;
        const current = Number(currentHp) || 0;
        const hpRatio = max > 0 ? current / max : 1;
        return (Number(power) || 0) * Math.pow(1.7165 - hpRatio, 2) * 0.577;
    },

    // Lisvus/L2J FATAL: damage grows linearly from zero at full HP to 3.5x
    // skill power as the caster approaches zero HP.
    calcFatalPower(power, currentHp, maxHp) {
        const max = Number(maxHp) || 0;
        const current = Number(currentHp) || 0;
        const hpRatio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 1;
        return (Number(power) || 0) * 3.5 * (1 - hpRatio);
    },

    // Lisvus C4 lethal-strike chance used by Lethal Shot/Blow. The returned
    // value is a percentage and intentionally preserves the source's three
    // level-difference bands.
    calcLethalStrikeChance(attackerLevel, targetLevel, magicLevel) {
        const attacker = Math.max(1, Number(attackerLevel) || 1);
        const target = Math.max(1, Number(targetLevel) || 1);
        const magic = Number(magicLevel) || 0;
        if (magic <= 0) return 2 * (attacker / target);

        const delta = Math.floor((magic + attacker) / 2) - 1 - target;
        if (delta >= -3) return 2 * (attacker / target);
        // Lisvus performs this division with Java ints, so the middle band
        // evaluates to zero rather than a fractional percentage.
        if (delta >= -9) return -3 * Math.trunc(2 / delta);
        return 2 / 15;
    },

    calcDrainHeal({ damage = 0, targetHp = 0, absorbPart = 0, absorbAbs = 0 } = {}) {
        const drainableDamage = Math.min(Math.max(0, Number(damage) || 0), Math.max(0, Number(targetHp) || 0));
        return Math.max(0, (Number(absorbAbs) || 0) + ((Number(absorbPart) || 0) * drainableDamage));
    },

    // C4 Heal handler (T112: L2J C4 2006 Heal.java:84-112, Lisvus Heal.java:89-139):
    // power x1.5 with Blessed Spiritshot, x1.3 with Spiritshot; M.Atk does not
    // enter (Mobius C4's sqrt(M.Atk) is its H5 handler). Stat bonuses need real effect stats first.
    calcHealAmount(power, { spiritshot = false, blessedSpiritshot = false } = {}) {
        let amount = Number(power) || 0;
        if (blessedSpiritshot) amount *= 1.5;
        else if (spiritshot) amount *= 1.3;
        return Math.max(0, amount);
    },

    // Lisvus C4 ManaHeal MANARECHARGE: target gainMp stat is added to skill power,
    // then high-level targets receive a level-difference penalty.
    calcManaRechargeAmount({ power = 0, gainMp = 0, casterLevel = 1, targetLevel = 1 } = {}) {
        let amount = (Number(power) || 0) + (Number(gainMp) || 0);
        const levelDiff = (Number(targetLevel) || 1) - (Number(casterLevel) || 1);
        if (levelDiff > 5 && amount > 0) {
            amount -= levelDiff * (amount / 20);
        }
        return Math.max(0, amount);
    },

    // Adapted from L2J/aCis magic failure: target level over magic level raises fail chance by 1.3^diff.
    calcMagicSuccessRate({ attackerLevel = 1, targetLevel = 1, magicLevel = 0, levelDepend = 0 } = {}) {
        const effectiveMagicLevel = Number(magicLevel) > 0 ? Number(magicLevel) : (Number(attackerLevel) || 1);
        const levelDifference = (Number(targetLevel) || 1) - (effectiveMagicLevel + (Number(levelDepend) || 0));
        let failRate = 100;
        if (levelDifference > 0) {
            failRate = Math.pow(1.3, levelDifference) * 100;
        }
        failRate = Math.min(failRate, 9900);
        return Math.max(1, Math.min(99, 100 - (failRate / 100)));
    },

    // Lisvus calcMagicSuccess: this older C4 failure roll is separate from
    // effect land-rate/resistance calculations and is used by Spoil handlers.
    calcMagicSuccess({ attackerLevel = 1, targetLevel = 1, magicLevel = 0 } = {}, rng = Math.random) {
        const failureThreshold = magicFailureThreshold(attackerLevel, targetLevel, magicLevel);
        return Math.floor(rng() * 10000) > failureThreshold;
    },

    // Lisvus Spoil.java (Spoil, Spoil Festival) and the extra SPOIL handler of
    // Spoil Crush: a spoil lands only when calcMagicSuccess passes for the
    // skill's C4 magic level against the target level. Hot casts and cold
    // kills both roll it here.
    calcSpoilSuccess({ skillId, skillLevel = 1, attackerLevel = 1, targetLevel = 1 } = {}, rng = Math.random) {
        const semantic = invoke('GameServer/Skills/C4SkillRules').resolveCached({ selfId: Number(skillId), level: Number(skillLevel) || 1 });
        return Formulas.calcMagicSuccess({ attackerLevel, targetLevel, magicLevel: semantic.magicLevel }, rng);
    },

    spoilSuccessChance({ skillId, skillLevel = 1, attackerLevel = 1, targetLevel = 1 } = {}) {
        const semantic = invoke('GameServer/Skills/C4SkillRules').resolveCached({ selfId: Number(skillId), level: Number(skillLevel) || 1 });
        const threshold = magicFailureThreshold(attackerLevel, targetLevel, semantic.magicLevel);
        return Math.max(0, Math.min(1, (9999 - threshold) / 10000));
    },

    // Lisvus C4 Formulas.calcSkillSuccess. C4SkillEffects supplies the
    // sourced trait-resist modifier because the local effect model keeps it
    // separately from an L2Character stat calculator.
    calcSkillEffectSuccessRate({
        baseChance = 80,
        magic = false,
        mAtk = 0,
        mDef = 1,
        soulshot = false,
        spiritshot = false,
        blessedSpiritshot = false,
        attackerLevel = 1,
        targetLevel = 1,
        magicLevel = 0,
        levelDepend = 0,
        resistModifier = 1
    } = {}) {
        let rate = Number(baseChance) || 0;
        const resolvedLevelDepend = Number(levelDepend) || 2;

        if (magic) {
            rate *= Math.pow(
                Math.max(0, Number(mAtk) || 0) / Math.max(1, Number(mDef) || 1),
                0.2
            );
        }

        const shotModifier = blessedSpiritshot ? 200 : (spiritshot || soulshot ? 150 : 100);
        if (shotModifier !== 100) {
            rate = rate > (10000 / (100 + shotModifier))
                ? 100 - (((100 - rate) * 100) / shotModifier)
                : (rate * shotModifier) / 100;
        }

        if (resolvedLevelDepend > 0) {
            let attackerLevelModifier = Number(attackerLevel) || 1;
            let targetLevelModifier = Number(targetLevel) || 1;
            if (attackerLevelModifier >= 70) attackerLevelModifier = ((attackerLevelModifier - 69) * 2) + 70;
            if (targetLevelModifier >= 70) targetLevelModifier = ((targetLevelModifier - 69) * 2) + 70;

            const resolvedMagicLevel = Number(magicLevel) || 0;
            const delta = resolvedMagicLevel === 0
                ? attackerLevelModifier - targetLevelModifier
                : ((resolvedMagicLevel + attackerLevelModifier) / 2) - targetLevelModifier;
            let levelModifier;
            if ((delta + 3) < 0) {
                levelModifier = delta <= -20 ? 0.05 : 1 - ((-1) * (delta / 20));
                if (levelModifier >= 1) levelModifier = 0.05;
            } else {
                levelModifier = 1 + ((delta + 3) / 75);
            }
            rate *= Math.abs(levelModifier);
        }

        rate = Math.max(1, Math.min(rate, 99));
        return rate * Math.max(0, Number(resistModifier) || 0);
    },

    calcRemoteHit(mAtk, power, mDef) {
        return this.calcMagicDamage(mAtk, power, mDef);
    },

    calcHitMiss(attacker, target, rng = Math.random, context = {}) {
        return !this.calcHitChance(attacker, target, rng, context);
    }
};

function safeNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

module.exports = Formulas;
