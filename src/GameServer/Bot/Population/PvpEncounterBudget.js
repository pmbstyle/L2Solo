const INITIAL_MS = 30000;
const EXTENSION_MS = 15000;
const MAX_MS = 60000;
const MAX_ACTIONS = 256;
const REVIEW_WINDOW_MS = 5000;

// Extend an unfinished cold skirmish only on a newly resolved attack near its
// deadline. Idle timers and lifecycle handoffs cannot renew the encounter.
function extend(encounter, combat, timestamp) {
    if (!combat?.ongoing || !combat.fighters.some(f => f.attacks > 0)
        || encounter.actions >= MAX_ACTIONS || timestamp >= encounter.expiresAt
        || timestamp < encounter.expiresAt - REVIEW_WINDOW_MS) return encounter;
    const expiresAt = Math.min(encounter.startedAt + MAX_MS, encounter.expiresAt + EXTENSION_MS);
    if (expiresAt <= encounter.expiresAt) return encounter;
    return { ...encounter, expiresAt, extensions: Number(encounter.extensions || 0) + 1 };
}

module.exports = { INITIAL_MS, MAX_ACTIONS, MAX_MS, extend };
