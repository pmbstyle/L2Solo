// Temporary policy written by an authorized player through the hot dialogue
// tool layer.  This is deliberately session-local: persona and social memory
// are durable, while pull overrides, combat preferences, and skill weights
// must disappear when the hot session ends or the party relationship changes.

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MIN_TTL_MS = 5 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const MAX_SKILL_PRIORITIES = 12;
const MAX_SKILL_WEIGHT = 50;
const STANCES = new Set(['balanced', 'aggressive', 'defensive', 'ranged']);

function now() {
    return Date.now();
}

function actorId(session) {
    return Number(session?.actor?.fetchId?.() || 0) || null;
}

function actorName(session) {
    return session?.actor?.fetchName?.() || session?.name || null;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function ttl(value) {
    const requested = Number(value);
    if (!Number.isFinite(requested)) return DEFAULT_TTL_MS;
    return clamp(Math.floor(requested), MIN_TTL_MS, MAX_TTL_MS);
}

function normalizePriorities(value) {
    if (!value || typeof value !== 'object') return {};
    return Object.entries(value)
        .map(([skillId, weight]) => [Number(skillId), clamp(Number(weight) || 0, -MAX_SKILL_WEIGHT, MAX_SKILL_WEIGHT)])
        .filter(([skillId, weight]) => skillId > 0 && weight !== 0)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0] - b[0])
        .slice(0, MAX_SKILL_PRIORITIES)
        .reduce((result, [skillId, weight]) => {
            result[String(skillId)] = weight;
            return result;
        }, {});
}

function normalizeStance(value) {
    const stance = String(value || '').toLowerCase();
    return STANCES.has(stance) ? stance : null;
}

function normalizePull(value) {
    if (!value || typeof value !== 'object') return null;
    const permission = ['allow', 'deny'].includes(value.permission) ? value.permission : null;
    const mode = ['auto', 'leader', 'bot', 'off'].includes(value.mode) ? value.mode : null;
    const pullerId = Number(value.pullerId || 0) || null;
    if (!permission && !mode && !pullerId) return null;
    return { permission, mode, pullerId };
}

function prune(session) {
    const overlay = session?.hotPolicyOverlay;
    if (!overlay) return null;
    if (Number(overlay.expiresAt || 0) > now()) return overlay;
    delete session.hotPolicyOverlay;
    return null;
}

function get(session) {
    return prune(session);
}

function set(session, patch = {}, context = {}) {
    if (!session) return null;

    const previous = prune(session) || {};
    const updated = {
        ...previous,
        ownerId: Number(context.ownerId || previous.ownerId || 0) || null,
        ownerName: context.ownerName || previous.ownerName || null,
        reason: String(context.reason || patch.reason || previous.reason || 'player_request').slice(0, 160),
        createdAt: Number(previous.createdAt || now()),
        updatedAt: now(),
        expiresAt: now() + ttl(patch.ttlMs ?? context.ttlMs ?? (previous.expiresAt ? previous.expiresAt - now() : DEFAULT_TTL_MS)),
        skillPriorities: normalizePriorities(patch.skillPriorities ?? previous.skillPriorities),
        combatStance: normalizeStance(patch.combatStance ?? previous.combatStance),
        pull: normalizePull(patch.pull ?? previous.pull)
    };

    // An explicitly cleared field must not be resurrected by the old object.
    if (patch.skillPriorities === null) updated.skillPriorities = {};
    if (patch.combatStance === null) updated.combatStance = null;
    if (patch.pull === null) updated.pull = null;

    session.hotPolicyOverlay = updated;
    return { ...updated, skillPriorities: { ...updated.skillPriorities }, pull: updated.pull && { ...updated.pull } };
}

function clear(session, reason = 'lifecycle') {
    if (!session?.hotPolicyOverlay) return false;
    delete session.hotPolicyOverlay;
    session.lastHotPolicyReset = { reason, at: now() };
    return true;
}

function clearForDeath(session) {
    return clear(session, 'death');
}

function clearForCold(session) {
    return clear(session, 'cold_transition');
}

function clearForPartyDetach(session) {
    return clear(session, 'party_detached');
}

function combatPolicy(session) {
    const overlay = get(session);
    return {
        skillPriorities: { ...(overlay?.skillPriorities || {}) },
        stance: overlay?.combatStance || 'balanced'
    };
}

function status(session) {
    const overlay = get(session);
    if (!overlay) return null;
    return {
        ownerId: overlay.ownerId,
        ownerName: overlay.ownerName,
        reason: overlay.reason,
        createdAt: overlay.createdAt,
        updatedAt: overlay.updatedAt,
        expiresAt: overlay.expiresAt,
        expiresInSec: Math.max(0, Math.ceil((overlay.expiresAt - now()) / 1000)),
        pull: overlay.pull ? { ...overlay.pull } : null,
        combatStance: overlay.combatStance || null,
        skillPriorities: { ...(overlay.skillPriorities || {}) }
    };
}

module.exports = {
    DEFAULT_TTL_MS,
    MAX_SKILL_WEIGHT,
    STANCES: [...STANCES],
    clear,
    clearForCold,
    clearForDeath,
    clearForPartyDetach,
    combatPolicy,
    get,
    normalizePriorities,
    normalizeStance,
    set,
    status
};
