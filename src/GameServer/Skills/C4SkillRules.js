const DAMAGE = 'damage';
const DAMAGE_EFFECT = 'damageEffect';
const HEAL = 'heal';
const HEAL_PERCENT = 'healPercent';
const HEAL_HOT = 'healHot';
const HOT = 'hot';
const EFFECT = 'effect';
const BLOW = 'blow';
const CLEANSE = 'cleanse';
const HEAL_CLEANSE = 'healCleanse';
const MANA_RECHARGE = 'manaRecharge';

const RULES = {
    3: { skillType: DAMAGE, trait: 'sword', ssBoost: 1 },
    16: { skillType: BLOW, trait: 'dagger', ssBoost: 1, blowChance: 50 },
    30: { skillType: BLOW, trait: 'dagger', ssBoost: 1, blowChance: 70, lethal: { halfKillChance: 5 } },
    56: { skillType: DAMAGE, trait: 'bow', ssBoost: 1 },
    100: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', baseLandRate: 50 },
    101: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', baseLandRate: 50 },
    102: { skillType: EFFECT, trait: 'root', effect: 'root', effectType: 'debuff', baseLandRate: 80 },
    105: { skillType: DAMAGE_EFFECT, trait: 'water', effect: 'freezing_strike', effectType: 'debuff', baseLandRate: 60, stats: { runSpdMul: 0.7 } },
    115: { skillType: EFFECT, trait: 'debuff', effect: 'power_break', effectType: 'debuff', baseLandRate: 80, statsByLevel: { pAtkMul: [0.8, 0.8, 0.77] } },
    122: { skillType: EFFECT, trait: 'debuff', effect: 'hex', effectType: 'debuff', baseLandRate: 80, stats: { pDefMul: 0.77 } },
    127: { skillType: EFFECT, trait: 'slow', effect: 'hamstring', effectType: 'debuff', baseLandRate: 80, stats: { runSpdMul: 0.7 } },
    21: { skillType: CLEANSE, trait: 'poison', target: 'self', cleanse: [{ category: 'poison', maxLevelByLevel: [3, 7] }] },
    34: { skillType: CLEANSE, trait: 'bleed', target: 'self', cleanse: [{ category: 'bleed', maxLevelByLevel: [3, 7, 9] }] },
    61: { skillType: CLEANSE, trait: 'bleed', target: 'self', cleanse: [{ category: 'bleed', maxLevelByLevel: [3, 7, 9] }] },
    96: { skillType: EFFECT, trait: 'bleed', effect: 'bleed', effectType: 'debuff', baseLandRate: 100, dot: { count: 7, intervalMs: 3000, damageByLevel: [39, 51, 66, 81, 93, 102] } },
    129: { skillType: EFFECT, trait: 'poison', effect: 'poison', effectType: 'debuff', baseLandRate: 70, dot: { count: 10, intervalMs: 3000 } },
    263: { skillType: BLOW, trait: 'dagger', ssBoost: 1, blowChance: 70, lethal: { halfKillChance: 5 } },
    1040: { skillType: EFFECT, trait: 'buff', effect: 'shield', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pDefMul: [1.08, 1.12, 1.15] } },
    1068: { skillType: EFFECT, trait: 'buff', effect: 'might', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAtkMul: [1.08, 1.12, 1.15] } },
    1011: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1012: { skillType: CLEANSE, trait: 'poison', target: 'friendly', cleanse: [{ category: 'poison', maxLevelByLevel: [3, 7, 9] }] },
    1013: { skillType: MANA_RECHARGE, trait: 'mana', target: 'friendly', ssBoost: 0 },
    1015: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1018: { skillType: CLEANSE, trait: 'purify', target: 'friendly', cleanse: [
        { category: 'poison', maxLevelByLevel: [3, 7, 9] },
        { category: 'bleed', maxLevelByLevel: [3, 7, 9] },
        { category: 'paralyze', maxLevelByLevel: [3, 7, 9] },
        { category: 'petrification', maxLevelByLevel: [3, 7, 9] }
    ] },
    1020: { skillType: HEAL_CLEANSE, trait: 'heal', target: 'friendly', ssBoost: 0, healPowerByLevel: [
        440, 454, 467, 494, 508, 521, 548, 562, 575, 588, 602, 615, 627, 640,
        653, 665, 677, 689, 700, 711, 722, 733, 743, 753, 763, 772, 780
    ], cleanse: [
        { category: 'poison', maxLevelByLevel: [3, 3, 3, 3, 3, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 9] },
        { category: 'bleed', maxLevelByLevel: [3, 3, 3, 3, 3, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 9] }
    ] },
    1032: { skillType: EFFECT, trait: 'buff', effect: 'invigor', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { bleedResist: [30, 40, 50] } },
    1033: { skillType: EFFECT, trait: 'buff', effect: 'resist_poison', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { poisonResist: [30, 40, 50] } },
    1035: { skillType: EFFECT, trait: 'buff', effect: 'mental_shield', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: {
        rootResist: [20, 30, 40, 50],
        sleepResist: [20, 30, 40, 50],
        mentalResist: [20, 30, 40, 50]
    } },
    1036: { skillType: EFFECT, trait: 'buff', effect: 'magic_barrier', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { mDefMul: [1.23, 1.3] } },
    1044: { skillType: EFFECT, trait: 'buff', effect: 'regeneration', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { regHp: [1.1, 1.15, 1.2] } },
    1045: { skillType: EFFECT, trait: 'buff', effect: 'blessed_body', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { maxHpMul: [1.1, 1.15, 1.2, 1.25, 1.3, 1.35] } },
    1047: { skillType: EFFECT, trait: 'buff', effect: 'mana_regeneration', effectType: 'buff', target: 'self', baseLandRate: 100, statsByLevel: { regMp: [1.72, 2.16, 2.74, 3.09] } },
    1048: { skillType: EFFECT, trait: 'buff', effect: 'blessed_soul', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { maxMpMul: [1.1, 1.15, 1.2, 1.25, 1.3, 1.35] } },
    1059: { skillType: EFFECT, trait: 'buff', effect: 'empower', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { mAtkMul: [1.55, 1.65, 1.75] } },
    1062: { skillType: EFFECT, trait: 'buff', effect: 'berserker_spirit', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: {
        mAtkMul: [1.1, 1.16],
        pAtkMul: [1.05, 1.08],
        pDefMul: [0.95, 0.92],
        mDefMul: [0.90, 0.84],
        castSpdMul: [1.05, 1.08],
        pAtkSpdMul: [1.05, 1.08],
        runSpdAdd: [5, 8],
        pEvasionRateAdd: [-2, -4]
    } },
    1064: { skillType: EFFECT, trait: 'derangement', effect: 'silence', effectType: 'debuff', target: 'enemy', baseLandRate: 80 },
    1069: { skillType: EFFECT, trait: 'sleep', effect: 'sleep', effectType: 'debuff', baseLandRate: 80 },
    1072: { skillType: EFFECT, trait: 'sleep', effect: 'sleep', effectType: 'debuff', target: 'enemy', baseLandRate: 40 },
    1077: { skillType: EFFECT, trait: 'buff', effect: 'focus', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pCritRateAdd: [20, 25, 30] } },
    1085: { skillType: EFFECT, trait: 'buff', effect: 'acumen', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { castSpdMul: [1.15, 1.23, 1.3] } },
    1086: { skillType: EFFECT, trait: 'buff', effect: 'haste', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAtkSpdMul: [1.15, 1.33] } },
    1087: { skillType: EFFECT, trait: 'buff', effect: 'agility', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pEvasionRateAdd: [2, 3, 4] } },
    1096: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_chaos', effectType: 'debuff', target: 'enemy', baseLandRate: 40, statsByLevel: { pAccuracyCombatAdd: [-12, -12, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13, -13] } },
    1097: { skillType: EFFECT, trait: 'sleep', effect: 'sleep', effectType: 'debuff', target: 'enemy', baseLandRate: 80 },
    1099: { skillType: EFFECT, trait: 'slow', effect: 'seal_of_slow', effectType: 'debuff', target: 'enemy', baseLandRate: 40, statsByLevel: { runSpdMul: [0.7, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] } },
    1104: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_winter', effectType: 'debuff', target: 'enemy', baseLandRate: 40, stats: { pAtkSpdMul: 0.77 } },
    1105: { skillType: EFFECT, trait: 'confusion', effect: 'confusion', effectType: 'debuff', target: 'enemy', mobOnly: true },
    1126: { skillType: MANA_RECHARGE, trait: 'mana', target: 'pet', ssBoost: 0 },
    1139: { skillType: EFFECT, trait: 'buff', effect: 'servitor_magic_shield', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { mDefMul: [1.23, 1.3] } },
    1140: { skillType: EFFECT, trait: 'buff', effect: 'servitor_physical_shield', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { pDefMul: [1.08, 1.12, 1.15] } },
    1141: { skillType: EFFECT, trait: 'buff', effect: 'servitor_haste', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { pAtkSpdMul: [1.15, 1.33] } },
    1144: { skillType: EFFECT, trait: 'buff', effect: 'servitor_wind_walk', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { runSpdAdd: [20, 33] } },
    1145: { skillType: EFFECT, trait: 'buff', effect: 'bright_servitor', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { mAtkMul: [1.55, 1.65, 1.75] } },
    1146: { skillType: EFFECT, trait: 'buff', effect: 'mighty_servitor', effectType: 'buff', target: 'pet', baseLandRate: 100, statsByLevel: { pAtkMul: [1.08, 1.12, 1.15] } },
    1160: { skillType: EFFECT, trait: 'slow', effect: 'slow', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { runSpdMul: [0.7, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] } },
    1164: { skillType: EFFECT, trait: 'debuff', effect: 'curse_weakness', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { pAtkMul: [0.83, 0.8, 0.8, 0.8, 0.8, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77, 0.77] } },
    1168: { skillType: EFFECT, trait: 'poison', effect: 'poison', effectType: 'debuff', baseLandRate: 70, dot: { count: 10, intervalMs: 3000, damageByLevel: [1, 3, 4, 5, 6, 7, 8] } },
    1172: { skillType: DAMAGE, trait: 'fire', ssBoost: 1, baseLandRate: 92 },
    1177: { skillType: DAMAGE, trait: 'wind', ssBoost: 1, baseLandRate: 92 },
    1201: { skillType: EFFECT, trait: 'root', effect: 'root', effectType: 'debuff', target: 'enemy', baseLandRate: 80 },
    1204: { skillType: EFFECT, trait: 'buff', effect: 'windWalk', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { runSpdAdd: [20, 33] } },
    1206: { skillType: EFFECT, trait: 'debuff', effect: 'wind_shackle', effectType: 'debuff', target: 'enemy', baseLandRate: 80, statsByLevel: { pAtkSpdMul: [0.83, 0.80, 0.80, 0.80, 0.80, 0.77] } },
    1208: { skillType: EFFECT, trait: 'root', effect: 'root', effectType: 'debuff', target: 'enemy', baseLandRate: 40 },
    1216: { skillType: HEAL, trait: 'heal', target: 'self', ssBoost: 0 },
    1217: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1229: { skillType: HOT, trait: 'buff', effect: 'chant_of_life', effectType: 'buff', target: 'friendly', baseLandRate: 100, hot: { count: 15, intervalMs: 1000, healByLevel: [12, 15, 18, 23, 27, 31, 35, 39, 43, 45, 46, 48, 50, 52, 53, 55, 56, 58] } },
    1240: { skillType: EFFECT, trait: 'buff', effect: 'guidance', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAccuracyCombatAdd: [2, 3, 4] } },
    1242: { skillType: EFFECT, trait: 'buff', effect: 'death_whisper', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pCritDamageMul: [1.25, 1.3, 1.35] } },
    1243: { skillType: EFFECT, trait: 'buff', effect: 'bless_shield', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { rShldMul: [1.05, 1.1, 1.15, 1.2, 1.25, 1.3] } },
    1246: { skillType: EFFECT, trait: 'derangement', effect: 'silence', effectType: 'debuff', target: 'enemy', baseLandRate: 40 },
    1247: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_scourge', effectType: 'debuff', target: 'enemy', baseLandRate: 80, stats: { regHp: 0 } },
    1248: { skillType: EFFECT, trait: 'debuff', effect: 'seal_of_suspension', effectType: 'debuff', target: 'enemy', baseLandRate: 60, stats: { mReuseMul: 3, pReuseMul: 3 } },
    1249: { skillType: EFFECT, trait: 'buff', effect: 'vision_of_paagrio', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAccuracyCombatAdd: [2, 3, 4] } },
    1250: { skillType: EFFECT, trait: 'buff', effect: 'protection_of_paagrio', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { rShldMul: [1.3, 1.4, 1.5] } },
    1251: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_fury', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pAtkSpdMul: [1.15, 1.33] } },
    1252: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_evasion', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pEvasionRateAdd: [2, 3, 4] } },
    1253: { skillType: EFFECT, trait: 'buff', effect: 'chant_of_rage', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pCritDamageMul: [1.25, 1.3, 1.35] } },
    1256: { skillType: HEAL_HOT, trait: 'buff', effect: 'heart_of_paagrio', effectType: 'buff', target: 'friendly', ssBoost: 0, healPowerByLevel: [91, 103, 115, 127, 133, 138, 144, 149, 154, 158, 164, 168, 172], hot: { count: 15, intervalMs: 1000, healByLevel: [31, 35, 39, 43, 45, 46, 48, 50, 52, 53, 55, 56, 58] } },
    1257: { skillType: EFFECT, trait: 'buff', effect: 'decrease_weight', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { maxLoad: [3000, 6000, 9000] } },
    1258: { skillType: HEAL_PERCENT, trait: 'heal', target: 'friendly', ssBoost: 0, healPowerByLevel: [15, 20, 25, 30] },
    1259: { skillType: EFFECT, trait: 'buff', effect: 'resist_shock', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { stunResist: [15, 20, 30, 40] } },
    1260: { skillType: EFFECT, trait: 'buff', effect: 'tact_of_paagrio', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pEvasionRateAdd: [2, 3, 4] } },
    1261: { skillType: EFFECT, trait: 'buff', effect: 'rage_of_paagrio', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: {
        mAtkMul: [1.1, 1.16],
        pAtkMul: [1.05, 1.08],
        pDefMul: [0.95, 0.92],
        mDefMul: [0.90, 0.84],
        castSpdMul: [1.05, 1.08],
        pAtkSpdMul: [1.05, 1.08],
        runSpdAdd: [5, 8],
        pEvasionRateAdd: [-2, -4]
    } },
    1263: { skillType: DAMAGE_EFFECT, trait: 'unholy', effect: 'curse_gloom', effectType: 'debuff', target: 'enemy', baseLandRate: 80, stats: { mDefMul: 0.85 } },
    1268: { skillType: EFFECT, trait: 'buff', effect: 'vampiric_rage', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { absorbDam: [6, 7, 8, 9] } },
    1269: { skillType: EFFECT, trait: 'debuff', effect: 'curse_disease', effectType: 'debuff', target: 'enemy', baseLandRate: 80, stats: { regHp: 0.5 } },
    1271: { skillType: HEAL_PERCENT, trait: 'heal', target: 'friendly', ssBoost: 0, healPowerByLevel: [100], condition: { actorHpPercentAtMost: 25 } }
};

