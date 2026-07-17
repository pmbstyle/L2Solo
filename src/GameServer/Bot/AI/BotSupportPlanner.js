const EffectStore = invoke('GameServer/Effects/EffectStore');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

const REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
const CAST_RESERVATION_MS = 5000;

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
    return skills
        .filter((skill) => skill && !skill.fetchPassive?.())
        .filter((skill) => {
            const semantic = skill.fetchSemantic?.();
            return semantic?.effectType === 'buff' && ['friendly', 'ally', 'party'].includes(semantic.target);
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
            .filter((skill) => isUsefulForTarget(member.actor, skill) && canCast(provider, skill) && needsSkill(member.actor, skill) && (!respectReservations || !isReserved(member.actor, skill)))
            .map((skill) => ({ provider, target: member.actor, leader: member.leader === true, skill, effect: skill.fetchSemantic().effect }))));
}

function nextAction(caster, members, providers = members.map((member) => member.actor).filter(Boolean)) {
    const next = allActions(members, providers).sort(actionCompare)[0] || null;
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
    supportSkills,
    isUsefulForTarget,
    needsSkill,
    actionCompare,
    reserve,
    nextAction,
    rebuffRequest
};
