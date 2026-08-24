const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const EffectStore = invoke('GameServer/Effects/EffectStore');

const RECENT_INCOMING_THREAT_MS = 5000;
// Hot companions are dispatched serially, but several services inside one
// decision ask the same party-wide question. Share that projection briefly
// across the party instead of repeating one spatial query per member for
// every caller. Damage invalidates the projection before the urgent wakeup,
// so this does not add hit-response latency.
const THREAT_PROJECTION_MAX_AGE_MS = 150;
// NPC combat remains active until the target is 1500 units away.  Threat
// discovery must cover that full envelope: a ranged/social add at 1401-1499
// can still be hitting the puller and therefore must wake the camp.
const NPC_THREAT_RADIUS = 1500;
const threatProjections = new WeakMap();

// World loads bot controls as part of its own initialization. Resolving it at
// module scope here can therefore retain Node's empty circular-dependency
// export forever. Read the completed singleton when a decision is made.
function world() {
    return invoke('GameServer/World/World');
}

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

    return (world().user?.sessions || []).filter((session) => (
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
        world().fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), radius).forEach((npc) => {
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

    const npc = (world().npc?.spawns || []).find((spawn) => actorId(spawn) === threatId);
    if (!npc || !npc.fetchAttackable?.() || npc.isDead?.()) return null;
    if (distance2d(actorLoc(npc), actorLoc(session.actor)) > npcRadius) return null;

    return npc;
}

function npcThreateningActor(session, npcRadius = 2500) {
    const actor = session?.actor;
    if (!actor) return null;

    // A fresh hit is authoritative even when a lightweight NPC fixture or an
    // in-flight retarget has not exposed fetchDestId yet.
    const recent = recentIncomingNpc(session, npcRadius);
    if (recent) return recent;

    const id = Number(actorId(actor) || 0);
    if (!id) return null;
    return (world().fetchNpcsInRadius?.(
        actor.fetchLocX(),
        actor.fetchLocY(),
        npcRadius
    ) || []).find((npc) => (
        npc.fetchAttackable?.() === true &&
        npc.isDead?.() !== true &&
        npc.state?.fetchDead?.() !== true &&
        (Number(npc.fetchDestId?.() || 0) === id || Number(npc.getHating?.(actor) || 0) > 0)
    )) || null;
}

function recentIncomingNpcThreat(leaderSession, memberSessions, npcRadius) {
    for (const memberSession of memberSessions) {
        const npc = recentIncomingNpc(memberSession, npcRadius);
        if (!npc) continue;
        if (isControlledRaidMinion(leaderSession, npc)) continue;

        return {
            type: BotRaidSafety.isProtectedRaidEntity(npc) && !BotRaidSafety.isEngagedPlayerPartyRaidTarget(leaderSession, npc)
                ? 'raid'
                : 'npc',
            actor: npc,
            targetId: actorId(memberSession.actor),
            source: 'recent_incoming_hit'
        };
    }

    return null;
}

function npcThreatPriority(leaderSession, memberSessions, npc) {
    const targetId = Number(npc.fetchDestId?.() || 0);
    const targetSession = memberSessions.find((session) => Number(actorId(session.actor)) === targetId);
    if (!targetSession) return Number.MAX_SAFE_INTEGER;

    const pullerId = Number(leaderSession?.partyPullState?.pullerId || 0);
    if (targetId === pullerId) return 0;
    const role = BotRoles.inferRole(targetSession.actor);
    if (role === 'healer') return 1;
    if (role === 'buffer') return 2;
    if (targetSession === leaderSession) return 3;
    return 4;
}

function combatTargetPriority(leaderSession, memberSessions, npc) {
    const raidEntity = BotRaidSafety.isEngagedPlayerPartyRaidTarget(leaderSession, npc);
    const impairments = EffectStore.impairments(npc);
    const controlled = impairments.disabled;
    const raidPriority = raidEntity
        ? (BotRaidSafety.isRaidBoss(npc) ? 0 : (controlled ? 200 : 100))
        : 50;
    return raidPriority + npcThreatPriority(leaderSession, memberSessions, npc);
}

function isControlledRaidMinion(leaderSession, npc) {
    if (BotRaidSafety.isRaidBoss(npc) || !BotRaidSafety.isEngagedPlayerPartyRaidTarget(leaderSession, npc)) return false;
    const impairments = EffectStore.impairments(npc);
    return impairments.disabled;
}

function findThreatTargetingParty(leaderSession, options = {}) {
    const memberSessions = partySessions(leaderSession);
    const members = memberSessions.map((session) => session.actor);
    if (members.length === 0) return null;

    const memberIds = new Set(members.map(actorId).filter((id) => id !== null));
    const npcRadius = options.npcRadius || NPC_THREAT_RADIUS;
    const playerRadius = options.playerRadius || 1800;

    const nearbyNpcs = uniqueNpcsAround(members, npcRadius);
    BotRaidSafety.syncPlayerPartyRaid(leaderSession);
    const raidThreat = nearbyNpcs
        .filter((npc) => (
            BotRaidSafety.isProtectedRaidEntity(npc) &&
            !BotRaidSafety.isEngagedPlayerPartyRaidTarget(leaderSession, npc) &&
            npc.fetchAttackable?.() === true &&
            !npc.isDead?.() &&
            memberIds.has(Number(npc.fetchDestId?.()))
        ))
        .sort((a, b) => actorId(a) - actorId(b))[0];
    if (raidThreat) {
        return {
            type: 'raid',
            actor: raidThreat,
            targetId: raidThreat.fetchDestId?.(),
            source: 'raid_entity_targeting_party'
        };
    }

    const recentThreat = recentIncomingNpcThreat(leaderSession, memberSessions, npcRadius);
    if (recentThreat) return recentThreat;

    const npcThreat = nearbyNpcs
        .filter((npc) => (
            (!BotRaidSafety.isProtectedRaidEntity(npc) || BotRaidSafety.isEngagedPlayerPartyRaidTarget(leaderSession, npc)) &&
            !isControlledRaidMinion(leaderSession, npc) &&
            npc.fetchAttackable &&
            npc.fetchAttackable() &&
            !npc.isDead() &&
            memberIds.has(npc.fetchDestId && npc.fetchDestId())
        ))
        .sort((a, b) => (
            combatTargetPriority(leaderSession, memberSessions, a) - combatTargetPriority(leaderSession, memberSessions, b) ||
            actorId(a) - actorId(b)
        ))[0];
    if (npcThreat) {
        return {
            type: 'npc',
            actor: npcThreat,
            targetId: npcThreat.fetchDestId()
        };
    }

    const playerThreatSession = (world().user?.sessions || []).find((session) => {
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

function projectionLeader(session) {
    if (session?.partyCompanion === true && session.followPlayerSession) {
        return session.followPlayerSession;
    }
    return session;
}

function recordProjectionSubsystem(name, durationMs, items = 0) {
    try {
        invoke('GameServer/Bot/AI/HotActorLodPolicy').recordSubsystem(name, durationMs, items);
    } catch (_) {
        // Party awareness is also used by lightweight tests and startup paths
        // that do not initialize the full hot-runtime telemetry graph.
    }
}

function awarenessOptionsKey(options = {}) {
    return `${Number(options.npcRadius || NPC_THREAT_RADIUS)}:${Number(options.playerRadius || 1800)}`;
}

function cachedThreatIsUsable(entry, now, maxAgeMs, currentWorld, optionsKey) {
    if (!entry || now - entry.createdAt > maxAgeMs) return false;
    if (entry.optionsKey !== optionsKey) return false;
    if (entry.npcRegistry !== currentWorld.npc) return false;
    if (entry.npcRadiusReader !== currentWorld.fetchNpcsInRadius) return false;
    if (entry.npcThreatRevision !== Number(currentWorld.npc?.threatRevision || 0)) return false;
    if (entry.userRevision !== Number(currentWorld.user?.revision || 0)) return false;
    const actor = entry.threat?.actor;
    if (!actor) return true;
    if (actor.isDead?.() === true || actor.state?.fetchDead?.() === true) return false;
    if (entry.threat.source !== 'recent_incoming_hit') {
        const projectedTargetId = Number(entry.threat.targetId || 0);
        const currentTargetId = Number(actor.fetchDestId?.() || 0);
        if (projectedTargetId !== currentTargetId) return false;
    }
    return true;
}

function findThreatTargetingPartyProjected(leaderSession, options = {}) {
    const leader = projectionLeader(leaderSession);
    if (!leader || typeof leader !== 'object') return null;

    const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? THREAT_PROJECTION_MAX_AGE_MS) || 0);
    const now = Date.now();
    const currentWorld = world();
    const optionsKey = awarenessOptionsKey(options);
    const cached = threatProjections.get(leader);
    if (maxAgeMs > 0 && cachedThreatIsUsable(cached, now, maxAgeMs, currentWorld, optionsKey)) {
        recordProjectionSubsystem('partyThreatCacheHit', 0, 1);
        return cached.threat;
    }

    const awarenessOptions = { ...options };
    delete awarenessOptions.maxAgeMs;
    const startedAt = Date.now();
    const threat = findThreatTargetingParty(leader, awarenessOptions);
    threatProjections.set(leader, {
        createdAt: now,
        threat,
        optionsKey,
        npcRegistry: currentWorld.npc,
        npcRadiusReader: currentWorld.fetchNpcsInRadius,
        npcThreatRevision: Number(currentWorld.npc?.threatRevision || 0),
        userRevision: Number(currentWorld.user?.revision || 0)
    });
    recordProjectionSubsystem('partyThreatScan', Date.now() - startedAt, 1);
    return threat;
}

function invalidateThreatProjection(session) {
    const leader = projectionLeader(session);
    if (!leader || typeof leader !== 'object') return false;
    return threatProjections.delete(leader);
}

function leaderCombatTargetId(leaderSession, options = {}) {
    const leader = leaderSession?.actor;
    if (!isOnlineActor(leader)) return null;

    const targetId = leader.fetchDestId?.();
    if (!targetId) return null;
    if (partyActorIds(leaderSession).has(targetId)) return null;

    const npc = (world().npc?.spawns || []).find((spawn) => actorId(spawn) === targetId);
    if (npc) {
        const protectedRaidTarget = BotRaidSafety.isProtectedRaidEntity(npc);
        const allowedRaidTarget = options.allowPlayerRaid === true &&
            BotRaidSafety.isEngagedPlayerPartyRaidTarget(leaderSession, npc);
        return (!protectedRaidTarget || allowedRaidTarget) && npc.fetchAttackable?.() && !npc.isDead?.()
            ? targetId
            : null;
    }

    const targetSession = (world().user?.sessions || []).find((session) => actorId(session?.actor) === targetId);
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
    findThreatTargetingPartyProjected,
    invalidateThreatProjection,
    isPartySession,
    leaderCombatTargetId,
    npcThreateningActor,
    partyActors,
    partySessions,
    recentIncomingNpc,
    THREAT_PROJECTION_MAX_AGE_MS
};
