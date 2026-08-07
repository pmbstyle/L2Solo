const ServerResponse = invoke('GameServer/Network/Response');

function finishRevive(session, actor) {
    actor.state.setDead(false);
    // BotAI uses this marker to run the one-time death lifecycle.  A native
    // in-place resurrection must release it so a later death is counted and
    // announced instead of looking like the same corpse forever.
    session.deathTimerStart = undefined;
    session.partyReviveCombatPauseStartedAt = undefined;
    session.partyReviveCombatPausedMs = undefined;
    if (session?.accountId?.startsWith?.('bot_')) {
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

function revive(session, actor, { delayMs = 2500, restoreFullVitals = false } = {}) {
    if (restoreFullVitals) {
        actor.automation.stopReplenish();
        actor.fillupVitals();
    } else {
        actor.automation.replenishVitals(actor);
    }

    if (delayMs <= 0) {
        finishRevive(session, actor);
        session.dataSendToMeAndOthers(ServerResponse.revive(actor.fetchId()), actor);
        session.dataSendToMeAndOthers(ServerResponse.socialAction(actor.fetchId(), 9), actor);
        return;
    }

    session.dataSendToMeAndOthers(ServerResponse.revive(actor.fetchId()), actor);

    setTimeout(() => {
        finishRevive(session, actor);
        session.dataSendToMeAndOthers(ServerResponse.socialAction(actor.fetchId(), 9), actor); // SWAG stand-up
    }, delayMs);
}

module.exports = revive;
