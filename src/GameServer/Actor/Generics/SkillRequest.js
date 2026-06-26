function skillRequest(session, actor, data) {
    const Generics = invoke(path.actor);
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
    const skill = actor.skillset.fetchSkill(data.selfId);

    if (actor.isDead()) {
        return;
    }

    if (!skill) {
        return;
    }

    if (!EffectRestrictions.canCast(actor)) {
        EffectRestrictions.reject(session);
        return;
    }

    if (skill.fetchTargetKind() === 'self') {
        data.id = actor.fetchId();
    }
    else if ((data.id = actor.fetchDestId()) === undefined) {
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
