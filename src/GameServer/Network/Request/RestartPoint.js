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

    const hallRuntime = require('../../ClanHall/Runtime');
    const hallRestart = Number(data.location) === 1 ? hallRuntime.destination(actor) : null;
    if (Number(data.location) === 1 && !hallRestart) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    const ArenaDuelService = invoke('GameServer/World/ArenaDuelService');
    const arenaDeath = session.arenaDeath === true && ArenaDuelService.duelForActor?.(actor);
    const TownRespawn = invoke('GameServer/World/TownRespawn');
    const destination = arenaDeath
        ? invoke('GameServer/World/GiranArena').RESTART
        : hallRestart || TownRespawn.restartCoords(actor);
    const Generics = invoke(path.actor);

    // Restart is a complete respawn, unlike a gradual resurrection skill.
    // Make the actor alive before TeleportTo checks HP/dead state.
    Generics.revive(session, actor, {
        delayMs: 0,
        restoreFullVitals: true,
        restoreExpPercent: hallRestart && !arenaDeath ? hallRuntime.expRestore(actor) : null,
        recoveryReason: hallRestart && !arenaDeath ? 'restart_to_clan_hall' : 'restart_to_town'
    });
    session.dataSendToMe(ServerResponse.userInfo(actor));

    Generics.teleportTo(session, actor, destination);
    if (arenaDeath) ArenaDuelService.release(session, 'player_death');
}

module.exports = restartPoint;
module.exports.consume = consume;