const SELF_NAME_PATTERNS = [
    /^dash$/i,
    /^self heal$/i,
    /^ultimate /i,
    /^totem spirit /i,
    /^war cry$/i,
    /^rage$/i,
    /^rapid shot$/i,
    /^deflect arrow$/i,
    / aura$/i,
    /^detect /i
];

function resolve(skill = {}) {
    const name = String(skill.name || '');
    const rule = RULES[Number(skill.selfId)] || {};
    const inferred = infer(skill, name);

    const semantic = {
        skillType: rule.skillType || inferred.skillType,
        target: rule.target || inferred.target,
        effect: rule.effect || inferred.effect,
        effectType: rule.effectType || inferred.effectType,
        trait: rule.trait || inferred.trait,
        ssBoost: rule.ssBoost ?? inferred.ssBoost,
        baseLandRate: rule.baseLandRate ?? inferred.baseLandRate,
        blowChance: rule.blowChance ?? inferred.blowChance,
        healPower: resolveByLevel(rule.healPowerByLevel, skill.level),
        dot: rule.dot || inferred.dot || null,
        hot: resolveHot(rule, inferred, skill.level),
        cleanse: resolveCleanse(rule, inferred, skill.level),
        lethal: rule.lethal || inferred.lethal || null,
        condition: rule.condition || inferred.condition || null,
        mobOnly: rule.mobOnly || inferred.mobOnly || false
    };
    semantic.stats = resolveStats(rule, inferred, skill.level);
    return semantic;
}

