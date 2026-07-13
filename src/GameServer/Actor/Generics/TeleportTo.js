const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');

function teleportTo(session, actor, coords) {
    const Generics = invoke(path.actor);

    if (actor.isDead()) {
        return;
    }

    // NOTE: Do NOT override coords.locZ with GeodataEngine.getHeight() here.
    // Teleport destinations (from teleports.json, spawn coords, etc.) already have
    // correct Z values taken from authentic L2J server data. Overriding with geodata
    // produces wrong Z (e.g. underground layer, water level) causing the actor to
    // fall through terrain. Geodata Z-correction is only appropriate during movement.

    actor.clearDestId();
    actor.automation.abortAll(actor);
    session.dataSendToMeAndOthers(ServerResponse.teleportToLocation(actor.fetchId(), coords), actor);

    // Turns out to be a viable solution
    setTimeout(() => {
        Generics.updatePosition(session, actor, coords, { immediateNpcInfo: true, forceRefresh: true });

        // Wake up bot AI after teleportation is complete and position updated
        if (session.aiActive) {
            const BotAI = invoke('GameServer/Bot/BotAI');
            BotAI.wakeup(session);
        }
    }, 1000);
}

module.exports = teleportTo;
