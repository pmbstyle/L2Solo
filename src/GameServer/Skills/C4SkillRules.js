const DAMAGE = 'damage';
const DAMAGE_EFFECT = 'damageEffect';
const HEAL = 'heal';
const EFFECT = 'effect';
const BLOW = 'blow';
const CLEANSE = 'cleanse';
const HEAL_CLEANSE = 'healCleanse';

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
    1040: { skillType: EFFECT, trait: 'buff', effect: 'shield', effectType: 'buff', target: 'friendly', baseLandRate: 100 },
    1068: { skillType: EFFECT, trait: 'buff', effect: 'might', effectType: 'buff', target: 'friendly', baseLandRate: 100 },
    1011: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1012: { skillType: CLEANSE, trait: 'poison', target: 'friendly', cleanse: [{ category: 'poison', maxLevelByLevel: [3, 7, 9] }] },
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
    1045: { skillType: EFFECT, trait: 'buff', effect: 'blessed_body', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { maxHpMul: [1.1, 1.15, 1.2, 1.25, 1.3, 1.35] } },
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
    1069: { skillType: EFFECT, trait: 'sleep', effect: 'sleep', effectType: 'debuff', baseLandRate: 80 },
    1077: { skillType: EFFECT, trait: 'buff', effect: 'focus', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pCritRateAdd: [20, 25, 30] } },
    1085: { skillType: EFFECT, trait: 'buff', effect: 'acumen', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { castSpdMul: [1.15, 1.23, 1.3] } },
    1086: { skillType: EFFECT, trait: 'buff', effect: 'haste', effectType: 'buff', target: 'friendly', baseLandRate: 100 },
    1087: { skillType: EFFECT, trait: 'buff', effect: 'agility', effectType: 'buff', target: 'friendly', baseLandRate: 100, statsByLevel: { pEvasionRateAdd: [2, 3, 4] } },
    1168: { skillType: EFFECT, trait: 'poison', effect: 'poison', effectType: 'debuff', baseLandRate: 70, dot: { count: 10, intervalMs: 3000, damageByLevel: [1, 3, 4, 5, 6, 7, 8] } },
    1172: { skillType: DAMAGE, trait: 'fire', ssBoost: 1, baseLandRate: 92 },
    1177: { skillType: DAMAGE, trait: 'wind', ssBoost: 1, baseLandRate: 92 },
    1204: { skillType: EFFECT, trait: 'buff', effect: 'windWalk', effectType: 'buff', target: 'friendly', baseLandRate: 100 },
    1216: { skillType: HEAL, trait: 'heal', target: 'self', ssBoost: 0 },
    1217: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 }
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
        cleanse: resolveCleanse(rule, inferred, skill.level),
        lethal: rule.lethal || inferred.lethal || null
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
    EFFECT,
    BLOW,
    CLEANSE,
    HEAL_CLEANSE,
    resolve,
    normalizeKey
};
