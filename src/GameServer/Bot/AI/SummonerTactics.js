const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const SummonControl = invoke('GameServer/Npc/SummonControl');
const World = invoke('GameServer/World/World');

const PET_HEAL_IDS = new Set([1127, 1300]);
const PET_BUFF_IDS = new Set([1139, 1140, 1141, 1144, 1145, 1146, 1299, 1301]);

function skillsFor(actor) {
    return actor?.skillset?.skills || actor?.skillset?.fetchSkills?.() || [];
}

function isSummonSkill(skill) {
    if (!skill || skill.fetchPassive?.() === true) return false;
    const semantic = skill.fetchSemantic?.() || C4SkillRules.resolve(skill);
    const skillType = semantic.skillType || skill.fetchSkillType?.();
    const target = semantic.target || skill.fetchTargetKind?.();
    return skillType === C4SkillRules.SUMMON
        && target === 'self'
        && Number(skill.fetchSummonNpcId?.() || 0) > 10
        && skill.fetchSummonIsCubic?.() !== true;
}

function isCorpseSummonSkill(skill) {
    if (!skill || skill.fetchPassive?.() === true) return false;
    const semantic = skill.fetchSemantic?.() || C4SkillRules.resolve(skill);
    const skillType = semantic.skillType || skill.fetchSkillType?.();
    const target = semantic.target || skill.fetchTargetKind?.();
    return skillType === C4SkillRules.SUMMON
        && target === 'corpse_mob'
        && Number(skill.fetchSummonNpcId?.() || 0) > 10
        && skill.fetchSummonIsCubic?.() !== true;
}

function summonSkill(actor) {
    return skillsFor(actor)
        .filter(isSummonSkill)
        .filter((skill) => actor.canUseSkill?.(skill) !== false)
        .filter((skill) => Number(skill.fetchConsumedMp?.() || 0) <= Number(actor.fetchMp?.() || 0))
        .sort((a, b) => Number(b.fetchSelfId?.() || 0) - Number(a.fetchSelfId?.() || 0)
            || Number(b.fetchLevel?.() || 0) - Number(a.fetchLevel?.() || 0))[0] || null;
}

function corpseSummonSkill(actor, target = null) {
    if (!BotRoles.isNecromancer(actor)) return null;
    if (SummonControl.activeSummon(actor)) return null;
    if (target && (target.fetchAttackable?.() !== true || target.isDead?.() !== true)) return null;
    return skillsFor(actor)
        .filter(isCorpseSummonSkill)
        .filter((skill) => actor.canUseSkill?.(skill) !== false)
        .filter((skill) => Number(skill.fetchConsumedMp?.() || 0) <= Number(actor.fetchMp?.() || 0))
        .sort((a, b) => Number(b.fetchSelfId?.() || 0) - Number(a.fetchSelfId?.() || 0)
            || Number(b.fetchLevel?.() || 0) - Number(a.fetchLevel?.() || 0))[0] || null;
}

function rememberNecromancerTarget(session, actor, target) {
    if (!BotRoles.isNecromancer(actor) || !target || target.fetchAttackable?.() !== true || target.isDead?.() === true) return;
    session.necromancerLastTargetId = Number(target.fetchId?.() || 0) || undefined;
    session.necromancerLastTargetAt = Date.now();
}

function corpseTarget(session, actor) {
    if (!BotRoles.isNecromancer(actor) || SummonControl.activeSummon(actor)) return null;

    const rememberedId = Number(session?.necromancerLastTargetId || 0);
    const rememberedAt = Number(session?.necromancerLastTargetAt || 0);
    const currentId = Number(session?.currentTargetId || actor.fetchDestId?.() || 0);
    const candidateIds = [...new Set([
        currentId,
        rememberedAt > 0 && Date.now() - rememberedAt <= 15000 ? rememberedId : 0
    ].filter((id) => id > 0))];
    if (candidateIds.length === 0) return null;

    return (World.npc?.spawns || []).find((candidate) => (
        candidateIds.includes(Number(candidate.fetchId?.() || 0))
        && candidate.fetchAttackable?.() === true
        && candidate.isDead?.() === true
        && corpseSummonSkill(actor, candidate)
    )) || null;
}

