function skillRequest(session, actor, data) {
    const Generics = invoke(path.actor);
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
    const ToggleSkills = invoke('GameServer/Skills/ToggleSkills');
    const skill = actor.skillset.fetchSkill(data.selfId);

    if (actor.isDead()) {
        return;
    }

    if (!skill) {
        return;
    }

    // A disabled toggle (notably Fake Death) must remain possible to switch
    // off even though its own state blocks ordinary skill use.
    if (ToggleSkills.isActive(actor, skill)) {
        ToggleSkills.handleRequest(session, actor, skill);
        return;
    }

    if (!EffectRestrictions.canCast(actor)) {
        EffectRestrictions.reject(session);
        return;
    }

    if (ToggleSkills.handleRequest(session, actor, skill)) {
        return;
    }

    // C4 TARGET_PARTY skills are caster-centered auras. The client does not
    // need to keep an explicit target selected in order to sing or dance.
    if (skill.fetchTargetKind() === 'pet') {
        const summon = invoke('GameServer/Npc/SummonControl').activeSummon(actor);
        if (!summon) return;
        data.id = summon.fetchId();
    }
    else if (
        skill.fetchTargetKind() === 'self' ||
        skill.fetchTargetKind() === 'party' ||
        skill.fetchTargetKind() === 'ally' ||
        skill.fetchTargetKind() === 'corpse_ally' ||
        skill.fetchSemantic?.().sourceTarget === 'aura'
    ) {
        data.id = actor.fetchId();
    }
    else {
        data.id = actor.fetchDestId();
        // Lisvus TARGET_ONE explicitly permits SEED on the caster. With no
        // selected target, preserve that native self-seeding route.
        if (data.id === undefined && skill.fetchSkillType?.() === 'seed') {
            data.id = actor.fetchId();
        }
        else if (data.id === undefined) {
            return;
        }
    }

    if (!actor.canUseSkill(skill)) {
        EffectRestrictions.reject(session);
        return;
    }

    if (actor.isBlocked()) {
        Generics.queueRequest(session, actor, 'skill', data);
        return;
    }

    if (actor.state.inMotion()) {
        if (actor.state.fetchTowards() === 'melee' || actor.fetchDestId() !== actor.automation.fetchDestId()) {
            actor.storedSpell = data;
            Generics.stopAutomation(session, actor);
            return;
        }
    }

    if (actor.state.fetchTowards() === 'remote') {
        return;
    }

    actor.storedSpell = data;
    Generics.stopAutomation(session, actor);
}

module.exports = skillRequest;
