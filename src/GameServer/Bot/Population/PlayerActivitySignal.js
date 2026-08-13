const state = {
    lastRealPlayerAt: 0
};

function isSimulatedSession(session) {
    if (!session) return true;
    if (session.isSimPlayer === true || session.simPlayer === true) return true;
    const constructorName = String(session.constructor?.name || '');
    return constructorName === 'BotSession' || constructorName === 'SimPlayer';
}

function isRealPlayerSession(session) {
    return !!(
        session
        && !isSimulatedSession(session)
        && session.actor
        && session.actor.fetchIsOnline?.() !== false
        && session.accountId
        && !String(session.accountId).startsWith('bot_')
    );
}

function observe(options = {}) {
    const timestamp = Number(options.now ?? Date.now());
    const sessions = Array.isArray(options.sessions) ? options.sessions : [];
    const realPlayers = Array.isArray(options.realPlayers)
        ? options.realPlayers.filter(isRealPlayerSession)
        : sessions.filter(isRealPlayerSession);
    const graceMs = Math.max(0, Number(options.graceMs) || 0);

    if (realPlayers.length > 0) {
        state.lastRealPlayerAt = timestamp;
    }

    const playerSet = new Set(realPlayers);
    const companionCount = sessions.filter((session) => (
        session?.partyCompanion === true
        && playerSet.has(session.followPlayerSession)
        && session.actor?.fetchIsOnline?.() !== false
    )).length;
    const protectedUntil = state.lastRealPlayerAt > 0
        ? state.lastRealPlayerAt + graceMs
        : 0;
    const protectedHotPath = realPlayers.length > 0 || timestamp < protectedUntil;
    const activeParty = realPlayers.length > 0 && companionCount > 0;

    return {
        realPlayers: realPlayers.length,
        companionCount,
        activeParty,
        protected: protectedHotPath,
        lastRealPlayerAt: state.lastRealPlayerAt || null,
        protectedUntil: protectedHotPath ? protectedUntil : null,
        mode: activeParty
            ? 'party'
            : realPlayers.length > 0
                ? 'player'
                : protectedHotPath
                    ? 'grace'
                    : 'idle'
    };
}

function reset() {
    state.lastRealPlayerAt = 0;
}

module.exports = {
    isRealPlayerSession,
    observe,
    reset
};
