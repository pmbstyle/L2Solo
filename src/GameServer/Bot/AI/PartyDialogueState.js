const MAX_RECENT_TURNS = 8;

function actorId(session) {
    return session?.actor?.fetchId?.() || session?.accountId || null;
}

function ensure(playerSession) {
    if (!playerSession) return null;
    if (!playerSession.partyDialogueState || typeof playerSession.partyDialogueState !== 'object') {
        playerSession.partyDialogueState = {
            version: 1,
            activeBotId: null,
            activeSince: 0,
            inFlightBotId: null,
            inFlightSince: 0,
            lastExplicitBotId: null,
            lastExplicitAt: 0,
            lastDeliveredBotId: null,
            lastDeliveredAt: 0,
            lastDeliveredTurnId: null,
            spokespersonId: null,
            recentTurns: []
        };
    }
    return playerSession.partyDialogueState;
}

function compactTurn(turn = {}) {
    return {
        role: turn.role === 'bot' ? 'bot' : 'player',
        botId: turn.botId ?? null,
        text: String(turn.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        channel: String(turn.channel || 'party_chat').slice(0, 32),
        at: Number(turn.at || Date.now())
    };
}

function pushTurn(state, turn) {
    const compact = compactTurn(turn);
    if (!compact.text) return;
    state.recentTurns = [...(state.recentTurns || []), compact].slice(-MAX_RECENT_TURNS);
}

function beginRequest(playerSession, botSession, details = {}) {
    const state = ensure(playerSession);
    if (!state) return null;
    const botId = actorId(botSession);
    if (!botId) return state;

    const at = Number(details.at || Date.now());
    state.inFlightBotId = botId;
    state.inFlightSince = at;
    state.spokespersonId = details.spokespersonId ?? state.spokespersonId ?? null;
    if (String(details.reason || '').startsWith('explicit_')) {
        state.lastExplicitBotId = botId;
        state.lastExplicitAt = at;
    }
    pushTurn(state, {
        role: 'player',
        botId,
        text: details.text,
        channel: details.channel,
        at
    });

    // Keep the legacy fields in sync while callers migrate to the bounded
    // state object. They are not used to claim a reply was delivered.
    playerSession.botDialogueResponderId = botId;
    playerSession.botDialogueResponderAt = at;
    return state;
}

function clearInFlight(playerSession, botSession = null) {
    const state = ensure(playerSession);
    if (!state) return null;
    const botId = botSession ? actorId(botSession) : null;
    if (!botId || String(state.inFlightBotId) === String(botId)) {
        state.inFlightBotId = null;
        state.inFlightSince = 0;
    }
    return state;
}

function recordDeliveredReply(playerSession, botSession, text, details = {}) {
    const state = ensure(playerSession);
    if (!state) return null;
    const botId = actorId(botSession);
    if (!botId || !String(text || '').trim()) return state;
    const turnId = details.turnId || null;
    const deliveryKey = `${botId}:${turnId || ''}:${String(text).trim()}`;
    if (state.lastDeliveredTurnId === deliveryKey) return state;

    const at = Number(details.at || Date.now());
    if (!state.inFlightBotId || String(state.inFlightBotId) === String(botId)) {
        state.inFlightBotId = null;
        state.inFlightSince = 0;
    }
    state.activeBotId = botId;
    state.activeSince = at;
    state.lastDeliveredBotId = botId;
    state.lastDeliveredAt = at;
    state.lastDeliveredTurnId = deliveryKey;
    pushTurn(state, {
        role: 'bot',
        botId,
        text,
        channel: details.channel,
        at
    });
    playerSession.botDialogueResponderId = botId;
    playerSession.botDialogueResponderAt = at;
    return state;
}

function snapshot(playerSession) {
    const state = playerSession?.partyDialogueState;
    if (!state) return null;
    return {
        version: state.version,
        activeBotId: state.activeBotId,
        activeSince: state.activeSince,
        inFlightBotId: state.inFlightBotId,
        inFlightSince: state.inFlightSince,
        lastExplicitBotId: state.lastExplicitBotId,
        lastExplicitAt: state.lastExplicitAt,
        lastDeliveredBotId: state.lastDeliveredBotId,
        lastDeliveredAt: state.lastDeliveredAt,
        spokespersonId: state.spokespersonId,
        recentTurns: [...(state.recentTurns || [])]
    };
}

function reset(playerSession) {
    if (!playerSession) return;
    delete playerSession.partyDialogueState;
    delete playerSession.botDialogueResponderId;
    delete playerSession.botDialogueResponderAt;
}

module.exports = {
    MAX_RECENT_TURNS,
    beginRequest,
    clearInFlight,
    ensure,
    recordDeliveredReply,
    reset,
    snapshot
};
