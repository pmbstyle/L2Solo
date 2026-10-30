const { createHash } = require('crypto');
function attach(event, source, target, episode, responsibility = 'unknown', significant = false) {
    const clanId = s => Number(s?.fetchClanId?.() ?? s?.clanId ?? s?.stats?.clanId ?? 0);
    const sourceClanId = clanId(source), targetClanId = clanId(target);
    if (!sourceClanId && !targetClanId) return event;
    const war = sourceClanId && targetClanId && sourceClanId !== targetClanId && typeof invoke === 'function'
        ? invoke('GameServer/Clan/ClanWarRuntime').view.between(sourceClanId, targetClanId) : null;
    return { ...event, clan: { episode: createHash('sha256').update(String(episode)).digest('hex'),
        sourceClanId, targetClanId, responsibility, significant, ...(war?.mutual ? { warRevision: war.revision } : {}) } };
}
module.exports = { attach };
