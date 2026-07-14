const Formulas = {
    SHIELD_DEFENSE_FAILED: 0,
    SHIELD_DEFENSE_SUCCEED: 1,
    SHIELD_DEFENSE_PERFECT_BLOCK: 2,
    DEFAULT_SHIELD_RATE: 20,
    DEFAULT_SHIELD_DEFENCE_ANGLE: 120,
    DEFAULT_PERFECT_SHIELD_BLOCK_RATE: 0,

    calcBaseHp: (() => {
        const table = utils.tupleAlloc(100, (level) => {
            utils.infoFail('GameServer', 'unknown HP Table for Level %d', level);
        });

        function hp(level, a, b, c, d) {
            return ((Math.pow(level, 2) *  a) + (level * b) +  c) / d;
        }

        table[ 0] = (level) => { return hp(level, 13, 2327, 13660, 200); };
        table[10] = (level) => { return hp(level, 17, 3043, 17140, 200); };
        table[18] = (level) => { return hp(level,  7, 1253,  7640, 100); };
        table[25] = (level) => { return hp(level, 17, 3043, 17740, 200); };
        table[31] = (level) => { return hp(level,  3,  537,  3220,  40); };
        table[38] = (level) => { return hp(level, 17, 3043, 18140, 200); };
        table[44] = (level) => { return hp(level,  7, 1253,  6740, 100); };
        table[49] = (level) => { return hp(level, 17, 3043, 15940, 200); };
        table[53] = (level) => { return hp(level,  7, 1253,  6740, 100); };

        return table;
    })(),

    calcBaseMp: (() => {
        const table = utils.tupleAlloc(3, (level) => {
            utils.infoFail('GameServer', 'unknown MP Table for Level %d', level);
        });

        function mp(level, a, b, c, d) {
            return ((Math.pow(level, 2) *  a) + (level * b) +  c) / d;
        }

        table[0] = [ // Base class
            (level) => { return mp(level, 3, 537, 2460, 100); }, // F
            (level) => { return mp(level, 1, 179,  820,  25); }, // M
        ];
        table[1] = [ // 1st class transfer
            (level) => { return mp(level, 3, 537, 2460, 100) * 1.20; }, // F
            (level) => { return mp(level, 1, 179,  820,  25) * 1.50; }, // M
        ];
        table[2] = [ // 2nd class transfer
            (level) => { return mp(level, 3, 537, 2460, 100) * 1.40; }, // F
            (level) => { return mp(level, 1, 179,  820,  25) * 2.00; }, // M
        ];

        return table;
    })(),

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

    calcHp(level, classId, con) {
        const parentId = this.getParentClassId(classId);
        return this.calcBaseHp[parentId](level) * this.calcBaseMod.CON(con);
    },

    calcMp(level, kind, classTransfer, men) {
        return this.calcBaseMp[classTransfer][kind](level) * this.calcBaseMod.MEN(men);
    },

    calcCp: (() => {
        const table = {
            0: { classBaseLevel: 1, baseCpMax: 32, lvlCpAdd: 4.73, lvlCpMod: 0.22 },
            1: { classBaseLevel: 20, baseCpMax: 261.6, lvlCpAdd: 26.4, lvlCpMod: 0.22 },
            2: { classBaseLevel: 40, baseCpMax: 939.6, lvlCpAdd: 44.46, lvlCpMod: 0.22 },
            3: { classBaseLevel: 40, baseCpMax: 835.2, lvlCpAdd: 43.68, lvlCpMod: 0.22 },
            4: { classBaseLevel: 20, baseCpMax: 196.2, lvlCpAdd: 17.82, lvlCpMod: 0.22 },
            5: { classBaseLevel: 40, baseCpMax: 583.3, lvlCpAdd: 28.08, lvlCpMod: 0.22 },
            6: { classBaseLevel: 40, baseCpMax: 583.3, lvlCpAdd: 28.08, lvlCpMod: 0.22 },
            7: { classBaseLevel: 20, baseCpMax: 130.8, lvlCpAdd: 11, lvlCpMod: 0.22 },
            8: { classBaseLevel: 40, baseCpMax: 369.8, lvlCpAdd: 16.64, lvlCpMod: 0.22 },
            9: { classBaseLevel: 40, baseCpMax: 647.1, lvlCpAdd: 30.94, lvlCpMod: 0.22 },
            10: { classBaseLevel: 1, baseCpMax: 50.5, lvlCpAdd: 7.84, lvlCpMod: 0.22 },
            11: { classBaseLevel: 20, baseCpMax: 212, lvlCpAdd: 13.85, lvlCpMod: 0.22 },
            12: { classBaseLevel: 40, baseCpMax: 510.7, lvlCpAdd: 22.85, lvlCpMod: 0.22 },
            13: { classBaseLevel: 40, baseCpMax: 510.7, lvlCpAdd: 22.85, lvlCpMod: 0.22 },
            14: { classBaseLevel: 40, baseCpMax: 612.9, lvlCpAdd: 29.74, lvlCpMod: 0.22 },
            15: { classBaseLevel: 20, baseCpMax: 212, lvlCpAdd: 17.15, lvlCpMod: 0.22 },
            16: { classBaseLevel: 40, baseCpMax: 815.4, lvlCpAdd: 34.68, lvlCpMod: 0.22 },
            17: { classBaseLevel: 40, baseCpMax: 582.4, lvlCpAdd: 26.75, lvlCpMod: 0.22 },
            18: { classBaseLevel: 1, baseCpMax: 35.6, lvlCpAdd: 5, lvlCpMod: 0.22 },
            19: { classBaseLevel: 20, baseCpMax: 177.5, lvlCpAdd: 16.5, lvlCpMod: 0.22 },
            20: { classBaseLevel: 40, baseCpMax: 643.2, lvlCpAdd: 31.2, lvlCpMod: 0.22 },
            21: { classBaseLevel: 40, baseCpMax: 536, lvlCpAdd: 27.3, lvlCpMod: 0.22 },
            22: { classBaseLevel: 20, baseCpMax: 142, lvlCpAdd: 12.32, lvlCpMod: 0.22 },
            23: { classBaseLevel: 40, baseCpMax: 409.6, lvlCpAdd: 18.72, lvlCpMod: 0.22 },
            24: { classBaseLevel: 40, baseCpMax: 512.1, lvlCpAdd: 24.7, lvlCpMod: 0.22 },
            25: { classBaseLevel: 1, baseCpMax: 52, lvlCpAdd: 7.84, lvlCpMod: 0.22 },
            26: { classBaseLevel: 20, baseCpMax: 213.5, lvlCpAdd: 14.4, lvlCpMod: 0.22 },
            27: { classBaseLevel: 40, baseCpMax: 524.2, lvlCpAdd: 24.15, lvlCpMod: 0.22 },
            28: { classBaseLevel: 40, baseCpMax: 629, lvlCpAdd: 30.52, lvlCpMod: 0.22 },
            29: { classBaseLevel: 20, baseCpMax: 213.5, lvlCpAdd: 17.7, lvlCpMod: 0.22 },
            30: { classBaseLevel: 40, baseCpMax: 595.9, lvlCpAdd: 27.4, lvlCpMod: 0.22 },
            31: { classBaseLevel: 1, baseCpMax: 37.6, lvlCpAdd: 5.46, lvlCpMod: 0.22 },
            32: { classBaseLevel: 20, baseCpMax: 189.5, lvlCpAdd: 17.6, lvlCpMod: 0.22 },
            33: { classBaseLevel: 40, baseCpMax: 686.2, lvlCpAdd: 32.76, lvlCpMod: 0.22 },
            34: { classBaseLevel: 40, baseCpMax: 571.9, lvlCpAdd: 29.25, lvlCpMod: 0.22 },
            35: { classBaseLevel: 20, baseCpMax: 151.6, lvlCpAdd: 13.2, lvlCpMod: 0.22 },
            36: { classBaseLevel: 40, baseCpMax: 438.4, lvlCpAdd: 19.76, lvlCpMod: 0.22 },
            37: { classBaseLevel: 40, baseCpMax: 548, lvlCpAdd: 26, lvlCpMod: 0.22 },
            38: { classBaseLevel: 1, baseCpMax: 53, lvlCpAdd: 7.84, lvlCpMod: 0.22 },
            39: { classBaseLevel: 20, baseCpMax: 214.5, lvlCpAdd: 14.95, lvlCpMod: 0.22 },
            40: { classBaseLevel: 40, baseCpMax: 537.1, lvlCpAdd: 24.15, lvlCpMod: 0.22 },
            41: { classBaseLevel: 40, baseCpMax: 644.5, lvlCpAdd: 31.3, lvlCpMod: 0.22 },
            42: { classBaseLevel: 20, baseCpMax: 214.5, lvlCpAdd: 18.25, lvlCpMod: 0.22 },
            43: { classBaseLevel: 40, baseCpMax: 608.8, lvlCpAdd: 27.4, lvlCpMod: 0.22 },
            44: { classBaseLevel: 1, baseCpMax: 40, lvlCpAdd: 6.27, lvlCpMod: 0.22 },
            45: { classBaseLevel: 20, baseCpMax: 242.2, lvlCpAdd: 24.54, lvlCpMod: 0.22 },
            46: { classBaseLevel: 40, baseCpMax: 777.5, lvlCpAdd: 39.94, lvlCpMod: 0.22 },
            47: { classBaseLevel: 20, baseCpMax: 173, lvlCpAdd: 16.4, lvlCpMod: 0.22 },
            48: { classBaseLevel: 40, baseCpMax: 531.5, lvlCpAdd: 27.2, lvlCpMod: 0.22 },
            49: { classBaseLevel: 1, baseCpMax: 47.5, lvlCpAdd: 7.74, lvlCpMod: 0.22 },
            50: { classBaseLevel: 20, baseCpMax: 209, lvlCpAdd: 17.6, lvlCpMod: 0.22 },
            51: { classBaseLevel: 40, baseCpMax: 946.2, lvlCpAdd: 42.64, lvlCpMod: 0.22 },
            52: { classBaseLevel: 40, baseCpMax: 591.4, lvlCpAdd: 26.65, lvlCpMod: 0.22 },
            53: { classBaseLevel: 1, baseCpMax: 56, lvlCpAdd: 8.82, lvlCpMod: 0.22 },
            54: { classBaseLevel: 20, baseCpMax: 242.2, lvlCpAdd: 24.54, lvlCpMod: 0.22 },
            55: { classBaseLevel: 40, baseCpMax: 777.5, lvlCpAdd: 39.94, lvlCpMod: 0.22 },
            56: { classBaseLevel: 20, baseCpMax: 276.8, lvlCpAdd: 26.3, lvlCpMod: 0.22 },
            57: { classBaseLevel: 40, baseCpMax: 850.4, lvlCpAdd: 43.58, lvlCpMod: 0.22 }
        };

        Object.entries(invoke('GameServer/ClassProgression').thirdClasses).forEach(([classId, thirdClass]) => {
            table[classId] = { classBaseLevel: 76, ...thirdClass.cp };
        });

        return (level, classId, con) => {
            const data = table[classId] || table[0];
            const delta = Math.max(0, (Number(level) || 1) - data.classBaseLevel);
            const cpmod = data.lvlCpMod * delta;
            const cpmax = (data.lvlCpAdd + cpmod) * delta;
            const cpmin = (data.lvlCpAdd * delta) + cpmod;
            return (data.baseCpMax + ((cpmax + cpmin) / 2)) * Formulas.calcBaseMod.CON(con);
        };
    })(),

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

    calcRemoteAtkTime(time, castSpd) {
        return  (time / castSpd) * 333;
    },

    calcMeleeHit(pAtk, pAtkRnd, pDef) {
        return this.calcMeleeDamage(pAtk, pAtkRnd, pDef);
    },

    calcMeleeDamage(pAtk, pAtkRnd, pDef, { critical = false, soulshot = false, skillPower = 0, criticalDamageMultiplier = 1, criticalDamageAdd = 0 } = {}) {
        const pAtkRndMul = 1 + (utils.oneFromSpan(-pAtkRnd, pAtkRnd) / 100);
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

    rollCritical(critical, rng = Math.random) {
        return (Number(critical) || 0) > rng() * 1000;
    },

    rollShieldUse({ shieldRate = 0, dex = 0, facing = true, bow = false, perfectBlockRate = this.DEFAULT_PERFECT_SHIELD_BLOCK_RATE } = {}, rng = Math.random) {
        if ((Number(shieldRate) || 0) <= 0 || !facing) return this.SHIELD_DEFENSE_FAILED;

        let rate = Number(shieldRate) * this.calcBaseMod.DEX(Math.max(0, Math.min(Math.round(Number(dex) || 0), 99)));
        if (bow) rate *= 1.3;

        if (rate > 0 && 100 - Number(perfectBlockRate || 0) < rng() * 100) {
            return this.SHIELD_DEFENSE_PERFECT_BLOCK;
        }

        return rate > rng() * 100
            ? this.SHIELD_DEFENSE_SUCCEED
            : this.SHIELD_DEFENSE_FAILED;
    },

    calcHitChance(attacker, target, rng = Math.random, context = {}) {
        const accuracy = safeNumber(attacker?.fetchCollectiveAccur?.(), safeNumber(attacker?.fetchAccur?.(), 0));
        const evasion = safeNumber(target?.fetchCollectiveEvasion?.(), safeNumber(target?.fetchEvasion?.(), 0));
        let chance = (80 + (2 * (accuracy - evasion))) * 10;
        let modifier = 100;

        const zDiff = safeNumber(attacker?.fetchLocZ?.(), 0) - safeNumber(target?.fetchLocZ?.(), 0);
        if (zDiff > 50) modifier += 3;
        else if (zDiff < -50) modifier -= 3;

        if (context.behind) modifier += 10;
        else if (context.front === false) modifier += 5;
        if (context.night) modifier -= 10;

        chance *= modifier / 100;
        chance = Math.max(Math.min(chance, 980), 200);
        return chance >= rng() * 1000;
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

    calcDrainHeal({ damage = 0, targetHp = 0, absorbPart = 0, absorbAbs = 0 } = {}) {
        const drainableDamage = Math.min(Math.max(0, Number(damage) || 0), Math.max(0, Number(targetHp) || 0));
        return Math.max(0, (Number(absorbAbs) || 0) + ((Number(absorbPart) || 0) * drainableDamage));
    },

    // L2J-style Heal handler baseline: power with shot multipliers; stat bonuses need real effect stats first.
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
