'use strict';

function population({ states, botSessions, playerSessions, isStaticService, isRealPlayerSession, botCapacity }) {
    const ids = new Set(), excluded = new Set();
    for (const state of states) {
        const id = Number(state.characterId);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        (isStaticService(state) ? excluded : ids).add(id);
    }
    for (const session of botSessions) {
        if (!session.actor || session.actor.fetchIsOnline?.() === false) continue;
        const id = Number(session.actor.fetchId());
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        (isStaticService(session) ? excluded : ids).add(id);
    }
    for (const id of excluded) ids.delete(id);
    const bots = ids.size;
    const players = playerSessions.filter(isRealPlayerSession).length;
    return { bots, players, capacity: Math.max(0, Math.floor(Number(botCapacity) || 0)) };
}

module.exports = { population };
