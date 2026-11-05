// An NPC's HP/MP bar update for the real players within 3500 of it (our band;
// C4 informs the players targeting it). Bot sessions drop every packet, so only
// the real players who see the NPC are asked (the index's player cells), and
// they all get one packet.
const VITALS_RADIUS_SQUARED = 3500 * 3500;

function broadcastVitals(npc) {
    const World = invoke('GameServer/World/World');
    const x = Number(npc.fetchLocX()), y = Number(npc.fetchLocY());
    let packet = null;
    for (const session of World.fetchVisibleRealPlayers(null, npc)) {
        const dx = Number(session.actor.fetchLocX()) - x, dy = Number(session.actor.fetchLocY()) - y;
        if (dx * dx + dy * dy >= VITALS_RADIUS_SQUARED) continue;
        session.dataSendToMe(packet ||= invoke('GameServer/Actor/Actor').vitalsPacket(npc));
    }

    if (npc.fetchIsSummon?.() === true) {
        const ownerSession = World.user.sessions.find((session) => Number(session.actor?.fetchId?.()) === Number(npc.fetchOwnerId?.()));
        ownerSession?.dataSendToMe?.(invoke('GameServer/Network/Response').petStatusUpdate(npc));
    }
}

module.exports = broadcastVitals;
