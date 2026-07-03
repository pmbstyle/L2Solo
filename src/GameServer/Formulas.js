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

    // Adapted from aCis calcSkillSuccess; C4SkillEffects supplies sourced trait-resist modifiers.
    calcSkillEffectSuccessRate({
        baseChance = 80,
        magic = false,
        mAtk = 0,
        mDef = 1,
        blessedSpiritshot = false,
        attackerLevel = 1,
        targetLevel = 1,
        magicLevel = 0,
        levelDepend = 0,
        resistModifier = 1
    } = {}) {
        let mAtkModifier = 1;
        if (magic) {
            const boostedMAtk = (Number(mAtk) || 0) * (blessedSpiritshot ? 4 : 1);
            mAtkModifier = (utils.sqrt(boostedMAtk) / Math.max(1, Number(mDef) || 1)) * 11;
        }

        let levelModifier = 1;
        if (Number(levelDepend) !== 0) {
            const effectiveMagicLevel = Number(magicLevel) > 0 ? Number(magicLevel) : (Number(attackerLevel) || 1);
            const delta = effectiveMagicLevel + Number(levelDepend) - (Number(targetLevel) || 1);
            levelModifier = 1 + ((delta < 0 ? 0.01 : 0.005) * delta);
        }

        const chance = (Number(baseChance) || 0) * mAtkModifier * Math.max(0, levelModifier) * Math.max(0, Number(resistModifier) || 0);
        return Math.max(1, Math.min(chance, 99));
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
