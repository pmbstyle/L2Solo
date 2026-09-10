const { createHash } = require('crypto');
const Policy = require('./CombatHelpPolicy');
const { attach } = require('../Clan/ClanSocialEvidence');
function eventsFor(helps, episodeId, at, assess, identityFor = () => null) {
    if (!episodeId || typeof assess !== 'function') return [];
    const seen = new Set(), events = [];
    for (const help of helps) {
        const { sourceId, targetId, type } = help;
        const pair = `${sourceId}:${targetId}:${type}`;
        if (sourceId === targetId || !Policy.TYPES.includes(type) || seen.has(pair)) continue;
        seen.add(pair);
        const relation = assess({ id: sourceId }, { id: targetId }, {}, at);
        if (!relation.ready || !Policy.eligible(relation.personal, type, at)) continue;
        const key = `help:${createHash('sha256').update(`${episodeId}:${pair}`).digest('hex')}`;
        events.push(attach({ key, sourceId, targetId, type, at },
            relation.sourceClanId !== undefined ? { clanId: relation.sourceClanId } : identityFor(sourceId),
            relation.targetClanId !== undefined ? { clanId: relation.targetClanId } : identityFor(targetId),
            episodeId, 'cooperation', true));
        if (events.length === 64) break;
    }
    return events;
}
module.exports = { eventsFor };
