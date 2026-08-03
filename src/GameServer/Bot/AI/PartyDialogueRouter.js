const PartyAddressResolver = invoke('GameServer/Bot/AI/PartyAddressResolver');

const PARTY_CHANNEL_KIND = 3;
const ACTIVE_RESPONDER_TTL_MS = 5 * 60 * 1000;
const HEARING_RADIUS = 1500;

function actorId(actor) {
    return actor && typeof actor.fetchId === 'function' ? actor.fetchId() : null;
}

function actorName(actor) {
    return actor && typeof actor.fetchName === 'function' ? actor.fetchName() : '';
}

function distanceBetween(a, b) {
    if (!a || !b) return Infinity;
    const dx = Number(a.fetchLocX?.() || 0) - Number(b.fetchLocX?.() || 0);
    const dy = Number(a.fetchLocY?.() || 0) - Number(b.fetchLocY?.() || 0);
    const dz = Number(a.fetchLocZ?.() || 0) - Number(b.fetchLocZ?.() || 0);
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
}

function isOnline(session) {
    const actor = session?.actor;
    if (!actor) return false;
    if (typeof actor.fetchIsOnline === 'function' && !actor.fetchIsOnline()) return false;
    if (typeof actor.isDead === 'function' && actor.isDead()) return false;
    return true;
}

function isCompanion(session, playerSession) {
    return session?.partyCompanion === true && session.followPlayerSession === playerSession;
}

function isGroupAddress(text) {
    return /\b(?:bot|bots|guys|party|team|help|everyone|anyone|somebody|someone)\b/i.test(String(text || ''));
}

function isContinuationMessage(text) {
    const value = String(text || '').trim().toLowerCase();
    return /^(?:yes|yeah|yep|sure|no|nope|ok|okay|alright|right|exactly|do it|go ahead|continue|sounds good|got it|thanks|thank you|and then|what about)\b/.test(value);
}

function buildCandidates({ sessions = [], playerSession, partyChannel = false, hearingRadius = HEARING_RADIUS } = {}) {
    const player = playerSession?.actor;
    return sessions
        .filter((session) => isOnline(session))
        .map((session) => {
            const actor = session.actor;
            const companion = isCompanion(session, playerSession);
            const distance = distanceBetween(actor, player);
            return {
                session,
                actor,
                id: actorId(actor),
                name: actorName(actor),
                companion,
                selected: typeof player?.fetchDestId === 'function' && player.fetchDestId() === actorId(actor),
                distance,
                role: session.partyRole || session.role || actor.partyRole || actor.role || null,
                eligible: partyChannel ? companion : distance <= hearingRadius
            };
        })
        .filter((candidate) => candidate.eligible);
}

function findById(candidates, id) {
    if (id === undefined || id === null || id === '') return null;
    return candidates.find((candidate) => String(candidate.id) === String(id)) || null;
}

function select({
    text,
    playerSession,
    sessions,
    kind,
    now = Date.now(),
    dialogueState = null,
    activeResponderId,
    activeResponderAt,
    hearingRadius = HEARING_RADIUS
} = {}) {
    const partyChannel = Number(kind) === PARTY_CHANNEL_KIND;
    const candidates = buildCandidates({ sessions, playerSession, partyChannel, hearingRadius });
    const explicit = PartyAddressResolver.resolve(text, candidates);

    if (explicit.status === 'matched') {
        return {
            candidate: explicit.candidate,
            candidates,
            status: 'matched',
            reason: `explicit_${explicit.matchType}`,
            matchType: explicit.matchType
        };
    }
    if (explicit.status === 'ambiguous') {
        return {
            candidate: null,
            candidates,
            status: 'ambiguous',
            reason: 'explicit_ambiguous',
            matchType: explicit.matchType,
            matches: explicit.matches
        };
    }

    const selected = candidates.find((candidate) => candidate.selected);
    if (selected) {
        return { candidate: selected, candidates, status: 'matched', reason: 'selected', matchType: null };
    }

    const state = dialogueState || {};
    const inFlight = findById(candidates, state.inFlightBotId);
    if (inFlight) {
        return { candidate: inFlight, candidates, status: 'matched', reason: 'in_flight', matchType: null };
    }

    const previousId = state.lastDeliveredBotId ?? state.activeBotId ?? activeResponderId;
    const previousAt = state.lastDeliveredAt || state.activeSince || activeResponderAt;
    const activeAge = Number.isFinite(Number(previousAt))
        ? now - Number(previousAt)
        : Infinity;
    const active = (partyChannel || isContinuationMessage(text)) && activeAge >= 0 && activeAge <= ACTIVE_RESPONDER_TTL_MS
        ? findById(candidates, previousId)
        : null;
    if (active) {
        return { candidate: active, candidates, status: 'matched', reason: 'active_responder', matchType: null };
    }

    const spokesperson = candidates.find((candidate) => candidate.companion);
    if (partyChannel && spokesperson) {
        return { candidate: spokesperson, candidates, status: 'matched', reason: 'party_spokesperson', matchType: null };
    }

    if (isGroupAddress(text) && candidates[0]) {
        return { candidate: candidates[0], candidates, status: 'matched', reason: 'group_spokesperson', matchType: null };
    }

    return { candidate: null, candidates, status: 'none', reason: 'unresolved', matchType: null };
}

module.exports = {
    ACTIVE_RESPONDER_TTL_MS,
    HEARING_RADIUS,
    PARTY_CHANNEL_KIND,
    buildCandidates,
    isGroupAddress,
    isContinuationMessage,
    select
};
