const EffectStore = invoke('GameServer/Effects/EffectStore');

const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
const ORC_SUPPORT_CLASS_IDS = new Set([49, 50, 51]);

function supportSkills(actor) {
    const skills = actor?.skillset?.fetchSkills?.() || actor?.skillset?.skills || [];
    return skills
        .filter((skill) => skill && !skill.fetchPassive?.())
        .filter((skill) => {
            const semantic = skill.fetchSemantic?.();
            return semantic?.effectType === 'buff' && ['friendly', 'ally', 'party'].includes(semantic.target);
        });
}

function priority(actor) {
    return ORC_SUPPORT_CLASS_IDS.has(Number(actor?.fetchClassId?.())) ? 0 : 1;
}

function statKeys(skill) {
    const semantic = skill.fetchSemantic?.() || {};
    const keys = Object.keys(semantic.stats || {});
    return keys.length > 0 ? keys : [semantic.effect].filter(Boolean);
}

function overlaps(effect, keys) {
    const effectKeys = Object.keys(effect?.stats || {});
    if (effectKeys.length > 0 && keys.some((key) => effectKeys.includes(key))) return true;
    return keys.includes(effect?.key) || keys.includes(effect?.category);
}

function needsSkill(target, skill) {
    const keys = statKeys(skill);
    const level = Number(skill.fetchLevel?.() || 1);
    const semantic = skill.fetchSemantic?.() || {};
    const current = EffectStore.list(target, { includeDebuffs: false })
        .filter((effect) => overlaps(effect, keys));

    // Older actors may still carry the temporary activeBuffs marker until their
    // first structured effect update. Treat it as an active equal-or-better buff.
    if (current.length === 0 && semantic.effect && Number(target?.activeBuffs?.[semantic.effect] || 0) > Date.now()) {
        return false;
    }
    if (current.some((effect) => Number(effect.level || 0) > level)) return false;
    if (current.some((effect) => Number(effect.level || 0) === level && EffectStore.remainingMs(target, effect.key) > REFRESH_THRESHOLD_MS)) {
        return false;
    }
    return true;
}

function canCast(actor, skill) {
    return Number(actor?.fetchMp?.() || 0) >= Number(skill?.fetchConsumedMp?.() || 0);
}

function preferredSkill(actor, target, candidates = supportSkills(actor)) {
    return candidates
        .filter((skill) => needsSkill(target, skill))
        .filter((skill) => canCast(actor, skill))
        .sort((a, b) => {
            const partyFirst = Number(b.fetchTargetKind?.() === 'party') - Number(a.fetchTargetKind?.() === 'party');
            return partyFirst || Number(b.fetchLevel?.() || 1) - Number(a.fetchLevel?.() || 1);
        })[0] || null;
}

function isCoveredByHigherPriority(caster, target, providers, skill) {
    const keys = statKeys(skill);
    return providers.some((provider) => {
        if (provider === caster || priority(provider) >= priority(caster)) return false;
        return supportSkills(provider).some((other) => (
            canCast(provider, other) && statKeys(other).some((key) => keys.includes(key)) && needsSkill(target, other)
        ));
    });
}

function nextAction(caster, members, providers = members.map((member) => member.actor).filter(Boolean)) {
    const targets = members
        .filter((member) => member?.actor && !member.actor.state?.fetchDead?.())
        .sort((a, b) => Number(a.leader !== true) - Number(b.leader !== true));

    for (const member of targets) {
        const skill = preferredSkill(caster, member.actor);
        if (!skill) continue;
        if (isCoveredByHigherPriority(caster, member.actor, providers, skill)) continue;
        return { target: member.actor, skill, effect: skill.fetchSemantic().effect };
    }
    return null;
}

function rebuffRequest(target, providers) {
    const candidate = providers
        .map((provider) => ({ provider, skill: preferredSkill(provider, target) }))
        .filter((entry) => entry.skill)
        .sort((a, b) => priority(a.provider) - priority(b.provider))[0];
    if (!candidate) return null;
    return {
        provider: candidate.provider,
        effect: candidate.skill.fetchSemantic().effect,
        skill: candidate.skill
    };
}

module.exports = {
    REFRESH_THRESHOLD_MS,
    supportSkills,
    needsSkill,
    nextAction,
    rebuffRequest
};
