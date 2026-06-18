const ServerResponse = invoke('GameServer/Network/Response');

function die(session, actor, npc) {
    const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');

    npc.destructor(session);
    npc.state.setDead(true);
    session.dataSendToMeAndOthers(ServerResponse.die(npc.fetchId(), SpoilSweep.isSweepable(npc)), npc);
    invoke(path.actor).npcDied(session, actor, npc);
}

module.exports = die;
