const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const SummonControl = invoke('GameServer/Npc/SummonControl');

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

function summonSkill(actor) {
    return skillsFor(actor)
        .filter(isSummonSkill)
        .filter((skill) => actor.canUseSkill?.(skill) !== false)
        .filter((skill) => Number(skill.fetchConsumedMp?.() || 0) <= Number(actor.fetchMp?.() || 0))
        .sort((a, b) => Number(b.fetchSelfId?.() || 0) - Number(a.fetchSelfId?.() || 0)
            || Number(b.fetchLevel?.() || 0) - Number(a.fetchLevel?.() || 0))[0] || null;
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
    if (!actor || !BotRoles.isSummoner(actor)) return { handled: false, reason: 'not_summoner' };

    const summon = SummonControl.activeSummon(actor);
    if (!summon) {
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
        return { handled: true, reason: 'summon_attack', summon, target };
    }

    return { handled: true, reason: 'summon_attacking', summon, target };
}

module.exports = {
    PET_HEAL_IDS,
    PET_BUFF_IDS,
    isSummonSkill,
    summonSkill,
    combatAction
};
