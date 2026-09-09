// Deduct voluntary idle time once, so the next cold resolve cannot award
// catch-up farming for a period that was explicitly yielded to another hunter.
function consume(state, elapsedMs, timestamp) {
    const wait = state?.stats?.coldCompetition?.wait;
    if (!wait) return { state, elapsedMs };
    if (state.activity === 'hunting' && timestamp < wait.until) return { waiting: true, until: wait.until };
    const overlap = Math.max(0, Math.min(timestamp, wait.until) - Math.max(timestamp - elapsedMs, wait.start));
    return { state: { ...state, stats: { ...state.stats, coldCompetition: { ...state.stats.coldCompetition, wait: null } } },
        elapsedMs: state.activity === 'hunting' ? Math.max(0, elapsedMs - overlap) : elapsedMs };
}
module.exports = { consume };
