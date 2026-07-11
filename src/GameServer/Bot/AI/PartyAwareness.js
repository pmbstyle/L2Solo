const World = invoke('GameServer/World/World');

const RECENT_INCOMING_THREAT_MS = 5000;

function isOnlineActor(actor) {
    return !!actor && actor.fetchIsOnline && actor.fetchIsOnline() && !actor.state?.fetchDead?.();
}

function isPartySession(session, leaderSession) {
    return session === leaderSession || (
        session &&
        session.followPlayerSession === leaderSession &&
        session.partyCompanion === true
    );
}

function partySessions(leaderSession) {
    if (!leaderSession) return [];

    return World.user.sessions.filter((session) => (
        session &&
        isPartySession(session, leaderSession) &&
        isOnlineActor(session.actor)
    ));
}

function partyActors(leaderSession) {
    return partySessions(leaderSession).map((session) => session.actor);
}

function partyActorIds(leaderSession) {
    return new Set(partyActors(leaderSession).map(actorId).filter((id) => id !== null));
}

function actorId(actor) {
    return actor && typeof actor.fetchId === 'function' ? actor.fetchId() : null;
}

function actorLoc(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY()
    };
}

function distance2d(a, b) {
    const dx = Number(a.locX || 0) - Number(b.locX || 0);
    const dy = Number(a.locY || 0) - Number(b.locY || 0);
    return Math.sqrt((dx * dx) + (dy * dy));
}

function uniqueNpcsAround(actors, radius) {
    const seen = new Set();
    const npcs = [];

    actors.forEach((actor) => {
        World.fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), radius).forEach((npc) => {
            const id = actorId(npc);
            if (seen.has(id)) return;
            seen.add(id);
            npcs.push(npc);
        });
    });

    return npcs;
}

function recentIncomingNpc(session, npcRadius = 2500) {
    const threatId = session?.incomingThreatId;
    const threatAt = Number(session?.incomingThreatAt || 0);
    if (!threatId || Date.now() - threatAt > RECENT_INCOMING_THREAT_MS || !session?.actor) return null;

    const npc = (World.npc?.spawns || []).find((spawn) => actorId(spawn) === threatId);
    if (!npc || !npc.fetchAttackable?.() || npc.isDead?.()) return null;
    if (distance2d(actorLoc(npc), actorLoc(session.actor)) > npcRadius) return null;

    return npc;
}

function recentIncomingNpcThreat(leaderSession, memberSessions, npcRadius) {
    for (const memberSession of memberSessions) {
        const npc = recentIncomingNpc(memberSession, npcRadius);
        if (!npc) continue;

        return {
            type: 'npc',
            actor: npc,
            targetId: actorId(memberSession.actor),
            source: 'recent_incoming_hit'
        };
    }

    return null;
}

function findThreatTargetingParty(leaderSession, options = {}) {
    const memberSessions = partySessions(leaderSession);
    const members = memberSessions.map((session) => session.actor);
    if (members.length === 0) return null;

    const memberIds = new Set(members.map(actorId).filter((id) => id !== null));
    const npcRadius = options.npcRadius || 1400;
    const playerRadius = options.playerRadius || 1800;

    const recentThreat = recentIncomingNpcThreat(leaderSession, memberSessions, npcRadius);
    if (recentThreat) return recentThreat;

    const npcThreat = uniqueNpcsAround(members, npcRadius).find((npc) => (
        npc.fetchAttackable &&
        npc.fetchAttackable() &&
        !npc.isDead() &&
        memberIds.has(npc.fetchDestId && npc.fetchDestId())
    ));
    if (npcThreat) {
        return {
            type: 'npc',
            actor: npcThreat,
            targetId: npcThreat.fetchDestId()
        };
    }

    const playerThreatSession = World.user.sessions.find((session) => {
        const actor = session?.actor;
        const id = actorId(actor);
        if (!isOnlineActor(actor) || memberIds.has(id)) return false;
        if (!memberIds.has(actor.fetchDestId && actor.fetchDestId())) return false;

        const isAttackable = actor.fetchKarma?.() > 0 || actor.fetchPvpFlag?.() > 0;
        if (!isAttackable) return false;

        const actorPoint = actorLoc(actor);
        return members.some((member) => distance2d(actorPoint, actorLoc(member)) <= playerRadius);
    });

    if (playerThreatSession?.actor) {
        return {
            type: 'player',
            actor: playerThreatSession.actor,
            targetId: playerThreatSession.actor.fetchDestId()
        };
    }

    return null;
}

function leaderCombatTargetId(leaderSession) {
    const leader = leaderSession?.actor;
    if (!isOnlineActor(leader)) return null;

    const targetId = leader.fetchDestId?.();
    if (!targetId) return null;
    if (partyActorIds(leaderSession).has(targetId)) return null;

    const npc = (World.npc?.spawns || []).find((spawn) => actorId(spawn) === targetId);
    if (npc) {
        return npc.fetchAttackable?.() && !npc.isDead?.() ? targetId : null;
    }

    const targetSession = (World.user?.sessions || []).find((session) => actorId(session?.actor) === targetId);
    const target = targetSession?.actor;
    if (target) {
        if (!isOnlineActor(target)) return null;
        if (isPartySession(targetSession, leaderSession)) return null;
        return target.fetchKarma?.() > 0 || target.fetchPvpFlag?.() > 0 ? targetId : null;
    }

    return null;
}

module.exports = {
    findThreatTargetingParty,
    isPartySession,
    leaderCombatTargetId,
    partyActors,
    partySessions,
    recentIncomingNpc
};
