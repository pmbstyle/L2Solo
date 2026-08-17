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
        'party_membership_mismatch'
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

module.exports = {
    rotationExpiry,
    sessionExpired,
    releaseMember
};
