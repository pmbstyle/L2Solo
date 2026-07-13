const ServerResponse = invoke('GameServer/Network/Response');

function revive(session, actor, { delayMs = 2500, restoreFullVitals = false } = {}) {
    if (restoreFullVitals) {
        actor.automation.stopReplenish();
        actor.fillupVitals();
    } else {
        actor.automation.replenishVitals(actor);
    }

    if (delayMs <= 0) {
        actor.state.setDead(false);
        session.dataSendToMeAndOthers(ServerResponse.revive(actor.fetchId()), actor);
        session.dataSendToMeAndOthers(ServerResponse.socialAction(actor.fetchId(), 9), actor);
        return;
    }

    session.dataSendToMeAndOthers(ServerResponse.revive(actor.fetchId()), actor);

    setTimeout(() => {
        actor.state.setDead(false);
        session.dataSendToMeAndOthers(ServerResponse.socialAction(actor.fetchId(), 9), actor); // SWAG stand-up
    }, delayMs);
}

module.exports = revive;
