// Defaults from the project's C4/L2J reference configuration.
const MIN_KARMA = 240;
const MAX_KARMA = 10000;
const XP_DIVIDER = 260;
const MIN_KARMA_LOST = 0;

function pkKillKarma(actor, victim) {
    const pkCountMultiplier = Math.max(1, Math.floor((Number(actor.fetchPk?.()) || 0) / 2));
    const actorLevel = Math.max(1, Number(actor.fetchLevel?.()) || 1);
    const victimLevel = Math.max(1, Number(victim.fetchLevel?.()) || 1);
    const levelMultiplier = Math.max(1, Math.floor(actorLevel / victimLevel));
    return Math.min(MAX_KARMA, MIN_KARMA * pkCountMultiplier * levelMultiplier);
}

function karmaLostForExperience(actor, exp) {
    const current = Math.max(0, Number(actor.fetchKarma?.()) || 0);
    if (!current) return 0;
    const lost = Math.max(MIN_KARMA_LOST, Math.floor(Math.abs(Number(exp) || 0) / XP_DIVIDER));
    return Math.min(current, lost);
}

module.exports = { MIN_KARMA, MAX_KARMA, XP_DIVIDER, pkKillKarma, karmaLostForExperience };
