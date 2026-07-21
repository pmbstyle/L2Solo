const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const Attack = invoke('GameServer/Actor/Attack');

const OFFENSIVE_TYPES = new Set([
    C4SkillRules.DAMAGE,
    C4SkillRules.DAMAGE_EFFECT,
    C4SkillRules.DEATH_LINK,
    C4SkillRules.DRAIN,
    C4SkillRules.BLOW,
    C4SkillRules.EFFECT,
    C4SkillRules.AGGRO_DAMAGE
]);

function distance2d(a, b) {
    if (!a?.fetchLocX || !b?.fetchLocX) return 0;
    const dx = a.fetchLocX() - b.fetchLocX();
    const dy = a.fetchLocY() - b.fetchLocY();
    return Math.sqrt((dx * dx) + (dy * dy));
}

function reserveRatio(role) {
    if (role === 'healer' || role === 'buffer') return 0.45;
    if (role === 'mage') return 0.18;
    return 0.10;
}

function evaluate(bot, target, skill, role) {
    if (!skill || skill.fetchPassive?.()) return null;
    const semantic = skill.fetchSemantic?.() || {};
    if (semantic.notUsedInC4) return null;
    const allowedWeapons = Number(semantic.requires?.weaponsAllowed) || 0;
    if (allowedWeapons && (allowedWeapons & Attack.weaponMaskFor(bot)) === 0) return null;
    if (!OFFENSIVE_TYPES.has(skill.fetchSkillType?.())) return null;
    if (skill.fetchTargetKind?.() !== 'enemy') return null;

    // Pure debuffs are tactical tools, not damage rotation. Scoring their
    // effect power as damage made mages spam Sleep/Root until their MP ran out.
    if (skill.fetchSkillType() === C4SkillRules.EFFECT && semantic.effectType === 'debuff') return null;

    const range = Number(skill.fetchDistance?.());
    if (!Number.isFinite(range) || range < 0) return null;

    const mp = Number(bot.fetchMp?.() || 0);
    const maxMp = Math.max(1, Number(bot.fetchMaxMp?.() || mp || 1));
    const cost = Math.max(0, Number(skill.fetchConsumedMp?.() || 0));
    // A mage's staff is the primary weapon. Keeping a generic MP reserve made
    // a mage walk into melee even though it could still afford a nuke.
    if (cost > mp || (role !== 'mage' && (mp - cost) / maxMp < reserveRatio(role))) return null;

    const type = skill.fetchSkillType();
    const power = Math.max(0, Number(skill.fetchPower?.() || 0));
    const distance = distance2d(bot, target);
    const reasons = [];
    let score = 100 + Math.log2(power + 1) * 35 - cost * 1.5;

    if (range + 80 >= distance) {
        score += 100;
        reasons.push('in_range');
    } else {
        score -= Math.min(220, (distance - range) / 5);
        reasons.push('close_distance');
    }

    const spell = skill.fetchSpell?.() === true;
    if (role === 'mage' && spell) {
        score += 170;
        reasons.push('mage_spell');
    }
    if (role === 'archer' && range >= 400) {
        score += 150;
        reasons.push('ranged_attack');
    }
    if (role === 'dagger' && type === C4SkillRules.BLOW) {
        score += 220;
        reasons.push('dagger_blow');
    }
    if (role === 'tank' && [C4SkillRules.AGGRO_DAMAGE, C4SkillRules.EFFECT].includes(type)) {
        score += 90;
        reasons.push('tank_control');
    }
    return { skill, score: Math.round(score), reasons, cost, range, power };
}

function select(bot, target, role) {
    const skills = bot?.skillset?.skills || [];
    const candidates = role === 'mage'
        ? skills.filter((skill) => skill.fetchSpell?.() === true)
        : skills;

    return candidates
        .map((skill) => evaluate(bot, target, skill, role))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)[0] || null;
}

module.exports = { OFFENSIVE_TYPES, evaluate, select };