function resolveCleanse(rule, inferred, level) {
    return (rule.cleanse || inferred.cleanse || []).map((entry) => {
        const maxLevel = entry.maxLevelByLevel
            ? entry.maxLevelByLevel[Math.max(0, Math.min(entry.maxLevelByLevel.length - 1, (Number(level) || 1) - 1))]
            : entry.maxLevel;
        return { ...entry, maxLevel };
    });
}

function resolveByLevel(values, level) {
    if (!values) return null;
    const index = Math.max(0, Math.min(values.length - 1, (Number(level) || 1) - 1));
    return values[index];
}

function resolveHot(rule, inferred, level) {
    const hot = rule.hot || inferred.hot || null;
    if (!hot) return null;
    const heal = resolveByLevel(hot.healByLevel, level);
    return { ...hot, heal: heal ?? hot.heal };
}

function resolveStats(rule, inferred, level) {
    const stats = { ...(inferred.stats || {}), ...(rule.stats || {}) };
    Object.entries(rule.statsByLevel || {}).forEach(([stat, values]) => {
        const index = Math.max(0, Math.min(values.length - 1, (Number(level) || 1) - 1));
        stats[stat] = values[index];
    });
    return stats;
}

function infer(skill, name) {
    const lower = name.toLowerCase();
    const power = Number(skill.power) || 0;
    const buffMs = Number(skill.buff) || 0;
    const spell = skill.spell === true;
    const selfTarget = Number(skill.distance) < 0 || SELF_NAME_PATTERNS.some((pattern) => pattern.test(name));

    if (lower.includes('heal')) {
        return { skillType: HEAL, target: selfTarget ? 'self' : 'friendly', trait: 'heal', ssBoost: 0 };
    }

    if (lower.includes('blow') || lower.includes('backstab')) {
        return {
            skillType: BLOW,
            target: 'enemy',
            trait: 'dagger',
            ssBoost: 1,
            blowChance: lower.includes('mortal') ? 50 : 70,
            lethal: lower.includes('deadly') || lower.includes('backstab') ? { halfKillChance: 5 } : null
        };
    }

    if (buffMs > 0) {
        const debuff = inferDebuff(name);
        if (debuff) {
            return {
                skillType: power > 1 ? DAMAGE_EFFECT : EFFECT,
                target: 'enemy',
                effect: debuff.effect,
                effectType: 'debuff',
                trait: debuff.trait,
                baseLandRate: debuff.baseLandRate,
                ssBoost: spell ? 1 : 0
            };
        }

        return {
            skillType: EFFECT,
            target: 'self',
            effect: normalizeKey(name),
            effectType: 'buff',
            trait: 'buff',
            baseLandRate: 100,
            ssBoost: 0
        };
    }

    return {
        skillType: DAMAGE,
        target: selfTarget ? 'self' : 'enemy',
        trait: spell ? 'magic' : 'physical',
        baseLandRate: spell ? 92 : 100,
        ssBoost: 1
    };
}

