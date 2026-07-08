const World = invoke('GameServer/World/World');

const PARTY_REWARD_RADIUS = 2500;

function distance2d(a, b) {
    const dx = a.fetchLocX() - b.fetchLocX();
    const dy = a.fetchLocY() - b.fetchLocY();
    return Math.sqrt(dx * dx + dy * dy);
}

function isAliveOnline(session) {
    const actor = session?.actor;
    return actor && actor.fetchIsOnline?.() === true && !actor.isDead();
}

function uniqueSessions(sessions) {
    const seen = new Set();
    return sessions.filter((memberSession) => {
        if (!memberSession || seen.has(memberSession)) return false;
        seen.add(memberSession);
        return true;
    });
}

function partyLeaderSession(killerSession) {
    if (killerSession?.partyCompanion === true && killerSession.followPlayerSession) {
        return killerSession.followPlayerSession;
    }
    return killerSession;
}

function ownerSessionForSummon(actor) {
    if (actor?.fetchIsSummon?.() !== true) return null;
    const ownerId = actor.fetchOwnerId?.();
    if (!ownerId) return null;
    return (World.user?.sessions || []).find((session) => session.actor?.fetchId?.() === ownerId) || null;
}

function rewardParticipants(killerSession, killer, npc) {
    const leaderSession = partyLeaderSession(killerSession);
    const leader = leaderSession?.actor;
    if (!leader || !isAliveOnline(leaderSession)) return [killerSession];

    const members = [leaderSession];
    World.user.sessions.forEach((candidate) => {
        if (
            candidate !== leaderSession &&
            candidate.partyCompanion === true &&
            candidate.followPlayerSession === leaderSession
        ) {
            members.push(candidate);
        }
    });

    const nearbyMembers = uniqueSessions(members)
        .filter(isAliveOnline)
        .filter((memberSession) => distance2d(memberSession.actor, npc) <= PARTY_REWARD_RADIUS);

    if (nearbyMembers.includes(killerSession)) return nearbyMembers;
    if (killer && !killer.isDead()) return [killerSession];
    return [];
}

function npcDied(session, actor, npc) {
    const Generics = invoke(path.actor);

    if (npc.fetchIsSummon?.() === true) {
        World.npc.spawns = World.npc.spawns.filter((spawn) => spawn.fetchId() !== npc.fetchId());
        session.dataSendToMeAndOthers?.(invoke('GameServer/Network/Response').deleteOb(npc.fetchId()), npc);
        if (actor?.fetchIsSummon?.() === true) actor.attack?.clearTimers?.();
        return;
    }

    const ownerSession = ownerSessionForSummon(actor);
    if (ownerSession) {
        session = ownerSession;
    }

    World.removeNpc(session, npc);
    Generics.abortCombatState(session, actor);

    if (actor.isDead()) return;

    const rewardActor = ownerSession?.actor || actor;
    const participants = rewardParticipants(session, rewardActor, npc);
    const rewardExp = Math.max(0, Math.floor(npc.fetchAcquiredExp() / Math.max(1, participants.length)));
    const rewardSp = Math.max(0, Math.floor(npc.fetchRewardSp() / Math.max(1, participants.length)));

    participants.forEach((memberSession) => {
        Generics.experienceReward(memberSession, memberSession.actor, rewardExp, rewardSp);
    });
}

module.exports = npcDied;
