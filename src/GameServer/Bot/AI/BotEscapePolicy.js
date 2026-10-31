const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const DangerRule = invoke('GameServer/Bot/AI/DangerRule');

const CHASE_BREAK_DISTANCE = DangerRule.CHASE_BREAK_DISTANCE;

function movementSpeed(actor) {
    const walking = actor.state?.fetchWalkin?.() === true;
    const value = walking
        ? actor.fetchCollectiveWalkSpd?.() ?? actor.fetchWalkSpd?.()
        : actor.fetchCollectiveRunSpd?.() ?? actor.fetchRunSpd?.();
    const speed = value === null || value === undefined ? NaN : Number(value);
    return Number.isFinite(speed) && speed >= 0 ? speed : null;
}

function threatsFor(bot, target, near = null) {
    const others = PartyAwareness.npcsAttackingActor(bot, CHASE_BREAK_DISTANCE, near);
    return target ? [target, ...others.filter(npc => npc.fetchId() !== target.fetchId())] : others;
}

function assess(session, bot, threats) {
    const botSpeed = movementSpeed(bot);
    for (const threat of threats) {
        if (threat.isDead?.() || threat.state?.fetchDead?.()) continue;
        const threatSpeed = movementSpeed(threat);
        if (botSpeed !== null && threatSpeed !== null && !DangerRule.outruns(botSpeed, threatSpeed)) {
            return { possible: false, reason: 'pursuer_too_fast', threat, botSpeed, threatSpeed };
        }
        const failed = session.retreatFailure;
        if (Number(failed?.threatId) !== Number(threat.fetchId())) continue;
        // A failed route is remembered for this pursuit, not for an unrelated
        // future encounter. New speed buffs/slows also justify another try.
        const stillChasing = Number(threat.fetchDestId?.()) === Number(bot.fetchId());
        const improved = (botSpeed !== null && failed.botSpeed !== null && botSpeed > failed.botSpeed)
            || (threatSpeed !== null && failed.threatSpeed !== null && threatSpeed < failed.threatSpeed);
        if (stillChasing && !improved) {
            return { possible: false, reason: failed.reason, threat, botSpeed, threatSpeed };
        }
        session.retreatFailure = undefined;
    }
    return { possible: true };
}

function canRetreatFrom(session, bot, target, near = null) {
    return assess(session, bot, threatsFor(bot, target, near)).possible;
}

function rememberFailure(session, bot, threat, reason) {
    session.retreatFailure = { threatId: threat.fetchId(), reason,
        botSpeed: movementSpeed(bot), threatSpeed: movementSpeed(threat) };
}

module.exports = { CHASE_BREAK_DISTANCE, movementSpeed, threatsFor, assess, canRetreatFrom, rememberFailure };
