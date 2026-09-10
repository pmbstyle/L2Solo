// Shared by the game process and cold workers. No actors, SQL, clocks or RNG.
const VERSION = 1;
const LIMITS = Object.freeze({ character: 32, clan: 8, alliance: 8 });
const RECENT_LIMIT = 128;
const REASON_LIMIT = 3;
const DAY = 86400000;
const ACCEPT_WINDOW_MS = 7 * DAY;
const MAX_BATCH = 64;
const HUNT_COOLDOWN_MS = 30 * 60 * 1000;
const FIELDS = Object.freeze(['affinity', 'trust', 'hostility', 'fear', 'familiarity']);
const EVENTS = Object.freeze({
    hunted_together: [2, 1, 0, 0, 1],
    helped_in_combat: [3, 4, -1, 0, 1],
    healed: [2, 2, 0, 0, 1],
    resurrected: [4, 5, -2, 0, 2],
    resources_received: [2, 3, 0, 0, 1],
    mob_contested: [-2, -1, 3, 0, 1],
    attacked: [-4, -4, 6, 2, 1],
    killed: [-8, -8, 12, 6, 2],
    aided_opponent: [-3, -3, 4, 0, 1]
});

function id(value) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('interaction memory: invalid id');
    return value;
}

function time(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('interaction memory: invalid time');
    return value;
}

function empty(ownerId) {
    return { version: VERSION, ownerId: id(ownerId), revision: 0, replayFloor: -1, relations: [], recent: [] };
}

function validate(snapshot) {
    if (snapshot?.version !== VERSION) throw new Error('interaction memory: snapshot version');
    id(snapshot.ownerId);
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
        || !Number.isSafeInteger(snapshot.replayFloor) || snapshot.replayFloor < -1
        || !Array.isArray(snapshot.relations) || !Array.isArray(snapshot.recent)
        || snapshot.relations.length > 48 || snapshot.recent.length > RECENT_LIMIT) {
        throw new Error('interaction memory: invalid snapshot');
    }
    const targets = new Set(), keys = new Set(), counts = {};
    for (const row of snapshot.relations) {
        if (!row || !Object.hasOwn(LIMITS, row.kind)) throw new Error('interaction memory: invalid relation kind');
        id(row.targetId); time(row.at);
        if (row.lastHuntAt !== undefined) {
            time(row.lastHuntAt);
            if (row.lastHuntAt > row.at) throw new Error('interaction memory: invalid hunt time');
        }
        const key = `${row.kind}:${row.targetId}`;
        counts[row.kind] = (counts[row.kind] || 0) + 1;
        if (targets.has(key) || counts[row.kind] > LIMITS[row.kind]
            || (row.order !== undefined && (!Number.isSafeInteger(row.order) || row.order < 0 || row.order > snapshot.revision))
            || (row.kind === 'character' && row.targetId === snapshot.ownerId)
            || FIELDS.some(field => !Number.isFinite(row[field]) || row[field] > 100
                || row[field] < (['affinity', 'trust'].includes(field) ? -100 : 0))
            || !Array.isArray(row.reasons) || row.reasons.length > REASON_LIMIT) {
            throw new Error('interaction memory: invalid relation');
        }
        for (const reason of row.reasons) {
            time(reason.at);
            if (!Object.hasOwn(EVENTS, reason.type) || reason.at > row.at) throw new Error('interaction memory: invalid reason');
        }
        targets.add(key);
    }
    for (const raw of snapshot.recent) {
        const e = event(raw);
        if (e.sourceId !== snapshot.ownerId || keys.has(e.key) || e.at <= snapshot.replayFloor) throw new Error('interaction memory: invalid journal');
        keys.add(e.key);
    }
    return snapshot;
}

// sourceId is the rememberer, targetId the subject. Producers report one
// accepted episode, never one event per damage tick. Keys and time are immutable.
function event(input) {
    if (!input || typeof input.key !== 'string' || !/^[a-zA-Z0-9:_.-]{1,96}$/.test(input.key)) throw new Error('interaction memory: invalid key');
    const kind = input.kind || 'character';
    if (!Object.hasOwn(LIMITS, kind)) throw new Error('interaction memory: invalid kind');
    if (typeof input.type !== 'string' || !Object.hasOwn(EVENTS, input.type)) throw new Error('interaction memory: invalid event');
    const sourceId = id(input.sourceId), targetId = id(input.targetId);
    if (kind === 'character' && sourceId === targetId) throw new Error('interaction memory: self interaction');
    return { key: input.key, sourceId, targetId, kind, type: input.type, at: time(input.at),
        ...(input.clan ? { clan: require('../Clan/ClanSocialPolicy').evidence(input.clan) } : {}) };
}

function decayed(relation, at) {
    const factor = Math.pow(0.5, Math.max(0, at - relation.at) / (7 * DAY));
    return Object.fromEntries(FIELDS.map(field => [field, relation[field] * factor]));
}

function strength(relation, at) {
    const values = decayed(relation, at);
    return Math.max(...FIELDS.filter(field => field !== 'familiarity').map(field => Math.abs(values[field])));
}

function bound(relations, at) {
    return Object.entries(LIMITS).flatMap(([kind, limit]) => {
        const candidates = relations.filter(row => row.kind === kind);
        const strong = candidates.slice().sort((a, b) => strength(b, at) - strength(a, at)
            || b.at - a.at || (b.order || 0) - (a.order || 0) || a.targetId - b.targetId).slice(0, limit / 2);
        const kept = new Set(strong.map(row => row.targetId));
        const recent = candidates.filter(row => !kept.has(row.targetId))
            .sort((a, b) => b.at - a.at || (b.order || 0) - (a.order || 0) || a.targetId - b.targetId).slice(0, limit - strong.length);
        return [...strong, ...recent];
    });
}

