const EffectStore = invoke('GameServer/Effects/EffectStore');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');

const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
const CAST_RESERVATION_MS = 5000;
const PENDING_SUPPORT_CAST_TIMEOUT_MS = 30000;
const MIN_SUPPORT_MP_RATIO = 0.35;
// These effects are situational utility, not part of the ordinary field
// package. Keeping them out of the party planner prevents a buffer/healer
// from spending MP and pausing pulls for a buff the group cannot use.
const EXCLUDED_PARTY_BUFF_EFFECTS = new Set(['kiss_of_eva']);

const PHYSICAL_ROLES = new Set(['tank', 'dagger', 'archer', 'dps']);
const CASTER_ROLES = new Set(['mage', 'healer', 'buffer']);
const DAMAGE_DEALER_ROLES = new Set(['dagger', 'archer', 'dps']);

// These are single-target buffs whose value depends on the recipient's combat
// role. Defensive, resistance and movement buffs intentionally stay universal.
const INDIVIDUAL_BUFF_TARGET_ROLES = {
    power_of_paagrio: PHYSICAL_ROLES,
    might: PHYSICAL_ROLES,
    holy_weapon: PHYSICAL_ROLES,
    focus: PHYSICAL_ROLES,
    haste: PHYSICAL_ROLES,
    guidance: PHYSICAL_ROLES,
    death_whisper: PHYSICAL_ROLES,
    chant_of_fury: PHYSICAL_ROLES,
    chant_of_rage: PHYSICAL_ROLES,
    vampiric_rage: PHYSICAL_ROLES,
    eye_of_paagrio: PHYSICAL_ROLES,
    berserker_spirit: DAMAGE_DEALER_ROLES,
    rage_of_paagrio: DAMAGE_DEALER_ROLES,
    soul_of_paagrio: CASTER_ROLES,
    wisdom_of_paagrio: CASTER_ROLES,
    blessed_soul: CASTER_ROLES,
    empower: CASTER_ROLES,
    concentration: CASTER_ROLES,
    acumen: CASTER_ROLES,
    wild_magic: CASTER_ROLES
};

function supportSkills(actor) {
    const skills = actor?.skillset?.fetchSkills?.() || actor?.skillset?.skills || [];
    const overlay = HotBotPolicyOverlay.get(actor?.session);
    const excluded = new Set(overlay?.buffPolicy?.excluded || []);
    return skills
        .filter((skill) => skill && !skill.fetchPassive?.())
        .filter((skill) => {
            const semantic = skill.fetchSemantic?.();
            // Heal-over-time effects are represented as temporary buffs for
            // the effect engine, but they are not part of the persistent
            // party-buff package. Treating a 15-second HoT as a rebuff makes
            // the support planner request it continuously and pauses pulling.
            const skillType = skill.fetchSkillType?.();
            const periodicHeal = skillType === 'hot' || skillType === 'healHot' || skillType === 'manaHot';
            const effect = String(semantic?.effect || '').toLowerCase();
            return !periodicHeal &&
                semantic?.effectType === 'buff' &&
                !EXCLUDED_PARTY_BUFF_EFFECTS.has(semantic.effect) &&
                !excluded.has(effect) &&
                // The current policy is deny-by-exception. Ignore the legacy
                // `allowed` field so one old `allow` command cannot turn the
                // whole support package exclusive.
                ['friendly', 'ally', 'party'].includes(semantic.target);
        });
}

function isUsefulForTarget(target, skill) {
    const semantic = skill?.fetchSemantic?.() || {};
    // Party skills retain their native all-members behaviour. The role policy
    // only prevents wasting individual casts on roles that cannot use them.
    if (semantic.target === 'party' || skill?.fetchTargetKind?.() === 'party') return true;

    const allowedRoles = INDIVIDUAL_BUFF_TARGET_ROLES[semantic.effect];
    return !allowedRoles || allowedRoles.has(BotRoles.inferRole(target));
}

