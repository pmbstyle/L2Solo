const SpeckMath = invoke('GameServer/SpeckMath');

function broadcastVitals(npc) {
    const World = invoke('GameServer/World/World');
    const actors = World.user.sessions.filter((ob) => {
        const actor = ob.actor;
        if (!actor?.fetchLocX || !actor?.statusUpdateVitals) return false;
        if (actor.fetchIsOnline && actor.fetchIsOnline() !== true) return false;
        return new SpeckMath.Circle(npc.fetchLocX(), npc.fetchLocY(), 3500).contains(new SpeckMath.Point(actor.fetchLocX(), actor.fetchLocY()));
    }) ?? [];

    actors.forEach((session) => {
        session.actor.statusUpdateVitals(npc);
    });

    if (npc.fetchIsSummon?.() === true) {
        const ownerSession = World.user.sessions.find((session) => Number(session.actor?.fetchId?.()) === Number(npc.fetchOwnerId?.()));
        ownerSession?.dataSendToMe?.(invoke('GameServer/Network/Response').petStatusUpdate(npc));
    }
}

module.exports = broadcastVitals;
