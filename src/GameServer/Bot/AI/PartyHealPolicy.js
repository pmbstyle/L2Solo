// Compare useful healing, not nominal spell power. Periodic healing is
// valuable upkeep, but cannot substitute for a fast rescue at critical HP.
function score({ missingHp, maxHp, power, cost, castMs, periodic = false, ticks = 1, recipients = 1 }) {
    const emergency = missingHp / Math.max(1, maxHp) >= 0.65;
    const useful = Math.min(missingHp, Math.max(0, power) * (periodic && !emergency ? ticks : 1));
    if (emergency) return useful / Math.max(250, castMs) * (periodic ? 0.1 : 1);
    return useful * Math.max(1, recipients) / Math.max(1, cost) / (1 + Math.max(0, castMs) / 10000);
}

module.exports = { score };
