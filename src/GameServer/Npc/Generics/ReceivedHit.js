function receivedHit(session, actor, npc, hit, options = {}) {
    const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
    const SocialAggro = invoke('GameServer/Npc/SocialAggro');
    const MinionManager = invoke('GameServer/World/RaidBossMinionManager');
    const World = invoke('GameServer/World/World');

    BotSocialMemory.recordCombatHelp(session, npc, `hit ${npc.fetchName()} for ${hit}`);

    const attackerLevel = Number(actor?.fetchLevel?.());
    const actingPlayerLevel = Number(session?.actor?.fetchLevel?.());
    const levels = [attackerLevel, actingPlayerLevel]
        .filter((level) => Number.isFinite(level) && level > 0);
    const dropState = npc.model ?? npc;
    if (npc.fetchIsRaidBoss?.() === true) {
        if (!(dropState.raidAttackers instanceof Set)) dropState.raidAttackers = new Set();
        const actorId = Number(actor?.fetchId?.() || 0);
        const playerId = Number(session?.actor?.fetchId?.() || 0);
        if (actorId) dropState.raidAttackers.add(actorId);
        if (playerId) dropState.raidAttackers.add(playerId);
        if (actor?.model) actor.model.raidBossAttackTargetId = Number(npc.fetchId?.() || 0);
        if (session?.actor?.model) session.actor.model.raidBossAttackTargetId = Number(npc.fetchId?.() || 0);
    }
    if (levels.length > 0) {
        dropState.dropAttackerLevels ??= [];
        levels.forEach((level) => {
            if (!dropState.dropAttackerLevels.includes(level)) {
                dropState.dropAttackerLevels.push(level);
            }
        });
        // Lisvus starts with the killer's acting player, not the summon itself.
        dropState.dropLastAttackerLevel = actingPlayerLevel || attackerLevel;
    }

    if (options.wakeSleep !== false) {
        EffectRestrictions.wakeOnDamage(npc, session);
    }
    npc.setHp(Math.max(0, npc.fetchHp() - hit)); // HP bar would disappear if less than zero
    npc.broadcastVitals();

    if (npc.fetchHp() <= 0) {
        invoke(path.npc).die(session, actor, npc);
        return;
    }

    npc.automation.replenishVitals(npc);
    npc.enterCombatState(session, actor);
    if (npc.fetchIsRaidBoss?.() === true) {
        MinionManager.onBossAttacked(World, npc, actor, session);
    }
    SocialAggro.notifyClan(session, npc, actor);
}

module.exports = receivedHit;