function apply(snapshot, input, now) {
    const e = event(input);
    time(now);
    if (snapshot.readOnly || snapshot.version !== VERSION || snapshot.ownerId !== e.sourceId) throw new Error('interaction memory: incompatible or read-only snapshot');
    const previous = snapshot.recent.find(row => row.key === e.key);
    if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(e)) throw new Error('interaction memory: event key collision');
        return { status: 'duplicate', snapshot };
    }
    if (e.at > now) return { status: 'future_event', snapshot };
    if (e.at <= snapshot.replayFloor || e.at < now - ACCEPT_WINDOW_MS) return { status: 'expired_event', snapshot };
    const old = snapshot.relations.find(row => row.kind === e.kind && row.targetId === e.targetId);
    if (e.type === 'hunted_together' && old?.lastHuntAt !== undefined
        && e.at - old.lastHuntAt < HUNT_COOLDOWN_MS) return { status: 'rate_limited', snapshot };
    const at = Math.max(e.at, old?.at || 0);
    const values = old ? decayed(old, at) : Object.fromEntries(FIELDS.map(field => [field, 0]));
    const factor = Math.pow(0.5, (at - e.at) / (7 * DAY));
    FIELDS.forEach((field, index) => {
        const min = ['hostility', 'fear', 'familiarity'].includes(field) ? 0 : -100;
        values[field] = Math.max(min, Math.min(100, values[field] + EVENTS[e.type][index] * factor));
    });
    const reasons = [{ type: e.type, at: e.at }, ...(old?.reasons || [])]
        .sort((a, b) => b.at - a.at).slice(0, REASON_LIMIT);
    const relation = { kind: e.kind, targetId: e.targetId, at, order: snapshot.revision + 1, ...values, reasons };
    if (e.type === 'hunted_together') relation.lastHuntAt = e.at;
    else if (old?.lastHuntAt !== undefined) relation.lastHuntAt = old.lastHuntAt;
    const relations = bound([...snapshot.relations.filter(row => row !== old), relation], now);
    const ordered = [...snapshot.recent, e].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
    const removed = ordered.slice(RECENT_LIMIT);
    const replayFloor = Math.max(snapshot.replayFloor, now - ACCEPT_WINDOW_MS - 1, ...removed.map(row => row.at));
    // The watermark survives journal eviction, so old deliveries cannot recreate
    // an evicted relation. Late *new* events below it are explicitly rejected too.
    const recent = ordered.slice(0, RECENT_LIMIT).filter(row => row.at > replayFloor);
    return { status: 'applied', snapshot: { ...snapshot, revision: snapshot.revision + 1, replayFloor, relations, recent } };
}

function view(snapshot) {
    const rows = new Map((snapshot?.relations || []).map(row => [`${row.kind}:${row.targetId}`, row]));
    return Object.freeze({
        ownerId: snapshot?.ownerId || null,
        revision: snapshot?.revision || 0,
        ready: !!snapshot,
        relation(kind, targetId, at) {
            time(at);
            const row = rows.get(`${kind}:${targetId}`);
            return row ? { ...decayed(row, at), ...(row.lastHuntAt !== undefined ? { lastHuntAt: row.lastHuntAt } : {}),
                reasons: row.reasons.map(reason => ({ ...reason })) } : null;
        }
    });
}

function assess(memory, source, target, context, now) {
    id(source.id); id(target.id); time(now);
    if (memory.ownerId && memory.ownerId !== source.id) throw new Error('interaction memory: wrong owner');
    const personal = memory.relation('character', target.id, now);
    const clan = memory.relation('clan', target.clanId, now);
    const alliance = memory.relation('alliance', target.allianceId, now);
    const sameClan = Number.isSafeInteger(source.clanId) && source.clanId > 0 && source.clanId === target.clanId;
    const sameAlliance = Number.isSafeInteger(source.allianceId) && source.allianceId > 0 && source.allianceId === target.allianceId;
    const sameParty = !!source.partyId && source.partyId !== 'forming' && source.partyId === target.partyId;
    const reasons = [];
    if (sameParty) reasons.push('same_party');
    if (sameClan) reasons.push('same_clan');
    if (sameAlliance) reasons.push('same_alliance');
    if (context.attackingMe) reasons.push('current_attacker');
    if (context.helpingMe) reasons.push('current_helper');
    const diplomaticEnemy = context.clanStance === 'hostile' || context.allianceStance === 'hostile';
    if (diplomaticEnemy) reasons.push('diplomatic_hostility');
    const disposition = !memory.ready ? 'unloaded' : !personal ? 'unknown'
        : personal.hostility >= 10 || personal.trust <= -10 ? 'hostile'
            : personal.trust >= 5 || personal.affinity >= 5 ? 'friendly'
                : personal.trust < -1 || personal.hostility >= 2 ? 'wary' : 'familiar';
    // Membership and feelings remain independent. This is not attack permission.
    return { ready: memory.ready, revision: memory.revision,
        affiliation: source.id === target.id ? 'self' : sameParty || sameClan ? 'own' : sameAlliance ? 'ally' : 'outsider',
        disposition, personal, clan, alliance, diplomaticEnemy,
        immediateThreat: context.attackingMe === true, reasons };
}

module.exports = { VERSION, LIMITS, RECENT_LIMIT, REASON_LIMIT, ACCEPT_WINDOW_MS, MAX_BATCH, HUNT_COOLDOWN_MS, FIELDS,
    empty, event, apply, view, assess, id, validate };
