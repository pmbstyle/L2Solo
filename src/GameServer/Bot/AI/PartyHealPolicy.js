// The HP share below which a party healer heals a member (bot parties hot
// and cold, and a summoner its pet: PetHealRule).
const HEAL_BELOW = 0.7;

// An emergency is a member missing this share of its HP: a fast rescue beats
// upkeep (score), and a stronger heal over time may replace a running one
// (BotSkillIntent.equivalentIn).
const EMERGENCY_MISSING = 0.65;

function emergency(missingHp, maxHp) {
    return missingHp / Math.max(1, maxHp) >= EMERGENCY_MISSING;
}

// Compare useful healing, not nominal spell power. Periodic healing is
// valuable upkeep, but cannot substitute for a fast rescue at critical HP.
function score({ missingHp, maxHp, power, cost, castMs, periodic = false, ticks = 1, recipients = 1 }) {
    const urgent = emergency(missingHp, maxHp);
    const useful = Math.min(missingHp, Math.max(0, power) * (periodic && !urgent ? ticks : 1));
    if (urgent) return useful / Math.max(250, castMs) * (periodic ? 0.1 : 1);
    return useful * Math.max(1, recipients) / Math.max(1, cost) / (1 + Math.max(0, castMs) / 10000);
}

module.exports = { HEAL_BELOW, emergency, score };
