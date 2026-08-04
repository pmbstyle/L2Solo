const PartyAddressResolver = invoke('GameServer/Bot/AI/PartyAddressResolver');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

const PARTY_CHANNEL_KIND = 3;
const ACTIVE_RESPONDER_TTL_MS = 5 * 60 * 1000;
const HEARING_RADIUS = 1500;

const ROLE_ALIASES = {
    tank: ['tank', 'frontline', 'guard'],
    healer: ['healer', 'medic', 'healing'],
    buffer: ['buffer', 'support'],
    puller: ['puller', 'pull'],
    dps: ['dps', 'damage', 'dd'],
    mage: ['mage', 'caster'],
    archer: ['archer', 'ranged'],
    dagger: ['dagger', 'rogue']
};

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

function roleFor(session, actor) {
    return String(
        session?.partyRole ||
        session?.role ||
        session?.botStatus?.role ||
        session?.roleDecision?.role ||
        actor?.partyRole ||
        actor?.role ||
        BotRoles.inferRole(actor)
    ).toLowerCase();
}

function isPuller(session, role) {
    return session?.partyPuller === true ||
        session?.isPuller === true ||
        session?.roleDecision?.decision === 'party_pull' ||
        role === 'puller';
}

function roleAddressMatches(text, candidates) {
    const value = String(text || '').toLowerCase();
    const requestedRoles = Object.entries(ROLE_ALIASES)
        .filter(([, aliases]) => aliases.some((alias) => new RegExp(`\\b${alias}\\b`, 'i').test(value)))
        .map(([role]) => role);
    if (requestedRoles.length !== 1) return { status: requestedRoles.length > 1 ? 'ambiguous' : 'none', matches: [] };

    const requested = requestedRoles[0];
    const matches = candidates.filter((candidate) => (
        requested === 'puller'
            ? candidate.puller
            : candidate.role === requested
    ));
    if (matches.length === 1) return { status: 'matched', matches, role: requested };
    return { status: matches.length > 1 ? 'ambiguous' : 'none', matches, role: requested };
}

function buildCandidates({ sessions = [], playerSession, partyChannel = false, hearingRadius = HEARING_RADIUS } = {}) {
    const player = playerSession?.actor;
    const configuredPullerId = Number(playerSession?.partyCompanionSettings?.pullerId || 0);
    return sessions
        .filter((session) => isOnline(session))
        .map((session) => {
            const actor = session.actor;
            const companion = isCompanion(session, playerSession);
            const distance = distanceBetween(actor, player);
            const role = roleFor(session, actor);
            return {
                session,
                actor,
                id: actorId(actor),
                name: actorName(actor),
                companion,
                selected: typeof player?.fetchDestId === 'function' && player.fetchDestId() === actorId(actor),
                distance,
                role,
                puller: isPuller(session, role) || Number(actorId(actor)) === configuredPullerId,
                pendingInteraction: !!(
                    session.activeTrade?.playerSession === playerSession ||
                    session.activeNegotiation?.playerSession === playerSession
                ),
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
    allowSpokespersonFallback = true,
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
        if (partyChannel && allowSpokespersonFallback !== false) {
            const fallback = findById(candidates, dialogueState?.spokespersonId) || candidates.find((candidate) => candidate.companion);
            if (fallback) {
                return {
                    candidate: fallback,
                    candidates,
                    status: 'matched',
                    reason: 'party_spokesperson_ambiguous',
                    matchType: explicit.matchType,
                    matches: explicit.matches
                };
            }
        }
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

    const pending = candidates.find((candidate) => candidate.pendingInteraction);
    if (pending) {
        return { candidate: pending, candidates, status: 'matched', reason: 'pending_interaction', matchType: null };
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

    const roleOwner = roleAddressMatches(text, candidates);
    if (roleOwner.status === 'matched') {
        return {
            candidate: roleOwner.matches[0],
            candidates,
            status: 'matched',
            reason: `role_${roleOwner.role}`,
            matchType: 'role'
        };
    }
    if (roleOwner.status === 'ambiguous') {
        return {
            candidate: null,
            candidates,
            status: 'ambiguous',
            reason: 'role_ambiguous',
            matchType: 'role',
            matches: roleOwner.matches
        };
    }

    const spokesperson = findById(candidates, state.spokespersonId) || candidates.find((candidate) => candidate.companion);
    if (partyChannel && spokesperson && allowSpokespersonFallback !== false) {
        return { candidate: spokesperson, candidates, status: 'matched', reason: 'party_spokesperson', matchType: null };
    }

    if (partyChannel && allowSpokespersonFallback === false) {
        return { candidate: null, candidates, status: 'needs_router', reason: 'party_ambiguous', matchType: null };
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
    roleAddressMatches,
    select
};
