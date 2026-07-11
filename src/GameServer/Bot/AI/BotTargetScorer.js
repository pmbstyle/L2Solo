const MAX_LEVEL_ADVANTAGE = 8;
const MAX_VERTICAL_GAP = 1200;

function number(value, fallback = 0) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}

function score(context = {}) {
    const botLevel = Math.max(1, number(context.botLevel, 1));
    const npcLevel = Math.max(1, number(context.npcLevel, botLevel));
    const levelGap = npcLevel - botLevel;
    const distance = Math.max(0, number(context.distance));
    const verticalGap = Math.max(0, number(context.verticalGap));
    const reasons = [];

    if (context.dead || !context.attackable) {
        return { eligible: false, score: -Infinity, reason: 'not_attackable', reasons: ['not_attackable'] };
    }
    if (context.retryCooldown) {
        return { eligible: false, score: -Infinity, reason: 'retry_cooldown', reasons: ['retry_cooldown'] };
    }
    if (!context.incomingThreat && levelGap > MAX_LEVEL_ADVANTAGE) {
        return { eligible: false, score: -Infinity, reason: 'level_too_high', reasons: ['level_too_high'] };
    }
    if (verticalGap > MAX_VERTICAL_GAP) {
        return { eligible: false, score: -Infinity, reason: 'vertical_gap', reasons: ['vertical_gap'] };
    }

    let value = 1000;
    value -= distance / 10;
    reasons.push(`distance:${Math.round(distance)}`);

    value -= Math.abs(levelGap) * 55;
    if (levelGap > 3) {
        value -= (levelGap - 3) * 110;
        reasons.push(`dangerous_level:+${levelGap}`);
    } else if (levelGap < -7) {
        value -= (Math.abs(levelGap) - 7) * 35;
        reasons.push(`trivial_level:${levelGap}`);
    } else {
        reasons.push(`level_gap:${levelGap}`);
    }

    value -= verticalGap / 4;
    if (verticalGap > 250) reasons.push(`vertical:${Math.round(verticalGap)}`);

    if (context.currentSpotId && context.npcSpotId) {
        if (context.currentSpotId === context.npcSpotId) {
            value += 180;
            reasons.push('same_spot');
        } else {
            value -= 140;
            reasons.push('outside_spot');
        }
    }

    if (context.claimed) {
        value -= 450;
        reasons.push('claimed');
    }

    const socialAllies = Math.max(0, number(context.socialAllies));
    if (socialAllies > 0) {
        value -= Math.min(4, socialAllies) * 75;
        reasons.push(`social_allies:${socialAllies}`);
    }

    if (context.incomingThreat) {
        value += 1000;
        reasons.push('incoming_threat');
    }

    return {
        eligible: true,
        score: Math.round(value),
        reason: reasons[0] || 'eligible',
        reasons,
        levelGap,
        distance: Math.round(distance),
        verticalGap: Math.round(verticalGap)
    };
}

function rank(candidates) {
    return (candidates || [])
        .filter((candidate) => candidate?.evaluation?.eligible)
        .sort((a, b) => b.evaluation.score - a.evaluation.score);
}

module.exports = {
    MAX_LEVEL_ADVANTAGE,
    MAX_VERTICAL_GAP,
    rank,
    score
};
