// Read-time bridge only: the legacy player history and shared field memory
// keep their own storage. Overlapping positive evidence is not added twice.
function combine(legacy = {}, relation) {
    const feeling = relation?.effective || relation?.personal;
    const value = n => Number.isFinite(Number(n)) ? Number(n) : 0;
    const oldTrust = value(legacy.trust), trust = value(feeling?.trust);
    const reason = !relation?.ready ? 'relationship_unloaded'
        : relation.immediateThreat || relation.diplomaticEnemy
            || value(feeling?.hostility) >= 10 || trust <= -6 ? 'relationship_hostile' : null;
    return {
        memory: { ...legacy,
            trust: Math.max(0, oldTrust, trust) + Math.min(0, oldTrust) + Math.min(0, trust),
            familiarity: Math.max(value(legacy.familiarity), value(feeling?.familiarity)),
            hostility: value(feeling?.hostility), fear: value(feeling?.fear) },
        relation, reason
    };
}
module.exports = { combine };
