// Facts and admission shared by native combat and bounded cold skirmishes.
const { THREAT_MS, COOLDOWN_MS } = require('./CombatHelpPolicy');
function victimId(recipient, helperId, at) {
    const id = Number(recipient?.lastVictimId || 0), time = Number(recipient?.lastVictimAt || 0);
    return id > 0 && id !== helperId && time <= at && at - time < THREAT_MS ? id : 0;
}
function lastAt(relation) {
    return Math.max(-1, Number(relation?.lastAidAt ?? -1),
        ...(relation?.reasons || []).filter(r => r.type === 'aided_opponent').map(r => r.at));
}
function eligible(relation, at) { const last = lastAt(relation); return last < 0 || at - last >= COOLDOWN_MS; }
module.exports = { victimId, lastAt, eligible, COOLDOWN_MS };
