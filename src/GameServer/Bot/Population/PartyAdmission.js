// All formation paths share this admission budget. Historical origin labels
// never grant slots or protect a party; reservations include in-flight commits.
class PartyAdmission {
    constructor() { this.pending = 0; }
    reserve(parties, config) {
        const limit = Math.max(0, Math.floor(Number(config.maxBackgroundParties) || 0));
        if (parties.length + this.pending >= limit) return null;
        this.pending++;
        let released = false;
        return () => { if (!released) { released = true; this.pending--; } };
    }
}
// Waiting can eventually outweigh a fresh urgent request. Only a current open
// objective contributes age; stale metadata and group origin grant no priority.
function priority(objectives, timestamp) {
    const open = objectives.filter(o => o?.status === 'open');
    if (!open.length) return 0;
    return Math.max(...open.map(o => {
        const urgency = o.priority === 'required' ? 2 : 0;
        const requestedAt = Number(o.requestedAt || 0);
        const age = requestedAt > 0 ? Math.max(0, timestamp - requestedAt) : 0;
        return urgency + Math.min(6, age / 120000);
    }));
}
module.exports = { PartyAdmission, priority };