function statKeys(skill) {
    const semantic = skill.fetchSemantic?.() || {};
    // Match both the C4 stat slot and the semantic effect key.  Older saved
    // newbie buffs had an empty stats object, but still carried their effect
    // identity (for example `shield`).  Treating only pDefMul/runSpdAdd as a
    // match made the planner recast a buff it could never downgrade.
    return [...new Set([
        ...Object.keys(semantic.stats || {}),
        semantic.effect
    ].filter(Boolean))];
}

function overlaps(effect, keys) {
    const effectKeys = Object.keys(effect?.stats || {});
    if (effectKeys.length > 0 && keys.some((key) => effectKeys.includes(key))) return true;
    return keys.includes(effect?.key) || keys.includes(effect?.category);
}

function needsSkill(target, skill) {
    const keys = statKeys(skill);
    const level = Number(skill.fetchLevel?.() || 1);
    const skillId = Number(skill.fetchSelfId?.() || 0);
    const semantic = skill.fetchSemantic?.() || {};
    const current = EffectStore.list(target, { includeDebuffs: false })
        // The effect id is the authoritative identity for a completed cast.
        // Keep the stat/effect-key fallback for old saved effects, but do not
        // re-request a buff merely because an older payload lacked its modern
        // semantic stat keys.
        .filter((effect) => Number(effect.id || 0) === skillId || overlaps(effect, keys));

    // `activeBuffs` is retained for packet/UI compatibility only. It can outlive
    // an effect after death, dispel, or an interrupted cast, so support decisions
    // must be based exclusively on the target's structured effect state.
    if (current.some((effect) => Number(effect.level || 0) > level)) return false;
    if (current.some((effect) => Number(effect.level || 0) === level && EffectStore.remainingMs(target, effect.key) > REFRESH_THRESHOLD_MS)) {
        return false;
    }
    return true;
}

function canCast(actor, skill) {
    return Number(actor?.fetchMp?.() || 0) >= Number(skill?.fetchConsumedMp?.() || 0);
}

function isBusy(actor) {
    return !!(
        actor?.state?.fetchTowards?.() ||
        actor?.state?.fetchHits?.() ||
        actor?.state?.fetchCasts?.()
    );
}

function canStartSupportCast(action) {
    const actor = action?.provider;
    const mp = Number(actor?.fetchMp?.() || 0);
    const maxMp = Math.max(1, Number(actor?.fetchMaxMp?.() || mp || 1));
    return canCast(actor, action?.skill) &&
        mp / maxMp >= MIN_SUPPORT_MP_RATIO &&
        !EffectStore.impairments(actor).silenced &&
        !isBusy(actor);
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
    const hitTime = Number(action.skill.fetchCalculatedHitTime?.() || action.skill.fetchHitTime?.() || 0);
    action.target.supportReservations[supportKey(action.skill)] = {
        casterId: actorOrder(action.provider),
        // The effect can only exist after the native hit. A fixed five-second
        // window was shorter than some C4 casts and let pulling resume early.
        expiresAt: Date.now() + Math.max(CAST_RESERVATION_MS, hitTime + 1000)
    };
}

function actionCompare(a, b) {
    const partyFirst = Number(b.skill.fetchTargetKind?.() === 'party') - Number(a.skill.fetchTargetKind?.() === 'party');
    if (partyFirst) return partyFirst;

    const pullerFirst = Number(b.puller) - Number(a.puller);
    if (pullerFirst) return pullerFirst;

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
            .filter((skill) => isUsefulForTarget(member.actor, skill) && canCast(provider, skill) && needsSkill(member.actor, skill) && (!respectReservations || !isReserved(member.actor, skill)))
            .map((skill) => ({
                provider,
                target: member.actor,
                leader: member.leader === true,
                puller: member.puller === true,
                skill,
                effect: skill.fetchSemantic().effect
            }))));
}

