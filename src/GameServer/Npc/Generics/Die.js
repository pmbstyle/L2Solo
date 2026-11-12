const ServerResponse = invoke('GameServer/Network/Response');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const FailureLog = require('../../../FailureLog');

function clearEffectsOnDeath(npc) {
    EffectTicker.clearAll(npc);
    npc.effects = {};
    npc.activeBuffs = {};
    EffectStore.prune(npc);
}

// One consequence of an NPC's death: a reward, a quest callback, a raid's minions, a guardian
// spawn. The death itself (dead state, effects cleared, the corpse's decay and respawn) is not one.
// A consequence that throws is counted under its site (`kill.<what>`: FailureLog logs its first
// stack and writes a trace failure record) and the others still run; the kill comes from a hit
// timer, where a throw would exit the server. C4 (Lisvus L2Attackable.doDie, calculateRewards): a
// failed reward or quest notification is logged and the death goes on.
function killEffect(site, effect) {
    try { effect(); } catch (error) { FailureLog.note(site, error); }
}

function die(session, actor, npc) {
    if (npc.state?.fetchDead?.()) return;
    // Defense in depth for the immortality rule in Model/Npc: no other code
    // path may turn a town NPC that stays alive at 1 HP into a corpse.
    if (npc.fetchIsKillable?.() === false) return;
    const SpoilSweep = invoke('GameServer/Npc/SpoilSweep');
    const RaidBossMinionManager = invoke('GameServer/World/RaidBossMinionManager');

    npc.soulCrystalReward = invoke('GameServer/Items/SoulCrystalProgression').onDeath(session, actor, npc)
        .catch(error => FailureLog.note('kill.soul_crystal', error));
    npc.destructor(session);
    if (npc.fetchIsRaidBoss?.() === true) {
        killEffect('kill.raid_boss', () => RaidBossMinionManager.onBossDeath(invoke('GameServer/World/World'), npc, session));
    }
    npc.state.setDead(true);
    if (npc.fetchIsSummon?.() === true) {
        killEffect('kill.summon_credit', () => invoke('GameServer/Actor/Generics/ReceivedHit').creditKill(session, actor, npc));
    }
    killEffect('kill.party_casts', () => invoke('GameServer/Bot/AI/HotPartyCastTracker').cancelForDeadNpc(npc));
    clearEffectsOnDeath(npc);
    killEffect('kill.fairy_tree', () => invoke('GameServer/Pets/FairyTrees').onDeath(session, actor, npc));
    session.dataSendToMeAndOthers(ServerResponse.die(npc.fetchId(), SpoilSweep.isSweepable(npc)), npc);
    invoke(path.actor).npcDied(session, actor, npc);
}

module.exports = die;
module.exports.clearEffectsOnDeath = clearEffectsOnDeath;
module.exports.killEffect = killEffect;
