const ServerResponse = invoke('GameServer/Network/Response');

function die(session, actor) {
    if (actor.isDead()) {
        return;
    }

    actor.destructor();
    // Death cancels the timers that normally release transient action flags
    // (cast, hit, sit animation, pickup). Reset them explicitly so a town
    // restart cannot leave the actor permanently blocked after those timers
    // have been cancelled.
    actor.state.destructor();
    actor.state.setDead(true);
    session.dataSendToMeAndOthers(ServerResponse.die(actor.fetchId()), actor);
}

module.exports = die;
