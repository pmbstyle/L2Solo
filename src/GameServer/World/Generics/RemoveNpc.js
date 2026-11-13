const SpoilSweep     = invoke('GameServer/Npc/SpoilSweep');
const SpawnNpcs      = invoke('GameServer/World/Generics/SpawnNpcs');
const NpcDecay        = invoke('GameServer/World/Generics/NpcDecay');
const RaidBossState   = invoke('GameServer/World/RaidBossState');
const FailureLog      = require('../../../FailureLog');
const { killEffect }  = require('../KillEffect');

function canRespawnDefinition(world, definition, periodRevision) {
    if (!SpawnNpcs.isPeriodic(definition?.spawn)) return true;
    return Number(world?.npc?.periodRevision || 0) === Number(periodRevision || 0)
        && SpawnNpcs.isPeriodActive(definition.spawn, world?.npc?.periodMode);
}

function removeNpc(session, npc) {
    let corpseDelay = 0;
    try {
        corpseDelay = SpoilSweep.corpseTime(npc);
    }
    catch (error) {
        FailureLog.note('npc.corpse_time', error); // the corpse decays at once
    }
    // Register decay before any reward or quest side effect can fail. The
    // corpse timer retries a failed removal itself (NpcDecay.expire).
    NpcDecay.schedule(this, session, npc, corpseDelay);

    SpawnNpcs.clearQuestSpawn(npc);

    // Datapack respawn is measured from the death event, independently of
    // the temporary corpse remaining visible in the world.
    const definition = npc.spawnDefinition;
    if (SpawnNpcs.shouldRespawn(definition?.spawn)) {
        const delayMs = SpawnNpcs.respawnDelayForDefinitionMs(definition);
        const periodRevision = Number(this.npc?.periodRevision || 0);
        if (SpawnNpcs.isRaidBossDefinition(definition)) {
            const respawnAt = Date.now() + delayMs;
            RaidBossState.markDefeated(npc, respawnAt);
            SpawnNpcs.scheduleRaidBossRespawn(this, definition, respawnAt, periodRevision);
        }
        else {
            setTimeout(() => {
                try {
                    if (!canRespawnDefinition(this, definition, periodRevision)) return;
                    this.spawnNpc(this, definition);
                }
                catch (error) {
                    FailureLog.note('npc.respawn', error); // this spawn does not return
                }
            }, delayMs);
        }
    }

    // The drops are a consequence of the kill (killEffect): a bad drop row is counted, the
    // corpse still decays (registered above) and the kill's other rewards still run.
    killEffect('kill.drops', () => this.npcRewards(session, npc));
}

module.exports = removeNpc;
module.exports.canRespawnDefinition = canRespawnDefinition;
