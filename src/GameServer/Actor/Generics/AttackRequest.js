function attackRequest(session, actor, data) {
    const Generics = invoke(path.actor);
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

    if (actor.isDead()) {
        return;
    }

    if (!EffectRestrictions.canAttack(actor)) {
        EffectRestrictions.reject(session);
        return;
    }

    if (actor.isBlocked()) {
        Generics.queueRequest(session, actor, 'attack', data);
        return;
    }

    if (actor.state.inMotion()) {
        if (actor.state.fetchTowards() === 'remote' || actor.fetchDestId() !== actor.automation.fetchDestId()) {
            actor.storedAttack = data;
            Generics.stopAutomation(session, actor);
            return;
        }
    }

    if (actor.state.fetchTowards() === 'melee') {
        return;
    }

    actor.storedAttack = data;
    Generics.stopAutomation(session, actor);
}

module.exports = attackRequest;
