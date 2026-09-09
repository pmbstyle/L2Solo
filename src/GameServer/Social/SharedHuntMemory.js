const { createHash, randomUUID } = require('crypto');
const Policy = require('./InteractionMemoryPolicy');

function eventsFor(sourceId, peerIds, episodeId, at, assessRelationship) {
    if (!episodeId || typeof assessRelationship !== 'function') return [];
    return [...new Set(peerIds)].filter(id => id !== sourceId).flatMap(targetId => {
        const relation = assessRelationship({ id: sourceId }, { id: targetId }, {}, at);
        if (!relation.ready || (relation.personal?.lastHuntAt !== undefined
            && at - relation.personal.lastHuntAt < Policy.HUNT_COOLDOWN_MS)) return [];
        const key = createHash('sha256').update(`${episodeId}:${sourceId}:${targetId}`).digest('hex');
        return [{ key: `hunt:${key}`, sourceId, targetId, type: 'hunted_together', at }];
    });
}

function eventsForGroup(memberIds, episodeId, at, assessRelationship) {
    return memberIds.flatMap(id => eventsFor(id, memberIds, episodeId, at, assessRelationship)).slice(0, Policy.MAX_BATCH);
}

// Called only after a real group kill and reward eligibility have been established.
function recordHot(rewards, npc, at = Date.now()) {
    if (npc?.fetchKind?.() !== 'Monster' || npc.fetchIsRaidBoss?.() || npc.minionBossObjectId) return;
    const members = rewards.filter(({ session, exp, sp }) => (exp > 0 || sp > 0)
        && session?.actor?.fetchIsOnline?.() === true && !session.actor.isDead()
        && !invoke('GameServer/World/ArenaCombatRules').isArenaParticipant(session.actor));
    if (members.length < 2) return;
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const episodeId = randomUUID();
    const peers = members.map(({ session }) => Number(session.actor.fetchId()));
    for (const { session } of members) {
        if (!String(session.accountId || '').startsWith('bot_') || session.staticService) continue;
        for (const event of eventsFor(Number(session.actor.fetchId()), peers, episodeId, at, memory.assess.bind(memory))) {
            memory.events.enqueue(event);
        }
    }
}

module.exports = { eventsFor, eventsForGroup, recordHot };
