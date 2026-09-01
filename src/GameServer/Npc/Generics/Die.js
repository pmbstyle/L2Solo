const ServerResponse = invoke('GameServer/Network/Response');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');

function clearEffectsOnDeath(npc) {
    EffectTicker.clearAll(npc);
    npc.effects = {};
    npc.activeBuffs = {};
    EffectStore.prune(npc);
}

function die(session, actor, npc) {
    const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
    const RaidBossMinionManager = invoke('GameServer/World/RaidBossMinionManager');

    npc.destructor(session);
    if (npc.fetchIsRaidBoss?.() === true) {
        RaidBossMinionManager.onBossDeath(invoke('GameServer/World/World'), npc, session);
    }
    npc.state.setDead(true);
    invoke('GameServer/Bot/AI/HotPartyCastTracker').cancelForDeadNpc(npc);
    clearEffectsOnDeath(npc);
    session.dataSendToMeAndOthers(ServerResponse.die(npc.fetchId(), SpoilSweep.isSweepable(npc)), npc);
    invoke(path.actor).npcDied(session, actor, npc);
}

module.exports = die;
module.exports.clearEffectsOnDeath = clearEffectsOnDeath;
