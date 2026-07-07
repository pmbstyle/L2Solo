const EffectStore = invoke('GameServer/Effects/EffectStore');
const ServerResponse = invoke('GameServer/Network/Response');

function canMove(actor) {
    const impairments = EffectStore.impairments(actor);
    return !(impairments.disabled || impairments.rooted);
}

function canAttack(actor) {
    return !EffectStore.impairments(actor).disabled;
}

function canCast(actor) {
    const impairments = EffectStore.impairments(actor);
    return !(impairments.disabled || impairments.silenced);
}

function canUseBasicAction(actor) {
    return !EffectStore.impairments(actor).disabled;
}

function reject(session) {
    if (session?.dataSendToMe) {
        session.dataSendToMe(ServerResponse.actionFailed());
    }
}

function interruptOnApply(session, actor, effect) {
    if (!actor || !effect || effect.type !== 'debuff') return;
    const impairments = EffectStore.impairments(actor);
    if (!(impairments.disabled || impairments.rooted)) return;

    actor.automation?.abortAll?.(actor);
    actor.attack?.clearTimers?.();
    actor.attack?.resetQueuedEvent?.();
    actor.state?.setHits?.(false);
    actor.state?.setCasts?.(false);
    if (impairments.disabled) {
        actor.state?.setCombats?.(false);
        if (typeof actor.abortCombatState === 'function') {
            const safeSession = session?.dataSendToMeAndOthers ? session : { dataSendToMeAndOthers() {} };
            actor.abortCombatState(safeSession);
        }
    }
    if (session?.moveTimer) {
        clearInterval(session.moveTimer);
        session.moveTimer = null;
    }
}

function wakeOnDamage(actor) {
    if (!actor) return false;
    const removed = EffectStore.remove(actor, 'sleep');
    if (!removed) return false;

    const packet = ServerResponse.abnormalStatusUpdate.fromActor(actor);
    if (actor.session?.dataSendToMe) {
        actor.session.dataSendToMe(packet);
    }
    return true;
}

module.exports = {
    canMove,
    canAttack,
    canCast,
    canUseBasicAction,
    reject,
    interruptOnApply,
    wakeOnDamage
};
