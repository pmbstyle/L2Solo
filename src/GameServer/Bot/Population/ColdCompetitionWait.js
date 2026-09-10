// Deduct lost hunting time once, whether voluntarily yielded or interrupted
// by a resource contest. Neither case may earn catch-up farming rewards.
function consume(state, elapsedMs, timestamp) {
    const wait = state?.stats?.coldCompetition?.wait;
    if (!wait) return { state, elapsedMs };
    if ((state.activity === 'hunting' || wait.combat) && timestamp < wait.until) return { waiting: true, until: wait.until };
    const overlap = Math.max(0, Math.min(timestamp, wait.until) - Math.max(timestamp - elapsedMs, wait.start));
    return { state: { ...state, stats: { ...state.stats, coldCompetition: { ...state.stats.coldCompetition, wait: null } } },
        elapsedMs: state.activity === 'hunting' || wait.combat ? Math.max(0, elapsedMs - overlap) : elapsedMs };
}
function consumeParty(party, members, elapsedMs, timestamp) {
    const waits = [party, ...members].map(s => s?.stats?.coldCompetition?.wait).filter(Boolean);
    if (!waits.length) return { party, members, elapsedMs };
    const resting = !waits.some(w => w.combat) && members.some(s => s.activity === 'resting');
    const until = Math.max(...waits.map(w => w.until));
    if (!resting && timestamp < until) return { waiting: true, until };
    // Merge intervals: the same shared pause is also stored on every member
    // so it survives departure from the party. It must never be charged N times.
    const intervals = waits.map(w => [Math.max(timestamp - elapsedMs, w.start), Math.min(timestamp, w.until)])
        .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    let lost = 0, end = -Infinity;
    for (const interval of intervals) {
        lost += Math.max(0, interval[1] - Math.max(interval[0], end));
        end = Math.max(end, interval[1]);
    }
    const clear = state => state?.stats?.coldCompetition?.wait?.until <= timestamp
        ? { ...state, stats: { ...state.stats, coldCompetition: { ...state.stats.coldCompetition, wait: null } } } : state;
    return { party: clear(party), members: members.map(clear), elapsedMs: resting ? elapsedMs : Math.max(0, elapsedMs - lost) };
}
module.exports = { consume, consumeParty };
