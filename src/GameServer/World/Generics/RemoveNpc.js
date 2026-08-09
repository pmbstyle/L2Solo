const SpoilSweep     = invoke('GameServer/Npc/SpoilSweep');
const SpawnNpcs      = invoke('GameServer/World/Generics/SpawnNpcs');
const NpcDecay        = invoke('GameServer/World/Generics/NpcDecay');

function canRespawnDefinition(world, definition, periodRevision) {
    if (!SpawnNpcs.isPeriodic(definition?.spawn)) return true;
    return Number(world?.npc?.periodRevision || 0) === Number(periodRevision || 0)
        && SpawnNpcs.isPeriodActive(definition.spawn, world?.npc?.periodMode);
}

function removeNpc(session, npc) {
    const npcId = npc.fetchId();

    let corpseDelay = 0;
    try {
        corpseDelay = SpoilSweep.corpseTime(npc);
    }
    catch (error) {
        utils.infoWarn('NpcDecay', 'failed to calculate corpse time for NPC %d: %s', npcId, error.message);
    }
    // Register decay before any reward or quest side effect can fail. The
    // reaper is a durable fallback for the one-shot timer below.
    NpcDecay.schedule(this, session, npc, corpseDelay);

    SpawnNpcs.clearQuestSpawn(npc);

    // Datapack respawn is measured from the death event, independently of
    // the temporary corpse remaining visible in the world.
    const definition = npc.spawnDefinition;
    if (SpawnNpcs.shouldRespawn(definition?.spawn)) {
        const delayMs = SpawnNpcs.respawnDelayMs(definition.spawn);
        const periodRevision = Number(this.npc?.periodRevision || 0);
        setTimeout(() => {
            try {
                if (!canRespawnDefinition(this, definition, periodRevision)) return;
                this.spawnNpc(this, definition);
                this.indexSpawnsInGrid();
            }
            catch (error) {
                utils.infoWarn('Spawn', 'failed to respawn NPC %d: %s', npcId, error.message);
            }
        }, delayMs);
    }

    try {
        this.npcRewards(session, npc);
    }
    catch (error) {
        // Rewards are auxiliary to corpse cleanup. A bad drop row or a
        // disconnected recipient must not strand the dead NPC forever.
        utils.infoWarn('NpcRewards', 'failed for NPC %d: %s', npcId, error.message);
    }
}

module.exports = removeNpc;
module.exports.canRespawnDefinition = canRespawnDefinition;
