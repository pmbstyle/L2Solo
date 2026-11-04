const ServerResponse = invoke('GameServer/Network/Response');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');

function finishRevive(session, actor, helper) {
    const wasDead = actor.state.fetchDead?.() === true;
    actor.state.setDead(false);
    actor.statusUpdateVitals?.(actor);
    if (helper && wasDead) invoke('GameServer/Social/CombatHelpMemory').record(helper, actor, { resurrected: true });
    actor.refreshVitalsRegeneration?.();
    // BotAI uses this marker to run the one-time death lifecycle.  A native
    // in-place resurrection must release it so a later death is counted and
    // announced instead of looking like the same corpse forever.
    session.deathTimerStart = undefined;
    session.partyReviveCombatPauseStartedAt = undefined;
    session.partyReviveCombatPausedMs = undefined;
    // Only an actual in-place resurrection rejoins an ongoing raid. Town
    // recovery has no helper and must leave that participant out of combat.
    if (helper && wasDead) {
        if (session.partyCompanion && session.followPlayerSession?.partyRaidEngagement?.phase === 'combat') {
            session.playerRaidResurrectionRecovery = true;
        }
        if (session.hotRaidCasualtyAt) session.hotRaidResurrectionRecovery = true;
        session.hotRaidCasualtyAt = undefined;
        session.hotRaidCasualtyRole = undefined;
    }
    if (session?.accountId?.startsWith?.('bot_') && session.arenaEphemeral !== true) {
        // Every revival passes here (own restart, skill, scroll, companion), alive by now.
        BotLifeState.notifyNearFacts(session, 'revive');
        invoke('GameServer/Bot/AI/BotEventJournal').record({
            botId: actor.fetchId(),
            eventType: 'revive',
            summary: `${actor.fetchName?.() || 'Bot'} revived and is recovering.`,
            weight: 4,
            dedupeKey: `revive:${actor.fetchId()}`,
            coalesceWindowMs: 5000
        });
    }
}

function revive(session, actor, {
    delayMs = 2500,
    helper = null,
    restoreExpPercent = null,
    recoveryReason = 'non_resurrection_recovery'
} = {}) {
    const DeathExperience = invoke('GameServer/Progression/DeathExperience');
    const experience = restoreExpPercent === null
        ? { persistence: DeathExperience.clearPendingRestoration(actor, recoveryReason) }
        : DeathExperience.restoreFromResurrection(session, actor, { restoreExpPercent });
    actor.setHp(invoke('GameServer/Formulas').respawnHp(actor.fetchMaxHp()));
    actor.automation.replenishVitals(actor);

    if (delayMs <= 0) {
        finishRevive(session, actor, helper);
        session.dataSendToMeAndOthers(ServerResponse.revive(actor.fetchId()), actor);
        session.dataSendToMeAndOthers(ServerResponse.socialAction(actor.fetchId(), 9), actor);
        return experience;
    }

    session.dataSendToMeAndOthers(ServerResponse.revive(actor.fetchId()), actor);

    setTimeout(() => {
        finishRevive(session, actor, helper);
        session.dataSendToMeAndOthers(ServerResponse.socialAction(actor.fetchId(), 9), actor); // SWAG stand-up
    }, delayMs);
    return experience;
}

module.exports = revive;
