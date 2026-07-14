const ServerResponse = invoke('GameServer/Network/Response');
const SpoilSweep     = invoke('GameServer/Npc/SpoilSweep');
const SpawnNpcs      = invoke('GameServer/World/Generics/SpawnNpcs');

function removeNpc(session, npc) {
    const npcId = npc.fetchId();
    this.npcRewards(session, npc);

    // Datapack respawn is measured from the death event, independently of
    // the temporary corpse remaining visible in the world.
    const definition = npc.spawnDefinition;
    if (SpawnNpcs.shouldRespawn(definition?.spawn)) {
        const delayMs = SpawnNpcs.respawnDelayMs(definition.spawn);
        setTimeout(() => {
            this.spawnNpc(this, definition);
            this.indexSpawnsInGrid();
        }, delayMs);
    }

    // Delete NPC from world
    setTimeout(() => {
        session.dataSendToMeAndOthers(ServerResponse.deleteOb(npcId), npc);
        this.npc.spawns = this.npc.spawns.filter(ob => ob.fetchId() !== npcId);
        this.indexSpawnsInGrid();
    }, SpoilSweep.corpseTime(npc));
}

module.exports = removeNpc;
