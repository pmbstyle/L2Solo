const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');

function world() {
    return invoke('GameServer/World/World');
}

function actorId(actor) {
    return Number(actor?.fetchId?.() || 0) || null;
}

function isAlive(session) {
    return !!session?.actor && session.actor.fetchIsOnline?.() === true && !session.actor.isDead?.();
}

function partySessions(leaderSession, { includeDead = false } = {}) {
    if (!leaderSession) return [];

    // A companion is owned by BotManager before every visibility/update path
    // has necessarily populated World.user. Read both registries so combat,
    // loot and revival see the same party during that short lifecycle gap.
    const BotManager = invoke('GameServer/Bot/BotManager');
    const candidates = [
        leaderSession,
        ...(world().user?.sessions || []),
        ...(BotManager.sessions || [])
    ];
    const unique = new Set();
    return candidates.filter((session) => {
        if (!session || unique.has(session)) return false;
        unique.add(session);
        return PartyAwareness.isPartySession(session, leaderSession) &&
            (includeDead || isAlive(session));
    });
}

function npcById(id) {
    const numericId = Number(id || 0);
    if (!numericId) return null;
    return (world().npc?.spawns || []).find((npc) => Number(npc?.fetchId?.()) === numericId) || null;
}

function isHostileNpc(npc) {
    return !!npc && npc.fetchAttackable?.() === true && npc.isDead?.() !== true;
}

function distance2d(a, b) {
    const dx = Number(a?.fetchLocX?.() || 0) - Number(b?.fetchLocX?.() || 0);
    const dy = Number(a?.fetchLocY?.() || 0) - Number(b?.fetchLocY?.() || 0);
    return Math.sqrt((dx * dx) + (dy * dy));
}

// A monster still standing over a corpse is a real resurrection danger.  Its
// lingering combat flag after the party has moved on is not.  Keep this close
// to the normal threat radius so a stale target cannot strand a party forever.
const CORPSE_COMBAT_DANGER_DISTANCE = 1400;

function travellingPull(leaderSession) {
    const pull = leaderSession?.partyPullState || {};
    return {
        active: ['approach', 'aggro', 'return'].includes(pull.phase),
        pullerId: Number(pull.pullerId || 0) || null,
        targetId: Number(pull.targetId || 0) || null
    };
}

function ignoredPullAction(session, pull, options) {
    if (!options.ignoreTravellingPuller || !pull.active) return false;
    return actorId(session?.actor) === pull.pullerId;
}

function activeActionTarget(session) {
    const actor = session?.actor;
    const state = actor?.state;
    if (!state?.fetchHits?.() && !state?.fetchCasts?.()) return null;

    // StateModel keeps these flags as bare booleans.  They can survive an
    // aborted queue, so only treat them as combat when their current target
    // is still a living, attackable NPC.
    const target = npcById(actor?.fetchDestId?.());
    return isHostileNpc(target) ? target : null;
}

function combatState(leaderSession, options = {}) {
    const members = partySessions(leaderSession, { includeDead: true });
    const living = members.filter(isAlive);
    const pull = travellingPull(leaderSession);
    const ignoredTargetIds = new Set((options.ignoreTargetIds || [])
        .map((id) => Number(id || 0))
        .filter(Boolean));

    const threat = PartyAwareness.findThreatTargetingParty(leaderSession);
    if (threat?.actor && !ignoredTargetIds.has(actorId(threat.actor))) {
        const isTravellingPullTarget = pull.active &&
            options.ignoreTravellingPuller === true &&
            actorId(threat.actor) === pull.targetId &&
            Number(threat.targetId || 0) === pull.pullerId;
        if (!isTravellingPullTarget) {
            return { active: true, reason: 'threat_targeting_party', target: threat.actor };
        }
    }

    const leaderTargetId = PartyAwareness.leaderCombatTargetId(leaderSession);
    if (leaderTargetId && !ignoredTargetIds.has(Number(leaderTargetId))) {
        return { active: true, reason: 'leader_targeting_hostile', target: npcById(leaderTargetId) };
    }

    for (const memberSession of living) {
        if (ignoredPullAction(memberSession, pull, options)) continue;
        const target = activeActionTarget(memberSession);
        if (target && !ignoredTargetIds.has(actorId(target))) {
            return { active: true, reason: 'member_action_against_hostile', target, memberSession };
        }
    }

    // A mob may keep its combat state on a corpse immediately after the
    // lethal hit. Include dead members here so a resurrection cannot begin
    // in front of that mob, while still ignoring stale action flags.
    const fallenMembers = members.filter((member) => !isAlive(member));
    const fallenIds = new Set(fallenMembers.map((member) => actorId(member.actor)).filter(Boolean));
    const attackingCorpse = (world().npc?.spawns || []).find((npc) => (
        isHostileNpc(npc) &&
        npc.state?.fetchCombats?.() === true &&
        fallenIds.has(Number(npc.fetchDestId?.() || 0)) &&
        fallenMembers.some((member) => distance2d(npc, member.actor) <= CORPSE_COMBAT_DANGER_DISTANCE) &&
        !ignoredTargetIds.has(actorId(npc))
    ));
    if (attackingCorpse) {
        return { active: true, reason: 'hostile_combat_record', target: attackingCorpse };
    }

    return { active: false, reason: null, target: null };
}

module.exports = {
    partySessions,
    combatState,
    isActive(leaderSession, options) {
        return combatState(leaderSession, options).active;
    }
};
