const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');

const COMPANION_RESPAWN_OFFSETS = [
    { locX: 80, locY: 0 },
    { locX: -80, locY: 0 },
    { locX: 0, locY: 80 },
    { locX: 0, locY: -80 },
    { locX: 60, locY: 60 },
    { locX: -60, locY: -60 }
];

function reviveDeadCompanions(leaderSession, townRespawn, Generics, botManager = invoke('GameServer/Bot/BotManager')) {
    const companions = (botManager.sessions || []).filter((companionSession) => (
        companionSession?.partyCompanion === true &&
        companionSession.followPlayerSession === leaderSession &&
        companionSession.actor?.isDead?.() === true
    ));

    companions.forEach((companionSession, index) => {
        const companion = companionSession.actor;
        const offset = COMPANION_RESPAWN_OFFSETS[index % COMPANION_RESPAWN_OFFSETS.length];

        // A leader's explicit town restart ends the field rescue attempt. Keep
        // the party intact, but revive every fallen companion before moving it
        // to the same town so none remains a corpse on the old hunting spot.
        Generics.revive(companionSession, companion, { delayMs: 0, restoreFullVitals: true });
        companionSession.deathTimerStart = undefined;
        companionSession.currentTargetId = undefined;
        companionSession.incomingThreatId = undefined;
        companionSession.incomingThreatAt = undefined;
        companionSession.plan = 'following';
        companion.unselect?.();
        Generics.teleportTo(companionSession, companion, {
            locX: townRespawn.locX + offset.locX,
            locY: townRespawn.locY + offset.locY,
            locZ: townRespawn.locZ
        });
    });

    return companions.length;
}

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
    const townRespawn = actor.fetchKarma?.() > 0
        ? TownRespawn.getChaoticRespawnCoords(actor.fetchLocX(), actor.fetchLocY())
        : TownRespawn.getRespawnCoords(actor.fetchLocX(), actor.fetchLocY());
    const Generics = invoke(path.actor);

    // Town restart is a complete respawn, unlike a gradual resurrection skill.
    // Make the actor alive before TeleportTo checks HP/dead state.
    Generics.revive(session, actor, { delayMs: 0, restoreFullVitals: true });
    session.dataSendToMe(ServerResponse.userInfo(actor));

    Generics.teleportTo(session, actor, townRespawn);
    reviveDeadCompanions(session, townRespawn, Generics);
}

module.exports = restartPoint;
module.exports.consume = consume;
module.exports.reviveDeadCompanions = reviveDeadCompanions;