function inferDebuff(name) {
    const lower = name.toLowerCase();
    if (lower.includes('sleep')) return { effect: 'sleep', trait: 'sleep', baseLandRate: 70 };
    if (lower.includes('stun')) return { effect: 'stun', trait: 'shock', baseLandRate: 50 };
    if (lower.includes('poison')) return { effect: 'poison', trait: 'poison', baseLandRate: 70 };
    if (lower.includes('bleed')) return { effect: 'bleed', trait: 'bleed', baseLandRate: 70 };
    if (lower.includes('entangle') || lower.includes('root')) return { effect: 'root', trait: 'root', baseLandRate: 70 };
    if (lower.includes('hex') || lower.includes('power break')) return { effect: normalizeKey(name), trait: 'debuff', baseLandRate: 80 };
    if (lower.includes('cripple') || lower.includes('slow')) return { effect: 'slow', trait: 'slow', baseLandRate: 70 };
    return null;
}

function normalizeKey(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

module.exports = {
    DAMAGE,
    DAMAGE_EFFECT,
    HEAL,
    HEAL_PERCENT,
    HEAL_HOT,
    HOT,
    EFFECT,
    BLOW,
    CLEANSE,
    HEAL_CLEANSE,
    MANA_RECHARGE,
    resolve,
    normalizeKey
};
