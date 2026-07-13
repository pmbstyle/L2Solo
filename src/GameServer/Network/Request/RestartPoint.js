const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');

function restartPoint(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD(); // Restart point

    consume(session, {
        location: packet.data[0]
    });
}

function consume(session, data) {
    const actor = session.actor;
    if (!actor || !actor.state?.fetchDead?.() || !actor.isDead()) {
        return;
    }

    const TownRespawn = invoke('GameServer/World/TownRespawn');
    const townRespawn = TownRespawn.getRespawnCoords(actor.fetchLocX(), actor.fetchLocY());
    const Generics = invoke(path.actor);

    // Town restart is a complete respawn, unlike a gradual resurrection skill.
    // Make the actor alive before TeleportTo checks HP/dead state.
    Generics.revive(session, actor, { delayMs: 0, restoreFullVitals: true });
    session.dataSendToMe(ServerResponse.userInfo(actor));

    Generics.teleportTo(session, actor, townRespawn);
}

module.exports = restartPoint;
module.exports.consume = consume;
