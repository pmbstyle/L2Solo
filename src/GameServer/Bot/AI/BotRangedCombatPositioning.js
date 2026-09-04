const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotRetreatPlanner = invoke('GameServer/Bot/AI/BotRetreatPlanner');

const ARCHER_KITE_TRIGGER_DISTANCE = 450;
const ARCHER_KITE_RETREAT_DISTANCE = 500;
const ARCHER_KITE_COOLDOWN_MS = 3500;
const ARCHER_KITE_FAILURE_RETRY_MS = 3500;

function distance2d(first, second) {
    const dx = Number(first?.fetchLocX?.() || 0) - Number(second?.fetchLocX?.() || 0);
    const dy = Number(first?.fetchLocY?.() || 0) - Number(second?.fetchLocY?.() || 0);
    return Math.sqrt((dx * dx) + (dy * dy));
}

function isAutonomousArcher(session, bot, target, role = BotRoles.inferRole(bot)) {
    return role === 'archer' &&
        session?.partyCompanion !== true &&
        !session?.followPlayerSession &&
        target?.fetchAttackable?.() === true &&
        target?.isDead?.() !== true;
}

function record(session, target, action, reason, distance, extra = {}) {
    session.lastCombatDecision = {
        action,
        role: 'archer',
        reason,
        targetId: target.fetchId(),
        distance: Math.round(distance),
        ...extra,
        at: Date.now()
    };
}

function reposition(session, bot, target, options = {}) {
    const role = options.role || BotRoles.inferRole(bot);
    if (!isAutonomousArcher(session, bot, target, role)) return false;

    const distance = distance2d(bot, target);
    if (distance > ARCHER_KITE_TRIGGER_DISTANCE) return false;

    if (bot.state?.fetchTowards?.() || bot.state?.fetchCasts?.()) {
        record(session, target, 'hold_range', 'kite_in_progress', distance);
        return true;
    }

    const targetId = Number(target.fetchId());
    const failedKiteAt = Number(session.archerKiteFailureAt || 0);
    if (session.archerKiteFailureTargetId === targetId &&
        Date.now() - failedKiteAt < ARCHER_KITE_FAILURE_RETRY_MS) {
        // A failed route must not be retried by the duplicate positioning
        // guard in HuntingState and then suppress the actual combat action.
        record(session, target, 'kite_failed', 'retreat_unusable', distance, {
            routeUsable: false,
            retryAt: failedKiteAt + ARCHER_KITE_FAILURE_RETRY_MS
        });
        return false;
    }

    const now = Date.now();
    if (now < Number(session.nextArcherKiteAt || 0)) {
        // The target is still too close. Waiting is intentional: the final
        // combat boundary must not spend another offensive skill in melee
        // merely because the movement cooldown has not elapsed yet.
        record(session, target, 'hold_range', 'kite_cooldown', distance, {
            retryAt: session.nextArcherKiteAt
        });
        return true;
    }

    session.nextArcherKiteAt = now + ARCHER_KITE_COOLDOWN_MS;
    const retreat = BotRetreatPlanner.retreat(session, bot, target, {
        distance: ARCHER_KITE_RETREAT_DISTANCE,
        requireSafe: true
    });
    if (retreat?.safe !== true) {
        session.archerKiteFailureTargetId = targetId;
        session.archerKiteFailureAt = now;
        session.nextArcherKiteAt = undefined;
        record(session, target, 'kite_failed', retreat?.routeUsable === true
            ? 'retreat_unsafe'
            : 'retreat_unusable', distance, {
            retreatDistance: ARCHER_KITE_RETREAT_DISTANCE,
            routeSafe: retreat?.safe === true,
            routeUsable: retreat?.routeUsable === true,
            retryAt: now + ARCHER_KITE_FAILURE_RETRY_MS
        });
        return false;
    }
    session.archerKiteFailureTargetId = undefined;
    session.archerKiteFailureAt = undefined;
    record(session, target, 'kite', 'target_too_close', distance, {
        retreatDistance: ARCHER_KITE_RETREAT_DISTANCE,
        routeSafe: retreat.safe,
        routeUsable: retreat.routeUsable
    });
    return true;
}

module.exports = {
    ARCHER_KITE_TRIGGER_DISTANCE,
    ARCHER_KITE_RETREAT_DISTANCE,
    ARCHER_KITE_COOLDOWN_MS,
    ARCHER_KITE_FAILURE_RETRY_MS,
    distance2d,
    isAutonomousArcher,
    reposition
};
