const MAX_REMAINING_HP_RATIO = 0.30;
const MAX_CONSECUTIVE_FAILURES = 2;

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function bossTemplateId(value = {}) {
    return number(value.bossTemplateId || value.raidBossTemplateId || value.npcId);
}

function remainingHpRatio(encounter = {}) {
    const explicit = Number(encounter.remainingHpRatio);
    if (Number.isFinite(explicit)) return Math.max(0, Math.min(1, explicit));
    const hp = Math.max(0, number(encounter.hp));
    const maxHp = Math.max(1, number(encounter.maxHp || encounter.encounter?.mob?.maxHp, hp || 1));
    return Math.max(0, Math.min(1, hp / maxHp));
}

function decision(previous = null, encounter = {}) {
    const bossId = bossTemplateId(encounter);
    const sameBoss = bossId > 0 && bossId === bossTemplateId(previous || {});
    const consecutiveFailures = sameBoss
        ? number(previous?.consecutiveFailures) + 1
        : 1;
    const hpRatio = remainingHpRatio(encounter);
    const retryAllowed = hpRatio <= MAX_REMAINING_HP_RATIO
        && consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
    return {
        bossTemplateId: bossId,
        consecutiveFailures,
        remainingHpRatio: hpRatio,
        retryAllowed,
        reasonCode: hpRatio > MAX_REMAINING_HP_RATIO
            ? 'raid_failure_high_hp'
            : consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
                ? 'raid_failure_limit'
                : 'raid_failure_retry'
    };
}

function blockedSpotIds(goal = {}) {
    const failure = goal?.raidFailure;
    return failure?.retryAllowed === false && bossTemplateId(failure) > 0
        ? new Set([`raid:${bossTemplateId(failure)}`])
        : new Set();
}

function carriedFailure(previousGoal = null, _plan = null, sameTarget = false) {
    const failure = previousGoal?.raidFailure;
    // Keep the result with the equipment debt even when its next route changes.
    // Otherwise a high-HP failure is forgotten as soon as the planner chooses
    // an ordinary farm spot and the same boss can be selected again next tick.
    return sameTarget && failure ? { ...failure } : null;
}

module.exports = {
    MAX_REMAINING_HP_RATIO,
    MAX_CONSECUTIVE_FAILURES,
    bossTemplateId,
    remainingHpRatio,
    decision,
    blockedSpotIds,
    carriedFailure
};
