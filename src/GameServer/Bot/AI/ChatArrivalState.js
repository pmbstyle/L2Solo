const HOLD_DISTANCE = 450;
const DEFAULT_HOLD_MS = 60000;

function online(session) {
    return !!session?.actor?.fetchIsOnline?.();
}

function distance2d(first, second) {
    if (!first || !second) return Infinity;
    const dx = first.fetchLocX() - second.fetchLocX();
    const dy = first.fetchLocY() - second.fetchLocY();
    return Math.sqrt((dx * dx) + (dy * dy));
}

function clear(session, reason = 'cleared') {
    if (!session) return false;
    session.chatArrivalActive = false;
    session.chatArrivalTargetSession = null;
    session.chatArrivalUntil = 0;
    session.chatArrivalLastMoveAt = 0;
    session.chatArrivalReason = reason;
    return true;
}

function start(session, targetSession, options = {}) {
    if (!session?.actor || !online(targetSession)) return false;
    session.chatArrivalActive = true;
    session.chatArrivalTargetSession = targetSession;
    session.chatArrivalUntil = Date.now() + Math.max(10000, Number(options.holdMs || DEFAULT_HOLD_MS));
    session.chatArrivalLastMoveAt = 0;
    session.chatArrivalReason = options.reason || 'remote_chat_come';
    session.currentTargetId = undefined;
    session.targetTrackId = undefined;
    session.incomingThreatId = undefined;
    session.incomingThreatAt = undefined;
    session.lastTargetEvaluation = undefined;
    session.lastCombatDecision = undefined;
    session.actor.unselect?.();
    session.actor.automation?.abortAll?.(session.actor);
    return true;
}

function tick(session, bot) {
    if (!session?.chatArrivalActive) return false;
    const targetSession = session.chatArrivalTargetSession;
    const player = targetSession?.actor;
    if (!online(targetSession) || Date.now() >= Number(session.chatArrivalUntil || 0)) {
        clear(session, 'expired');
        return false;
    }
    if (!bot || bot.isDead?.()) return true;

    const distance = distance2d(bot, player);
    if (distance > HOLD_DISTANCE) {
        const now = Date.now();
        if (now - Number(session.chatArrivalLastMoveAt || 0) >= 1200) {
            session.chatArrivalLastMoveAt = now;
            bot.moveTo?.({
                from: {
                    locX: bot.fetchLocX(),
                    locY: bot.fetchLocY(),
                    locZ: bot.fetchLocZ()
                },
                to: {
                    locX: player.fetchLocX() + utils.oneFromSpan(-80, 80),
                    locY: player.fetchLocY() + utils.oneFromSpan(-80, 80),
                    locZ: player.fetchLocZ()
                }
            });
        }
        return true;
    }

    if (bot.state?.inMotion?.()) bot.automation?.abortAll?.(bot);
    bot.unselect?.();
    return true;
}

module.exports = {
    HOLD_DISTANCE,
    DEFAULT_HOLD_MS,
    start,
    tick,
    clear
};
