const BOW_ATTACK_RANGE = 700;

function fetchNormalAttackRange(actor, data = {}) {
    const requestedRange = Math.max(0, Number(data.range) || 0);
    if (requestedRange > 0) {
        return requestedRange;
    }

    return actor?.backpack?.fetchTotalWeaponKind?.() === 'Weapon.Bow' ? BOW_ATTACK_RANGE : 0;
}

function withNormalAttackRange(actor, data) {
    return {
        ...data,
        range: fetchNormalAttackRange(actor, data),
    };
}

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

    const attackData = withNormalAttackRange(actor, data);

    if (actor.isBlocked()) {
        Generics.queueRequest(session, actor, 'attack', attackData);
        return;
    }

    if (actor.state.inMotion()) {
        if (actor.state.fetchTowards() === 'remote' || actor.fetchDestId() !== actor.automation.fetchDestId()) {
            actor.storedAttack = attackData;
            Generics.stopAutomation(session, actor);
            return;
        }
    }

    if (actor.state.fetchTowards() === 'melee') {
        return;
    }

    actor.storedAttack = attackData;
    Generics.stopAutomation(session, actor);
}

module.exports = attackRequest;
module.exports.fetchNormalAttackRange = fetchNormalAttackRange;
module.exports.BOW_ATTACK_RANGE = BOW_ATTACK_RANGE;
