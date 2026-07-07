function receivedHit(session, actor, npc, hit) {
    const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
    const SocialAggro = invoke('GameServer/Npc/SocialAggro');

    BotSocialMemory.recordCombatHelp(session, npc, `hit ${npc.fetchName()} for ${hit}`);

    EffectRestrictions.wakeOnDamage(npc);
    npc.setHp(Math.max(0, npc.fetchHp() - hit)); // HP bar would disappear if less than zero
    npc.broadcastVitals();

    if (npc.fetchHp() <= 0) {
        invoke(path.npc).die(session, actor, npc);
        return;
    }

    npc.automation.replenishVitals(npc);
    npc.enterCombatState(session, actor);
    SocialAggro.notifyClan(session, npc, actor);
}

module.exports = receivedHit;
