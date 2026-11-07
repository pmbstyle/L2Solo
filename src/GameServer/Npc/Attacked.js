'use strict';

// Hot reaction to an attack: hate plus leader/minion and clan assistance.
// ReceivedHit supplies damage; C4SkillEffects calls before the success roll.
const NpcHate = invoke('GameServer/Npc/NpcHate');

// A skill's HP hit still credits damage hate after its cast notified the group.
function attacked(session, actor, npc, damage = 0, alreadyNotified = false) {
    if (npc.state?.fetchDead?.() === true || npc.canEngageCombat?.() === false) return false;

    const dying = npc.fetchHp?.() <= 0;
    if (!dying) {
        if (typeof npc.addDamageHate === 'function') {
            npc.addDamageHate(session, actor, damage, NpcHate.fromDamage(damage) || NpcHate.ENGAGE_HATE);
        } else {
            npc.enterCombatState?.(session, actor);
        }
    }
    if (alreadyNotified) return true;

    // A lethal hit still calls a minion's living leader before death removes
    // the minion. A killed leader cannot call assistance of its own.
    if (!dying && (npc.fetchIsRaidBoss?.() === true || npc.minionState)) {
        invoke('GameServer/World/RaidBossMinionManager').onBossAttacked(invoke('GameServer/World/World'), npc, actor, session);
    } else if (npc.minionBossObjectId || npc.minionLeader) {
        invoke('GameServer/World/RaidBossMinionManager').onMinionAttacked(invoke('GameServer/World/World'), npc, actor, session);
    }
    if (!dying) invoke('GameServer/Npc/SocialAggro').notifyClan(session, npc, actor);
    return true;
}

module.exports = attacked;
