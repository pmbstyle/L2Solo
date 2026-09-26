const ServerResponse = invoke('GameServer/Network/Response');

function finishRevive(session, actor, helper) {
    const wasDead = actor.state.fetchDead?.() === true;
    if (actor.fetchHp && !(actor.fetchHp() > 0)) actor.setHp(1);
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
        if (session.hotRaidCasualtyAt) session.hotRaidResurrectionRecovery = true;
        session.hotRaidCasualtyAt = undefined;
        session.hotRaidCasualtyRole = undefined;
    }
    if (session?.accountId?.startsWith?.('bot_') && session.arenaEphemeral !== true) {
        Promise.resolve(invoke('GameServer/Bot/AI/BotEventJournal').record({
            botId: actor.fetchId(),
            eventType: 'revive',
            summary: `${actor.fetchName?.() || 'Bot'} revived and is recovering.`,
            weight: 4,
            dedupeKey: `revive:${actor.fetchId()}`,
            coalesceWindowMs: 5000
        })).catch(() => {});
    }
}

function revive(session, actor, {
    delayMs = 2500,
    restoreFullVitals = false,
    helper = null,
    restoreExpPercent = null,
    recoveryReason = 'non_resurrection_recovery'
} = {}) {
    const DeathExperience = invoke('GameServer/Progression/DeathExperience');
    const experience = restoreExpPercent === null
        ? { persistence: DeathExperience.clearPendingRestoration(actor, recoveryReason) }
        : DeathExperience.restoreFromResurrection(session, actor, { restoreExpPercent });
    if (restoreFullVitals) {
        actor.automation.stopReplenish();
        actor.fillupVitals();
    } else {
        actor.automation.replenishVitals(actor);
    }

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
