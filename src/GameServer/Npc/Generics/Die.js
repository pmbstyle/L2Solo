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
    if (npc.state?.fetchDead?.()) return;
    // Defense in depth for the immortality rule in Model/Npc: no other code
    // path may turn a town NPC that stays alive at 1 HP into a corpse.
    if (npc.fetchIsKillable?.() === false) return;
    const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
    const RaidBossMinionManager = invoke('GameServer/World/RaidBossMinionManager');

    npc.soulCrystalReward = invoke('GameServer/Items/SoulCrystalProgression').onDeath(session, actor, npc)
        .catch(error => utils.infoWarn('SoulCrystal', 'reward failed: %s', error.message));
    npc.destructor(session);
    if (npc.fetchIsRaidBoss?.() === true) {
        RaidBossMinionManager.onBossDeath(invoke('GameServer/World/World'), npc, session);
    }
    npc.state.setDead(true);
    if (npc.fetchIsSummon?.() === true) invoke('GameServer/Actor/Generics/ReceivedHit').creditKill(session, actor, npc);
    invoke('GameServer/Bot/AI/HotPartyCastTracker').cancelForDeadNpc(npc);
    clearEffectsOnDeath(npc);
    invoke('GameServer/Pets/FairyTrees').onDeath(session, actor, npc);
    session.dataSendToMeAndOthers(ServerResponse.die(npc.fetchId(), SpoilSweep.isSweepable(npc)), npc);
    invoke(path.actor).npcDied(session, actor, npc);
}

module.exports = die;
module.exports.clearEffectsOnDeath = clearEffectsOnDeath;
