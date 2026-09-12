// Short-lived causal facts, separate from long-lived dislike and PvP flags.
// Only the accepted native hostile-action path may create these records.
const LIMIT = 32;
const IDLE_MS = 60000;
const id = actor => Number(actor?.fetchId?.() || 0);
const reverse = fact => fact.responsibility === 'defense' ? fact.aggressionRole : 'defense';

function entries(actor, at) {
    const session = actor?.session;
    if (!session) return new Map();
    if (!session.pvpIncidents) {
        const saved = session.coldLifeState || session.coldMarketState || session.coldCraftState;
        session.pvpIncidents = new Map();
        for (const row of (Array.isArray(saved?.stats?.pvpIncidents) ? saved.stats.pvpIncidents : []).slice(-LIMIT)) {
            if (Number.isSafeInteger(row?.opponentId) && row.opponentId > 0 && row.opponentId !== id(actor)
                && ['aggression', 'provoked', 'defense'].includes(row.responsibility)
                && ['aggression', 'provoked'].includes(row.aggressionRole)
                && typeof row.episode === 'string' && row.episode.length <= 96
                && Number.isSafeInteger(row.at) && Number.isSafeInteger(row.startedAt) && row.startedAt <= row.at) {
                session.pvpIncidents.set(row.opponentId, { ...row });
            }
        }
    }
    for (const [other, row] of session.pvpIncidents) {
        if (row.at > at || at - row.at >= IDLE_MS) session.pvpIncidents.delete(other);
    }
    return session.pvpIncidents;
}

function managed(attacker, victim) {
    for (const encounter of [attacker?.session?.pvpEncounter, victim?.session?.pvpEncounter]) {
        const side = encounter?.sides?.findIndex(s => s.memberIds.includes(id(attacker)));
        if (!(side >= 0) || !encounter.sides.some((s, i) => i !== side && s.memberIds.includes(id(victim)))) continue;
        return { episode: encounter.key, startedAt: encounter.startedAt,
            aggressionRole: encounter.reason === 'revenge' ? 'aggression' : 'provoked',
            responsibility: side === (encounter.reason === 'revenge' ? 0 : 1)
            ? encounter.reason === 'revenge' ? 'aggression' : 'provoked' : 'defense' };
    }
    return null;
}

function assess(attacker, victim, at = Date.now()) {
    const encounter = managed(attacker, victim);
    if (encounter) return encounter;
    const own = entries(attacker, at).get(id(victim));
    const other = entries(victim, at).get(id(attacker));
    // A re-materialized participant may have an older snapshot than its peer.
    if (other && (!own || other.startedAt < own.startedAt)) {
        return { ...other, responsibility: reverse(other) };
    }
    return own || { responsibility: 'unknown', episode: null };
}

function store(actor, otherId, fact, at, changed) {
    if (!actor?.session || !otherId || otherId === id(actor)) return;
    const rows = entries(actor, at), previous = rows.get(otherId);
    const row = { opponentId: otherId, episode: fact.episode, responsibility: fact.responsibility,
        aggressionRole: fact.aggressionRole, startedAt: fact.startedAt ?? at, at };
    rows.delete(otherId); rows.set(otherId, row);
    while (rows.size > LIMIT) rows.delete(rows.keys().next().value);
    if (previous?.episode !== row.episode || previous?.responsibility !== row.responsibility) changed.add(actor.session);
}

function record(attacker, victim, defenders = [], at = Date.now()) {
    const changed = new Set();
    if (!id(attacker) || !id(victim) || attacker === victim) return changed;
    let fact = assess(attacker, victim, at);
    if (fact.responsibility === 'unknown') {
        const revenge = attacker.session?.pvpRevenge;
        fact = { episode: `native:${id(attacker)}:${id(victim)}:${at}`, startedAt: at,
            responsibility: revenge?.target === victim && revenge.reason === 'mob_competition' ? 'provoked' : 'aggression' };
        fact.aggressionRole = fact.responsibility;
    }
    store(attacker, id(victim), fact, at, changed);
    store(victim, id(attacker), { ...fact, responsibility: reverse(fact) }, at, changed);
    if (fact.responsibility !== 'defense') {
        // Nearby party members can defend this victim against this attacker.
        // No social event is invented for witnesses or the attacker's allies.
        for (const member of defenders) {
            if (member.actor === victim || member.actor === attacker) continue;
            if (assess(member.actor, attacker, at).responsibility !== 'unknown') continue;
            store(member.actor, id(attacker), { ...fact, responsibility: 'defense' }, at, changed);
        }
    }
    return changed;
}

function snapshot(actor, at = Date.now()) {
    return [...entries(actor, at).values()].map(row => ({ ...row }));
}

module.exports = { record, assess, snapshot, LIMIT, IDLE_MS };
