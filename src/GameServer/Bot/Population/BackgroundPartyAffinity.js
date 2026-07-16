const HISTORY_LIMIT = 16;
const STRONG_HISTORY_LIMIT = Math.ceil(HISTORY_LIMIT / 2);

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

    const entries = Object.entries(next);
    const strong = entries
        .slice()
        .sort(([, a], [, b]) => Number(b.runs || 0) - Number(a.runs || 0) || Number(b.lastGroupedAt || 0) - Number(a.lastGroupedAt || 0))
        .slice(0, STRONG_HISTORY_LIMIT);
    const selected = new Set(strong.map(([peerId]) => peerId));
    const recent = entries
        .filter(([peerId]) => !selected.has(peerId))
        .sort(([, a], [, b]) => Number(b.lastGroupedAt || 0) - Number(a.lastGroupedAt || 0) || Number(b.runs || 0) - Number(a.runs || 0))
        .slice(0, HISTORY_LIMIT - strong.length);

    return Object.fromEntries([...strong, ...recent]);
}

module.exports = { HISTORY_LIMIT, STRONG_HISTORY_LIMIT, affinity, recordRun };
