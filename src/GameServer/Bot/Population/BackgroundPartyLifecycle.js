const DEFAULT_SESSION_MAX_MS = 20 * 60 * 1000;
const DEFAULT_SESSION_JITTER_MS = 5 * 60 * 1000;

function rotationExpiry(partyId, startedAt, options = {}) {
    const config = options || {};
    const hasMaxAge = Object.prototype.hasOwnProperty.call(config, 'partySessionMaxMs');
    const hasJitter = Object.prototype.hasOwnProperty.call(config, 'partySessionJitterMs');
    const maxAge = hasMaxAge
        ? Math.max(0, Number(config.partySessionMaxMs) || 0)
        : DEFAULT_SESSION_MAX_MS;
    const jitter = Math.min(
        maxAge,
        hasJitter
            ? Math.max(0, Number(config.partySessionJitterMs) || 0)
            : DEFAULT_SESSION_JITTER_MS
    );
    if (!maxAge || !startedAt) return 0;

    let hash = 0;
    for (const char of String(partyId || '')) hash = ((hash * 31) + char.charCodeAt(0)) | 0;
    const span = jitter * 2 + 1;
    const offset = jitter ? Math.abs(hash) % span - jitter : 0;
    return Number(startedAt) + maxAge + offset;
}

function sessionExpired(party, timestamp = Date.now(), options = {}) {
    const reviewAt = Number(party?.stats?.sessionReview?.nextAt || 0);
    if (reviewAt > 0) return timestamp >= reviewAt;
    const sessionExpiresAt = Number(party?.stats?.sessionExpiresAt || 0);
    if (sessionExpiresAt > 0) return timestamp >= sessionExpiresAt;

    const startedAt = Number(party?.stats?.formedAt || party?.startedAt || 0);
    const expiresAt = rotationExpiry(party?.partyId, startedAt, options);
    return expiresAt > 0 && Number(timestamp) >= expiresAt;
}

function releaseMember(state, timestamp = Date.now(), reason = 'party_session_rotation') {
    if (!state?.characterId) return state;

    const partyTravel = state.stats?.travel?.reason === 'party_spot_replan';
    const releasedFromObjective = [
        'party_session_rotation',
        'party_min_size',
        'invalid_party_size',
        'party_membership_mismatch',
        'party_relationship_conflict', 'party_goals_diverged', 'party_no_progress', 'party_no_experience', 'party_review_min_size'
    ].includes(reason);
    const nextActivity = releasedFromObjective && (state.activity === 'grouped' || partyTravel)
        ? 'hunting'
        : state.activity;

    return {
        ...state,
        activity: nextActivity,
        party: { ...(state.party || {}), partyId: null, leaderId: null },
        stats: {
            ...(state.stats || {}),
            ...(partyTravel ? { travel: null } : {}),
            backgroundPartyId: null,
            partyBreakReason: reason,
            partyRequest: null
        },
        timing: releasedFromObjective
            ? { ...(state.timing || {}), activityStartedAt: timestamp, nextResolveAt: timestamp + 30000 }
            : state.timing,
        updatedAt: timestamp
    };
}

function review(party, members, timestamp, options = {}) {
    const result = require('./PartySessionReview').assess(party, members, timestamp, options);
    const leaving = new Map(result.decisions.filter(d => d.leave).map(d => [d.characterId, d.reason]));
    let retained = members.filter(s => !leaving.has(s.characterId));
    const dissolved = retained.length < Math.max(2, Number(options.partyMinSize) || 2);
    if (dissolved) {
        members.forEach(s => { if (!leaving.has(s.characterId)) leaving.set(s.characterId, 'party_review_min_size'); });
        retained = [];
    }
    const leaderId = retained.find(s => s.characterId === party.leaderId)?.characterId
        || (options.chooseLeader?.(retained) || retained[0])?.characterId || party.leaderId;
    const nextResolveAt = Math.max(timestamp + 1000, Number(party.nextResolveAt || 0));
    const states = members.map(s => leaving.has(s.characterId)
        ? releaseMember(s, timestamp, leaving.get(s.characterId))
        : { ...s, party: { ...s.party, leaderId }, stats: { ...s.stats, leaderId },
            timing: { ...s.timing, nextResolveAt } });
    const nextParty = { ...party, status: dissolved ? 'dissolved' : party.status || 'active',
        memberIds: retained.map(s => s.characterId), leaderId, nextResolveAt: dissolved ? null : nextResolveAt,
        roleCoverage: options.roleCoverage?.(retained) || party.roleCoverage,
        stats: { ...party.stats, sessionReview: result.review, memberNames: retained.map(s => s.name),
            ...(dissolved ? { dissolvedAt: timestamp, partyBreakReason: 'party_review_min_size' } : {}) } };
    return { party: nextParty, states, leaving, decisions: result.decisions };
}

module.exports = {
    rotationExpiry,
    sessionExpired,
    review,
    releaseMember
};
