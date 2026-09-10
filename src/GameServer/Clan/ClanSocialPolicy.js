// Pure clan reputation and discipline. Scores never grant combat permission.
const HOUR = 3600000, DAY = HOUR * 24;
const LIMITS = { character: 128, clan: 32, recent: 256 };
const TYPES = {
    mob_contested: { harm: 2, trust: -1, halfLife: DAY },
    attacked: { harm: 6, trust: -4, halfLife: DAY * 3 },
    killed: { harm: 12, trust: -8, fear: 4, halfLife: DAY * 7 },
    aided_opponent: { harm: 4, trust: -3, halfLife: DAY * 3 },
    hunted_together: { harm: 0, trust: 1, halfLife: DAY * 7 },
    helped_in_combat: { harm: -2, trust: 4, halfLife: DAY * 7 },
    healed: { harm: -1, trust: 2, halfLife: DAY * 7 },
    resurrected: { harm: -3, trust: 5, halfLife: DAY * 7 },
    resources_received: { harm: -1, trust: 2, halfLife: DAY * 7 }
};
const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));
function empty(clanId) { return { version: 1, clanId, revision: 0, replayFloor: -1, relations: [], recent: [] }; }
function evidence(input) {
    if (!input) return null;
    if (!/^[a-zA-Z0-9:_.-]{1,96}$/.test(input.episode || '')
        || !['aggression', 'provoked', 'defense', 'unknown', 'cooperation'].includes(input.responsibility)
        || ['sourceClanId', 'targetClanId'].some(k => !Number.isSafeInteger(input[k]) || input[k] < 0)) {
        throw Error('clan social: invalid evidence');
    }
    return { episode: input.episode, sourceClanId: input.sourceClanId, targetClanId: input.targetClanId,
        responsibility: input.responsibility, significant: input.significant === true };
}
function relation(row, at) {
    if (!row) return null;
    const factor = 0.5 ** (Math.max(0, at - row.at) / row.halfLife);
    return { ...row, trust: row.trust * factor, hostility: row.hostility * factor,
        fear: row.fear * factor, familiarity: row.familiarity * factor,
        ...(row.discipline ? { discipline: discipline(row.discipline, 0, at) } : {}) };
}
function stance(row, at) {
    const r = relation(row, at);
    if (!r) return 'neutral';
    // Exit thresholds are lower than entry thresholds to prevent oscillation.
    if (r.hostility >= (r.stance === 'hostile' ? 18 : 30)) return 'hostile';
    if (r.trust >= (r.stance === 'friendly' ? 6 : 12) && r.hostility < 10) return 'friendly';
    return r.hostility >= 6 || r.trust <= -6 ? 'wary' : 'neutral';
}
function discipline(previous, harm, at, leader = {}) {
    const d = { stage: 'clear', score: 0, at, stageAt: at, lastOffenseAt: 0, ...previous };
    if (d.stage === 'expelled') return d;
    d.score *= 0.5 ** (Math.max(0, at - d.at) / (7 * DAY));
    d.at = at;
    if (harm <= 0) {
        d.score = Math.max(0, d.score + Math.max(-1, harm));
        if (d.score < 3 && at - d.lastOffenseAt >= DAY) { d.stage = 'clear'; d.stageAt = at; }
        return d;
    }
    // One distinct offense per half hour; a casualty in the same fight cannot
    // promote a member through warning, probation and expulsion at once.
    if (d.lastOffenseAt && at - d.lastOffenseAt < HOUR / 2) return d;
    d.score = clamp(d.score + harm);
    d.lastOffenseAt = at;
    const tolerance = 12 + 4 * (Number(leader.empathy ?? 0.5) - Number(leader.assertiveness ?? 0.5));
    const old = d.stage;
    if (old === 'clear' && d.score >= 4) d.stage = 'concern';
    else if (old === 'concern' && d.score >= tolerance) d.stage = 'warned';
    else if (old === 'warned' && d.score >= tolerance + 6 && at - d.stageAt >= HOUR) d.stage = 'probation';
    else if (old === 'probation' && d.score >= tolerance + 12 && at - d.stageAt >= HOUR) d.stage = 'expulsion_pending';
    if (d.stage !== old) {
        d.stageAt = at;
        if (d.stage === 'warned') d.warningAt = at;
        if (d.stage === 'probation') d.probationAt = at;
    }
    return d;
}
function apply(snapshot, event, at, context = {}) {
    const fact = evidence(event.clan), type = TYPES[event.type];
    if (!fact || !type || event.kind !== 'character') return snapshot;
    if (event.at > at || event.at <= snapshot.replayFloor || event.at < at - 7 * DAY) return snapshot;
    const key = `${event.key}:${snapshot.clanId}`;
    if (snapshot.recent.some(r => r.key === key)) return snapshot;
    const own = snapshot.clanId === fact.targetClanId;
    const observed = snapshot.clanId === fact.sourceClanId;
    if (!own && !observed) return snapshot;
    const positive = type.trust > 0;
    if (event.type === 'aided_opponent' && !fact.significant) return snapshot;
    if (positive && event.type !== 'hunted_together' && !fact.significant) return snapshot;
    const factor = positive ? 1 : fact.responsibility === 'aggression' ? 1 : fact.responsibility === 'provoked' ? 0.4 : 0;
    if (!factor) return snapshot; // Unknown responsibility is not collective guilt.
    const next = context.mutable ? snapshot : JSON.parse(JSON.stringify(snapshot));
    const update = (kind, targetId, scale, internal = false) => {
        let old = next.relations.find(r => r.kind === kind && r.targetId === targetId);
        const clock = Math.max(event.at, old?.at || 0);
        const r = relation(old, clock) || { kind, targetId, at: clock, trust: 0, hostility: 0, fear: 0, familiarity: 0,
            halfLife: type.halfLife, reasons: [], evidence: [] };
        r.evidence = (r.evidence || []).filter(e => clock - e.at < 3 * DAY);
        const category = positive ? 'help' : 'harm';
        const prior = r.evidence.find(e => e.episode === fact.episode && e.category === category);
        const severity = Math.max(type.harm, type.trust, 0);
        // A battle has a capped severity, independent of witnesses and roster size.
        const increment = prior ? Math.max(0, severity - prior.severity) : severity;
        const sameSubject = r.evidence.filter(e => e.category === category && e.subject === event.targetId && clock - e.at < HOUR);
        const repetition = !prior && sameSubject.length ? 0.25 : 1;
        if (!r.budget || clock - r.budget.at >= DAY) r.budget = { at: clock, help: 0, harm: 0 };
        const credit = Math.min(increment * factor * scale * repetition, Math.max(0, (positive ? 6 : 24) - r.budget[category]));
        r.budget[category] += credit;
        r.at = clock;
        if (prior) { prior.severity = Math.max(prior.severity, severity); prior.weight += credit; }
        else r.evidence.push({ episode: fact.episode, category, subject: event.targetId, subjectClanId: fact.targetClanId, witness: event.sourceId,
            at: event.at, severity, weight: credit });
        r.evidence = r.evidence.slice(-8);
        if (!credit) { if (old) Object.assign(old, r); return; }
        const amount = credit / severity;
        r.trust = clamp(r.trust + type.trust * amount, -100);
        r.hostility = clamp(r.hostility + type.harm * amount);
        r.fear = clamp(r.fear + (type.fear || 0) * amount);
        r.familiarity = clamp(r.familiarity + amount);
        r.at = clock;
        r.halfLife = Math.max(r.halfLife, type.halfLife);
        r.reasons = [{ type: event.type, at: event.at, subject: event.targetId, witness: event.sourceId,
            responsibility: fact.responsibility }, ...r.reasons].slice(0, 3);
        r.stance = stance(r, clock);
        if (internal && (context.currentTargetClanId === undefined || context.currentTargetClanId === snapshot.clanId)) {
            r.discipline = discipline(r.discipline, positive ? -credit : credit, event.at, context.leaderTraits);
            r.discipline.reason = event.type;
        }
        if (old) Object.assign(old, r); else next.relations.push(r);
    };
    if (observed) update('character', event.targetId, 1, own);
    if (own && !observed) update('character', event.targetId, positive ? 0.5 : 1, true);
    if (observed && fact.targetClanId && fact.targetClanId !== snapshot.clanId) {
        // Collective responsibility needs independent actors AND episodes.
        // A leader's direct action is a limited explicit representation signal.
        const histories = next.relations.filter(r => r.kind === 'character').flatMap(r => r.evidence || [])
            .filter(e => e.category === (positive ? 'help' : 'harm') && event.at - e.at < 3 * DAY);
        const subjects = new Set(histories.filter(e => e.subjectClanId === fact.targetClanId).map(e => e.subject));
        const episodes = new Set(histories.filter(e => e.subjectClanId === fact.targetClanId).map(e => e.episode));
        if ((subjects.size >= 2 && episodes.size >= 2) || context.targetLeaderId === event.targetId) update('clan', fact.targetClanId, 0.35);
    }
    next.relations = Object.entries(LIMITS).filter(([k]) => k !== 'recent').flatMap(([kind, limit]) => {
        const rows = next.relations.filter(r => r.kind === kind);
        const priority = r => r.discipline && r.discipline.stage !== 'clear' ? 1000 : 0;
        return rows.sort((a, b) => priority(b) - priority(a) || Math.max(Math.abs(b.trust), b.hostility) - Math.max(Math.abs(a.trust), a.hostility) || b.at - a.at).slice(0, limit);
    });
    const recent = [...next.recent, { key, at: event.at }].sort((a, b) => b.at - a.at);
    next.replayFloor = Math.max(next.replayFloor, ...recent.slice(LIMITS.recent).map(r => r.at));
    next.recent = recent.slice(0, LIMITS.recent).filter(r => r.at > next.replayFloor);
    next.revision++;
    return next;
}
function assess(snapshot, target, personal, at, impression = null, index = null) {
    const find = (kind, id) => index ? index.get(`${kind}:${id}`) : snapshot?.relations.find(r => r.kind === kind && r.targetId === id);
    const decisionRow = row => {
        const value = relation(row, at);
        if (!value) return null;
        const { evidence, budget, ...publicView } = value;
        return publicView;
    };
    const individual = decisionRow(find('character', target.id));
    const collective = decisionRow(find('clan', target.clanId));
    const p = personal || { affinity: 0, trust: 0, hostility: 0, fear: 0 };
    // Strong personal friendship can temper a collective grievance. Shared
    // reputation is an influence, not a replacement for first-hand experience.
    const weight = p.trust >= 5 ? 0.2 : 0.5;
    const aggregate = field => clamp((individual?.[field] || 0) + (collective?.[field] || 0) + (impression?.[field] || 0), -100, 100);
    const effective = { ...p, affinity: p.affinity || 0, trust: clamp(p.trust + aggregate('trust') * weight, -100),
        hostility: clamp(p.hostility + aggregate('hostility') * weight), fear: clamp(p.fear + aggregate('fear') * weight) };
    return { ready: !!snapshot, revision: snapshot?.revision || 0, individual, collective, effective };
}
module.exports = { empty, evidence, apply, relation, stance, discipline, assess, LIMITS, HOUR, DAY };
