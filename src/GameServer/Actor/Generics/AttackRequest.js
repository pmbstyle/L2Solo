const AttackRange = invoke('GameServer/Actor/AttackRange');

const fetchNormalAttackRange = AttackRange.fetchNormalAttackRange;

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

    Generics.clearStoredActions(session, actor);

    // A rooted actor cannot acknowledge a StopMove with ValidatePosition.
    // Execute from its authoritative position; range still gates the action.
    if (!EffectRestrictions.canMove(actor)) {
        Generics.attackExec(session, actor, attackData);
        return;
    }

    if (actor.state.fetchTowards() === 'melee' &&
        Number(attackData.id) === Number(actor.automation.fetchDestId())) {
        return;
    }

    // StopMove is a notification, not a guaranteed position handshake.
    // A stationary client may send no ValidatePosition for a long time.
    // Start from the authoritative position now; AttackExec and meleeHit
    // still enforce weapon range and chase a target that is farther away.
    Generics.stopAutomation(session, actor);
    Generics.attackExec(session, actor, attackData);
}

module.exports = attackRequest;
module.exports.fetchNormalAttackRange = fetchNormalAttackRange;
module.exports.BOW_ATTACK_RANGE = AttackRange.BOW_ATTACK_RANGE;
module.exports.MELEE_ATTACK_RANGE = AttackRange.MELEE_ATTACK_RANGE;
module.exports.POLEARM_ATTACK_RANGE = AttackRange.POLEARM_ATTACK_RANGE;
