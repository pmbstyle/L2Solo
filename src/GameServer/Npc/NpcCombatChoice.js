'use strict';

// Owner: what a monster does in a fight besides its weapon hit (L2J C4
// AttackableAI): a self buff it lacks, else per category a rolled chance of
// a hard control, sleep, root, mute, debuff, then damage skill. The hot Npc
// (selectCombatSkill) and the cold fight (BackgroundResolver) both choose
// through it; each supplies its own state (MP, reuse, effects).

const AI_TYPES = new Set(['fighter', 'mage', 'balanced', 'archer']);
const HARD_CONTROL_EFFECTS = new Set(['stun', 'paralyze']);
const SLEEP_EFFECTS = new Set(['sleep']);
const ROOT_EFFECTS = new Set(['root']);
const MUTE_EFFECTS = new Set(['silence', 'physical_mute', 'magic_mute', 'mute']);
const DEBUFF_GAP_MS = 6000;

function semanticEffect(skill) {
    const semantic = skill?.fetchSemantic?.() || {};
    return String(semantic.effect || semantic.trait || '').trim().toLowerCase();
}

function skillDistance(skill) {
    const semantic = skill?.fetchSemantic?.() || {};
    const sourcedRange = Number(semantic.castRange);
    const modelRange = Number(skill?.fetchDistance?.());
    return Math.max(
        0,
        Number.isFinite(sourcedRange) ? sourcedRange : 0,
        Number.isFinite(modelRange) ? modelRange : 0
    );
}

function category(skill) {
    const semantic = skill?.fetchSemantic?.() || {};
    const effect = semanticEffect(skill);
    if (HARD_CONTROL_EFFECTS.has(effect)) return 'hard_control';
    if (SLEEP_EFFECTS.has(effect)) return 'sleep';
    if (ROOT_EFFECTS.has(effect)) return 'root';
    if (MUTE_EFFECTS.has(effect) || semantic.physicalMute || semantic.magicMute) return 'mute';
    if (semantic.effectType === 'debuff') return 'debuff';
    return 'damage';
}

// Percent chance a monster of aiType casts a skill of the category on a
// target of targetAiType in one combat tick.
function chance(skill, kind, aiType = 'fighter', targetAiType = 'fighter') {
    const closeRange = skillDistance(skill) < 200;
    if (kind === 'hard_control') return closeRange ? 10 : 7;
    if (kind === 'sleep') return 1;
    if (kind === 'root') return 8;
    if (kind === 'mute') return (targetAiType === 'mage' || targetAiType === 'balanced') ? 8 : 3;
    if (kind === 'debuff') {
        let value = 5;
        if (aiType === 'fighter' && ['mage', 'archer'].includes(targetAiType)) value = 3;
        if (aiType === 'mage' && targetAiType !== 'mage') value = 4;
        if (closeRange) value += 3;
        return value;
    }
    if (aiType === 'mage') return closeRange ? 35 : 25;
    if (aiType === 'balanced') {
        if (closeRange) return 12;
        return targetAiType === 'mage' ? 2 : 5;
    }
    if (aiType === 'archer') return closeRange ? 12 : 3;
    if (closeRange) return 12;
    return targetAiType === 'mage' ? 1 : 3;
}

// The AI enum a template names (any of its spellings), or null: corpse and
// healer monsters fight as balanced ones.
function aiTypeOfModel(model) {
    const value = model?.ai ?? model?.AI ?? model?.aiType ?? model?.template?.ai ?? model?.template?.AI ?? model?.template?.aiType;
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'corpse' || normalized === 'healer') return 'balanced';
    return AI_TYPES.has(normalized) ? normalized : null;
}

// Most imported C4 templates carry no AI enum: long-range magic damage reads
// as a mage, a long attack radius as an archer; an explicit value wins.
function aiTypeFor(explicit, skills, attackRadius) {
    if (explicit && AI_TYPES.has(explicit)) return explicit;
    const caster = skills.some((skill) => (
        skill.fetchTargetKind?.() === 'enemy'
        && skill.fetchSpell?.() === true
        && skillDistance(skill) >= 200
        && !skill.fetchSemantic?.()?.effect
    ));
    if (caster) return 'mage';
    const radius = Number(attackRadius);
    if (Number.isFinite(radius) && radius >= 200) return 'archer';
    return 'fighter';
}

// A skill's reuse as the monster keeps it: at least a second (L2J C4).
function reuseMs(skill) {
    return Math.max(1000, Number(skill?.fetchReuseTime?.()) || 0);
}

// The skills by what select() asks of them, once per skill list (a hot Npc
// keeps its list, the cold fight one per species): self buffs, and enemy
// skills by category in their order.
const KINDS = ['hard_control', 'sleep', 'root', 'mute', 'debuff', 'damage'];
const indexes = new WeakMap();
function indexOf(skills) {
    let index = indexes.get(skills);
    if (index) return index;
    index = { selfBuffs: [], enemy: Object.fromEntries(KINDS.map(kind => [kind, []])) };
    for (const skill of skills) {
        const target = skill.fetchTargetKind?.();
        const semantic = skill.fetchSemantic?.() || {};
        if (target === 'self') {
            if (semantic.effectType === 'buff' && semantic.effect) index.selfBuffs.push(skill);
        } else if (target === 'enemy') index.enemy[category(skill)].push(skill);
    }
    indexes.set(skills, index);
    return index;
}

// One combat tick's pick: { skill, category } or null (the weapon hit).
// skills: the monster's combat skills (a list kept between ticks);
// usable(skill): MP and reuse allow it; buffNeeded(skill): a self buff it
// does not hold; hasTarget; impairments of the target ({ disabled, rooted,
// silenced }); aiType, targetAiType; debuffReady: DEBUFF_GAP_MS since its
// last debuff.
function select({ skills, usable, buffNeeded, hasTarget = true, impairments = {}, aiType = 'fighter',
    targetAiType = 'fighter', debuffReady = true, rng = Math.random }) {
    const index = indexOf(skills);
    const selfBuff = index.selfBuffs.find((skill) => usable(skill) && buffNeeded(skill));
    if (selfBuff) return { skill: selfBuff, category: 'buff' };
    if (!hasTarget) return null;
    const pick = (kind, allowed = true) => {
        if (!allowed) return null;
        const selected = index.enemy[kind].find((skill) => usable(skill)
            && Number(rng()) * 100 <= chance(skill, kind, aiType, targetAiType));
        return selected ? { skill: selected, category: kind } : null;
    };
    // L2J checks special utility categories before ordinary damage. A failed
    // special roll does not consume the action: the monster may still roll a
    // normal damage skill during this combat tick.
    return pick('hard_control', !impairments.disabled) || pick('sleep', !impairments.disabled)
        || pick('root', !impairments.rooted) || pick('mute', !impairments.silenced)
        || pick('debuff', debuffReady) || pick('damage');
}

module.exports = { AI_TYPES, DEBUFF_GAP_MS, semanticEffect, skillDistance, category, chance, aiTypeOfModel, aiTypeFor, reuseMs,
    select };
