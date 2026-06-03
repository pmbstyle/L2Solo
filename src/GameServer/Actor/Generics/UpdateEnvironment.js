const ServerResponse = invoke('GameServer/Network/Response');
const World          = invoke('GameServer/World/World');
const SpeckMath      = invoke('GameServer/SpeckMath');

function updateEnvironment(session, actor) {
    const actorArea = new SpeckMath.Circle(actor.fetchLocX(), actor.fetchLocY(), 5000);
    const npcs = World.fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), 5000).filter((ob) => ob.state.fetchDead() === false) ?? [];

    if (new SpeckMath.Point(actor.previousXY?.locX ?? 0, actor.previousXY?.locY ?? 0).distance(new SpeckMath.Point(actor.fetchLocX(), actor.fetchLocY())) >= 1000) {
        npcs.forEach((npc) => { // Gives a sense of random NPC Animation to the actor
            setTimeout( () => { session.dataSendToMe(ServerResponse.npcInfo(npc)); }, utils.randomNumber(2000));
        });

        World.fetchVisibleUsers(session, actor).forEach((user) => {
            session.dataSendToMe(ServerResponse.charInfo(user.actor));
            user.dataSendToMe(ServerResponse.charInfo(actor));
        });

        actor.previousXY = actorArea.toCoords();
    }

    // Detect hostile NPCs
    const hostile = npcs.filter((ob) => ob.fetchHostile() && actorArea.distance(new SpeckMath.Point(ob.fetchLocX(), ob.fetchLocY())) <= 500) ?? [];
    hostile.forEach((npc) => {
        npc.setLocZ(actor.fetchLocZ()); // TODO: Remove, uber hack...
        npc.enterCombatState(session, actor);
    });
}

module.exports = updateEnvironment;
