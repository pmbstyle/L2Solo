const ServerResponse = invoke('GameServer/Network/Response');

function teleportTo(session, actor, coords) {
    const Generics = invoke(path.actor);

    if (actor.isDead() || actor.isBlocked()) {
        return;
    }

    actor.clearDestId();
    actor.automation.abortAll(actor);
    session.dataSendToMeAndOthers(ServerResponse.teleportToLocation(actor.fetchId(), coords), actor);

    // Turns out to be a viable solution
    setTimeout(() => {
        Generics.updatePosition(session, actor, coords);
        Generics.updateEnvironment(session, actor); // Force update position, in case we Teleport to the same Location

        // Wake up bot AI after teleportation is complete and position updated
        if (session.aiActive) {
            const BotAI = invoke('GameServer/Bot/BotAI');
            BotAI.wakeup(session);
        }
    }, 1000);
}

module.exports = teleportTo;
