const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const Attack = invoke('GameServer/Actor/Attack');

const OFFENSIVE_TYPES = new Set([
    C4SkillRules.DAMAGE,
    C4SkillRules.DAMAGE_EFFECT,
    C4SkillRules.DEATH_LINK,
    C4SkillRules.DRAIN,
    C4SkillRules.BLOW,
    C4SkillRules.EFFECT
]);
const BOW_WEAPON_MASK = 32;
const MIN_BOW_SKILL_RANGE = 400;

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

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function policyAdjustment(skill, role, range, cost, maxMp, policy = {}) {
    const skillId = String(skill?.fetchSelfId?.() || '');
    const priorities = policy.skillPriorities || {};
    let adjustment = clamp(Number(priorities[skillId] || 0), -50, 50);
    const stance = policy.stance || policy.combatStance || 'balanced';

    // Stance is only a bounded scoring hint for the offensive planner. It
    // cannot bypass learned-skill, range, cooldown, MP, or safety checks, and
    // support/revival planners never call this utility for emergency actions.
    if (stance === 'aggressive') {
        adjustment += Math.min(18, Math.max(0, Number(skill.fetchPower?.() || 0) / 40));
    } else if (stance === 'defensive') {
        const affordableReserve = (maxMp - cost) / Math.max(1, maxMp);
        adjustment += affordableReserve >= reserveRatio(role) ? 10 : -8;
    } else if (stance === 'ranged') {
        adjustment += range >= 400 ? 18 : -18;
    }

    return Math.round(clamp(adjustment, -68, 68));
}

function evaluate(bot, target, skill, role, policy = {}) {
    if (!skill || skill.fetchPassive?.()) return null;
    // SkillRequest rejects a skill still on reuse after the combat planner has
    // already committed to it. Treat that as unavailable here so a melee bot
    // falls back to its normal attack instead of idling until cooldown ends.
    if (bot.canUseSkill?.(skill) === false) return null;
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
    // Some generic fighter skills (for example Power Strike) have no weapon
    // restriction in the source data.  A bow user must never pick one of
    // those short-range attacks and run into melee just because its score is
    // higher than a shot currently on reuse.
    if ((Attack.weaponMaskFor(bot) & BOW_WEAPON_MASK) !== 0 && range < MIN_BOW_SKILL_RANGE) return null;

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
    if (role === 'tank' && type === C4SkillRules.EFFECT) {
        score += 90;
        reasons.push('tank_control');
    }
    const adjustment = policyAdjustment(skill, role, range, cost, maxMp, policy);
    if (adjustment) {
        score += adjustment;
        reasons.push(`policy_${adjustment > 0 ? 'up' : 'down'}:${adjustment}`);
    }
    return { skill, score: Math.round(score), reasons, cost, range, power, policyAdjustment: adjustment };
}

function select(bot, target, role, policy = {}) {
    const skills = bot?.skillset?.skills || [];
    const candidates = role === 'mage'
        ? skills.filter((skill) => skill.fetchSpell?.() === true)
        : skills;

    return candidates
        .map((skill) => evaluate(bot, target, skill, role, policy))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)[0] || null;
}

module.exports = { OFFENSIVE_TYPES, evaluate, select, policyAdjustment };
