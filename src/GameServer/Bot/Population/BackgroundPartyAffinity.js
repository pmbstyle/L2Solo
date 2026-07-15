const HISTORY_LIMIT = 16;

function historyFor(state) {
    return state?.stats?.partyHistory && typeof state.stats.partyHistory === 'object'
        ? state.stats.partyHistory
        : {};
}

function affinity(state, peers = []) {
    const history = historyFor(state);
    return peers.reduce((score, peer) => score + Number(history[Number(peer?.characterId)]?.runs || 0), 0);
}

function recordRun(state, members, timestamp = Date.now()) {
    const next = { ...historyFor(state) };
    (members || []).forEach((peer) => {
        const peerId = Number(peer?.characterId || 0);
        if (!peerId || peerId === Number(state?.characterId || 0)) return;
        const previous = next[peerId] || {};
        next[peerId] = { runs: Number(previous.runs || 0) + 1, lastGroupedAt: timestamp };
    });

    return Object.fromEntries(Object.entries(next)
        .sort(([, a], [, b]) => Number(b.lastGroupedAt || 0) - Number(a.lastGroupedAt || 0) || Number(b.runs || 0) - Number(a.runs || 0))
        .slice(0, HISTORY_LIMIT));
}

module.exports = { HISTORY_LIMIT, affinity, recordRun };
