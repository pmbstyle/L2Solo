// Shared factual thresholds, independent of actors, timers and persistence.
const COOLDOWN_MS = 30 * 60000;
const THREAT_MS = 15000;
const TYPES = Object.freeze(['healed', 'resurrected', 'helped_in_combat']);
const injured = (hp, maxHp) => hp > 0 && maxHp > 0 && hp < maxHp * 0.4;
const meaningfulHeal = (before, after, maxHp) => injured(before, maxHp) && after - before >= maxHp * 0.05;
function lastAt(relation, type) {
    return Math.max(-1, Number(relation?.lastHelpAt?.[type] ?? -1),
        ...(relation?.reasons || []).filter(r => r.type === type).map(r => r.at));
}
function eligible(relation, type, at) { const last = lastAt(relation, type); return last < 0 || at - last >= COOLDOWN_MS; }
module.exports = { COOLDOWN_MS, THREAT_MS, TYPES, injured, meaningfulHeal, lastAt, eligible };
