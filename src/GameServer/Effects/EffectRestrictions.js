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
    actor.attack?.resetQueuedEvent?.();
    if (session?.moveTimer) {
        clearInterval(session.moveTimer);
        session.moveTimer = null;
    }
}

module.exports = {
    canMove,
    canAttack,
    canCast,
    canUseBasicAction,
    reject,
    interruptOnApply
};