function petSkill(actor, predicate) {
    return skillsFor(actor)
        .filter((skill) => skill.fetchTargetKind?.() === 'pet')
        .filter(predicate)
        .filter((skill) => actor.canUseSkill?.(skill) !== false)
        .filter((skill) => Number(skill.fetchConsumedMp?.() || 0) <= Number(actor.fetchMp?.() || 0))
        .sort((a, b) => Number(b.fetchLevel?.() || 0) - Number(a.fetchLevel?.() || 0))[0] || null;
}

function effectActive(summon, skill) {
    const semantic = skill.fetchSemantic?.() || C4SkillRules.resolve(skill);
    const skillId = Number(skill.fetchSelfId?.() || 0);
    return EffectStore.list(summon).some((effect) => (
        Number(effect?.id || 0) === skillId || (semantic.effect && effect?.key === semantic.effect)
    ));
}

function cast(session, actor, summon, skill, Generics) {
    Generics.skillExec(session, actor, {
        id: summon.fetchId(),
        selfId: skill.fetchSelfId(),
        ctrl: true
    });
    return {
        handled: true,
        reason: PET_HEAL_IDS.has(Number(skill.fetchSelfId())) ? 'heal_summon' : 'buff_summon',
        skill
    };
}

function combatAction(session, actor, target, Generics) {
    const isSummoner = BotRoles.isSummoner(actor);
    const isNecromancer = BotRoles.isNecromancer(actor);
    if (!actor || (!isSummoner && !isNecromancer)) return { handled: false, reason: 'not_summoner' };

    rememberNecromancerTarget(session, actor, target);

    const summon = SummonControl.activeSummon(actor);
    if (!summon) {
        const corpseSkill = target ? corpseSummonSkill(actor, target) : null;
        if (corpseSkill) {
            Generics.skillExec(session, actor, {
                id: target.fetchId(),
                selfId: corpseSkill.fetchSelfId(),
                ctrl: true
            });
            return { handled: true, reason: 'summon_corpse', skill: corpseSkill, target };
        }

        // Necromancers keep using their own offensive spells until a real
        // monster corpse becomes available.  A corpse summon cannot be cast
        // against the living target they are currently fighting.
        if (isNecromancer) return { handled: false, reason: 'corpse_unavailable' };

        const skill = summonSkill(actor);
        if (!skill) return { handled: false, reason: 'summon_unavailable' };
        Generics.skillExec(session, actor, {
            id: actor.fetchId(),
            selfId: skill.fetchSelfId(),
            ctrl: true
        });
        return { handled: true, reason: 'summon_servitor', skill };
    }

    const summonMaxHp = Number(summon.fetchMaxHp?.() || 0);
    const summonHp = Number(summon.fetchHp?.() || summonMaxHp);
    const heal = petSkill(actor, (skill) => PET_HEAL_IDS.has(Number(skill.fetchSelfId()))
        && summonMaxHp > 0 && summonHp / summonMaxHp < 0.7);
    if (heal) return cast(session, actor, summon, heal, Generics);

    const buff = petSkill(actor, (skill) => PET_BUFF_IDS.has(Number(skill.fetchSelfId()))
        && !effectActive(summon, skill));
    if (buff) return cast(session, actor, summon, buff, Generics);

    if (!target) {
        if (summon.controlMode !== 'follow') SummonControl.startFollowOwner(session, actor, summon);
        return { handled: true, reason: 'summon_follow', summon };
    }

    const targetId = Number(target.fetchId?.() || 0);
    const selectedId = Number(actor.fetchDestId?.() || 0);
    if (summon.controlMode !== 'attack' || selectedId !== targetId) {
        actor.select?.({ id: targetId });
        SummonControl.attack(session, actor, summon);
        // The summon keeps its own attack loop.  Starting that loop must not
        // consume the owner's combat tick: the summoner can cast an offensive
        // spell while the servitor is moving into melee range.
        return { handled: false, reason: 'summon_attack', summon, target };
    }

    // A servitor already attacking is not an owner action.  Let the normal
    // combat selector choose the summoner's own spell or weapon attack.
    return { handled: false, reason: 'summon_attacking', summon, target };
}

module.exports = {
    PET_HEAL_IDS,
    PET_BUFF_IDS,
    isSummonSkill,
    isCorpseSummonSkill,
    summonSkill,
    corpseSummonSkill,
    corpseTarget,
    combatAction
};
