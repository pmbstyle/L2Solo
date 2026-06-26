const DAMAGE = 'damage';
const DAMAGE_EFFECT = 'damageEffect';
const HEAL = 'heal';
const EFFECT = 'effect';
const BLOW = 'blow';
const CLEANSE = 'cleanse';

const RULES = {
    3: { skillType: DAMAGE, trait: 'sword', ssBoost: 1 },
    16: { skillType: BLOW, trait: 'dagger', ssBoost: 1, blowChance: 50 },
    30: { skillType: BLOW, trait: 'dagger', ssBoost: 1, blowChance: 70, lethal: { halfKillChance: 5 } },
    56: { skillType: DAMAGE, trait: 'bow', ssBoost: 1 },
    100: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', baseLandRate: 50 },
    101: { skillType: DAMAGE_EFFECT, trait: 'shock', effect: 'stun', effectType: 'debuff', baseLandRate: 50 },
    102: { skillType: EFFECT, trait: 'root', effect: 'root', effectType: 'debuff', baseLandRate: 70 },
    105: { skillType: DAMAGE_EFFECT, trait: 'water', effect: 'freezing_strike', effectType: 'debuff', baseLandRate: 60, stats: { runSpdMul: 0.7 } },
    115: { skillType: EFFECT, trait: 'debuff', effect: 'power_break', effectType: 'debuff', baseLandRate: 80, statsByLevel: { pAtkMul: [0.8, 0.8, 0.77] } },
    122: { skillType: EFFECT, trait: 'debuff', effect: 'hex', effectType: 'debuff', baseLandRate: 80, stats: { pDefMul: 0.77 } },
    127: { skillType: EFFECT, trait: 'slow', effect: 'hamstring', effectType: 'debuff', baseLandRate: 80, stats: { runSpdMul: 0.7 } },
    21: { skillType: CLEANSE, trait: 'poison', target: 'self', cleanse: [{ category: 'poison', maxLevelByLevel: [3, 7] }] },
    129: { skillType: EFFECT, trait: 'poison', effect: 'poison', effectType: 'debuff', baseLandRate: 70, dot: { count: 10, intervalMs: 3000 } },
    263: { skillType: BLOW, trait: 'dagger', ssBoost: 1, blowChance: 70, lethal: { halfKillChance: 5 } },
    1040: { skillType: EFFECT, trait: 'buff', effect: 'shield', effectType: 'buff', target: 'friendly', baseLandRate: 100 },
    1068: { skillType: EFFECT, trait: 'buff', effect: 'might', effectType: 'buff', target: 'friendly', baseLandRate: 100 },
    1011: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1012: { skillType: CLEANSE, trait: 'poison', target: 'friendly', cleanse: [{ category: 'poison', maxLevelByLevel: [3, 7, 9] }] },
    1015: { skillType: HEAL, trait: 'heal', target: 'friendly', ssBoost: 0 },
    1069: { skillType: EFFECT, trait: 'sleep', effect: 'sleep', effectType: 'debuff', baseLandRate: 70 },
    1086: { skillType: EFFECT, trait: 'buff', effect: 'haste', effectType: 'buff', target: 'friendly', baseLandRate: 100 },
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
    resolve,
    normalizeKey
};
