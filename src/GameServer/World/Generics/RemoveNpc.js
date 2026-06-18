const ServerResponse = invoke('GameServer/Network/Response');
const SpoilSweep     = invoke('GameServer/Npc/SpoilSweep');

function removeNpc(session, npc) {
    const npcId = npc.fetchId();
    this.npcRewards(session, npc);

    // Delete NPC from world
    setTimeout(() => {
        session.dataSendToMeAndOthers(ServerResponse.deleteOb(npcId), npc);
        this.npc.spawns = this.npc.spawns.filter(ob => ob.fetchId() !== npcId);
    }, SpoilSweep.corpseTime(npc));
}

module.exports = removeNpc;
