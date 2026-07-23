const SpoilSweep     = invoke('GameServer/Npc/SpoilSweep');
const SpawnNpcs      = invoke('GameServer/World/Generics/SpawnNpcs');
const NpcVisibility  = invoke('GameServer/World/NpcVisibility');

function removeNpc(session, npc) {
    const npcId = npc.fetchId();
    SpawnNpcs.clearQuestSpawn(npc);
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
        NpcVisibility.deleteKnownNpc(this, session, npcId);
        this.npc.spawns = this.npc.spawns.filter(ob => ob.fetchId() !== npcId);
        this.indexSpawnsInGrid();
    }, SpoilSweep.corpseTime(npc));
}

module.exports = removeNpc;
