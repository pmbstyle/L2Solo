const SpeckMath = invoke('GameServer/SpeckMath');

function broadcastVitals(npc) {
    const actors = invoke('GameServer/World/World').user.sessions.filter((ob) => {
        const actor = ob.actor;
        if (!actor?.fetchLocX || !actor?.statusUpdateVitals) return false;
        if (actor.fetchIsOnline && actor.fetchIsOnline() !== true) return false;
        return new SpeckMath.Circle(npc.fetchLocX(), npc.fetchLocY(), 3500).contains(new SpeckMath.Point(actor.fetchLocX(), actor.fetchLocY()));
    }) ?? [];

    actors.forEach((session) => {
        session.actor.statusUpdateVitals(npc);
    });
}

module.exports = broadcastVitals;
