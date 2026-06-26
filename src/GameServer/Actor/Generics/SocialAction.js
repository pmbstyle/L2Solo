const ServerResponse = invoke('GameServer/Network/Response');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

function socialAction(session, actor, data) {
    if (!EffectRestrictions.canUseBasicAction(actor)) {
        EffectRestrictions.reject(session);
        return;
    }

    if (actor.isDead() || actor.isBlocked() || actor.state.inMotion()) {
        return;
    }

    actor.automation.abortAll(actor);
    session.dataSendToMeAndOthers(ServerResponse.socialAction(actor.fetchId(), data.actionId), actor);
}

module.exports = socialAction;
