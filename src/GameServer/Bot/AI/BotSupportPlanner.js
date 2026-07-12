const EffectStore = invoke('GameServer/Effects/EffectStore');

const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
const CAST_RESERVATION_MS = 5000;

function supportSkills(actor) {
    const skills = actor?.skillset?.fetchSkills?.() || actor?.skillset?.skills || [];
    return skills
        .filter((skill) => skill && !skill.fetchPassive?.())
        .filter((skill) => {
            const semantic = skill.fetchSemantic?.();
            return semantic?.effectType === 'buff' && ['friendly', 'ally', 'party'].includes(semantic.target);
        });
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

function actorOrder(actor) {
    return Number(actor?.fetchId?.() || Number.MAX_SAFE_INTEGER);
}

function supportKey(skill) {
    return statKeys(skill).sort().join('|');
}

function isReserved(target, skill) {
    const entry = target?.supportReservations?.[supportKey(skill)];
    return Number(entry?.expiresAt || 0) > Date.now();
}

function reserve(action) {
    if (!action?.target || !action?.skill) return;
    if (!action.target.supportReservations) action.target.supportReservations = {};
    action.target.supportReservations[supportKey(action.skill)] = {
        casterId: actorOrder(action.provider),
        expiresAt: Date.now() + CAST_RESERVATION_MS
    };
}

function actionCompare(a, b) {
    const partyFirst = Number(b.skill.fetchTargetKind?.() === 'party') - Number(a.skill.fetchTargetKind?.() === 'party');
    if (partyFirst) return partyFirst;

    const leaderFirst = Number(b.leader) - Number(a.leader);
    if (leaderFirst) return leaderFirst;

    const strongerFirst = Number(b.skill.fetchLevel?.() || 1) - Number(a.skill.fetchLevel?.() || 1);
    if (strongerFirst) return strongerFirst;

    const moreManaFirst = Number(b.provider.fetchMp?.() || 0) - Number(a.provider.fetchMp?.() || 0);
    if (moreManaFirst) return moreManaFirst;

    return actorOrder(a.provider) - actorOrder(b.provider);
}

function allActions(members, providers, respectReservations = true) {
    return members
        .filter((member) => member?.actor && !member.actor.state?.fetchDead?.())
        .flatMap((member) => providers.flatMap((provider) => supportSkills(provider)
            .filter((skill) => canCast(provider, skill) && needsSkill(member.actor, skill) && (!respectReservations || !isReserved(member.actor, skill)))
            .map((skill) => ({ provider, target: member.actor, leader: member.leader === true, skill, effect: skill.fetchSemantic().effect }))));
}

function nextAction(caster, members, providers = members.map((member) => member.actor).filter(Boolean)) {
    const next = allActions(members, providers).sort(actionCompare)[0] || null;
    if (next?.provider !== caster) return null;
    reserve(next);
    return next;
}

function rebuffRequest(target, providers) {
    const candidate = allActions([{ actor: target, leader: true }], providers, false)
        .sort(actionCompare)[0];
    if (!candidate) return null;
    return {
        provider: candidate.provider,
        effect: candidate.skill.fetchSemantic().effect,
        skill: candidate.skill
    };
}

module.exports = {
    REFRESH_THRESHOLD_MS,
    CAST_RESERVATION_MS,
    supportSkills,
    needsSkill,
    actionCompare,
    reserve,
    nextAction,
    rebuffRequest
};
