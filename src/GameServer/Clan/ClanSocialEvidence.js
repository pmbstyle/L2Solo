const { createHash } = require('crypto');
function attach(event, source, target, episode, responsibility = 'unknown', significant = false) {
    const clanId = s => Number(s?.fetchClanId?.() ?? s?.clanId ?? s?.stats?.clanId ?? 0);
    const sourceClanId = clanId(source), targetClanId = clanId(target);
    if (!sourceClanId && !targetClanId) return event;
    return { ...event, clan: { episode: createHash('sha256').update(String(episode)).digest('hex'),
        sourceClanId, targetClanId, responsibility, significant } };
}
module.exports = { attach };