function queueSupportCast(session, action) {
    if (!session || !action?.provider || !action?.target || !action?.skill) return false;
    session.pendingSupportCast = {
        providerId: actorOrder(action.provider),
        targetId: actorOrder(action.target),
        skillId: Number(action.skill.fetchSelfId?.() || 0),
        // skillExec can first walk into cast range. Keep the party's pull
        // pause active through that approach instead of treating the cast as
        // abandoned after the old fixed five-second window.
        expiresAt: Date.now() + PENDING_SUPPORT_CAST_TIMEOUT_MS
    };
    return true;
}

function beginSupportCast(session, provider, target, skill) {
    const pending = session?.pendingSupportCast;
    if (!pending || Number(pending.expiresAt || 0) <= Date.now()) {
        if (session) session.pendingSupportCast = undefined;
        return false;
    }
    if (
        Number(pending.providerId) !== actorOrder(provider) ||
        Number(pending.targetId) !== actorOrder(target) ||
        Number(pending.skillId) !== Number(skill?.fetchSelfId?.() || 0)
    ) {
        return false;
    }

    reserve({ provider, target, skill });
    session.pendingSupportCast = undefined;
    session.activeSupportCast = {
        targetId: actorOrder(target),
        skillId: Number(skill.fetchSelfId())
    };
    return true;
}

function cancelPendingSupportCast(session, provider, target, skill) {
    const pending = session?.pendingSupportCast;
    if (!pending ||
        Number(pending.providerId) !== actorOrder(provider) ||
        Number(pending.targetId) !== actorOrder(target) ||
        Number(pending.skillId) !== Number(skill?.fetchSelfId?.() || 0)) {
        return false;
    }

    session.pendingSupportCast = undefined;
    return true;
}

function finishSupportCast(session, provider, skill) {
    const active = session?.activeSupportCast;
    if (!active || Number(active.skillId) !== Number(skill?.fetchSelfId?.() || 0)) return false;
    session.activeSupportCast = undefined;
    if (Number(session.currentTargetId) === Number(active.targetId)) {
        session.currentTargetId = undefined;
        provider?.unselect?.();
    }
    return true;
}

function cancelSupportCast(session, provider) {
    if (!session) return false;
    const active = session.activeSupportCast;
    const pending = session.pendingSupportCast;
    session.pendingSupportCast = undefined;
    session.activeSupportCast = undefined;
    if (active && Number(session.currentTargetId) === Number(active.targetId)) {
        session.currentTargetId = undefined;
        provider?.unselect?.();
    }
    return !!(active || pending);
}

function hasPendingAction(members, providers = members.map((member) => member.actor).filter(Boolean)) {
    // A reservation only prevents two casters from duplicating the same cast;
    // it does not mean the buff has landed.  Pulling must remain paused until
    // the structured effect is actually present on the recipient.
    const hasActiveReservation = members.some((member) => Object.values(member?.actor?.supportReservations || {})
        .some((reservation) => Number(reservation?.expiresAt || 0) > Date.now()));
    const hasQueuedCast = providers.some((provider) => (
        Number(provider?.session?.pendingSupportCast?.expiresAt || 0) > Date.now()
    ));
    return hasActiveReservation || hasQueuedCast || allActions(members, providers, false).some(canStartSupportCast);
}

function nextAction(caster, members, providers = members.map((member) => member.actor).filter(Boolean)) {
    const next = allActions(members, providers).filter(canStartSupportCast).sort(actionCompare)[0] || null;
    if (next?.provider !== caster) return null;
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
    PENDING_SUPPORT_CAST_TIMEOUT_MS,
    MIN_SUPPORT_MP_RATIO,
    supportSkills,
    isUsefulForTarget,
    needsSkill,
    actionCompare,
    hasPendingAction,
    reserve,
    queueSupportCast,
    beginSupportCast,
    cancelPendingSupportCast,
    finishSupportCast,
    cancelSupportCast,
    nextAction,
    rebuffRequest
};
