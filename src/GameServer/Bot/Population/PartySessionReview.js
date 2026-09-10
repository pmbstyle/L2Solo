const MINUTE = 60000;
const clamp = n => Math.max(0, Math.min(1, Number(n) || 0));

// A timer schedules a conversation, not a forced disband. No random rolls:
// rereading the same persisted evidence produces the same individual decisions.
function assess(party, members, timestamp, options = {}) {
    const previous = party.stats?.sessionReview || {};
    const interval = Math.max(MINUTE, Number(options.partyReviewIntervalMs) || 5 * MINUTE);
    const nextAt = timestamp + interval;
    const wins = Number(party.stats?.fightsWon || 0);
    const fights = Number(party.stats?.fightsResolved || 0);
    const progressAt = Number(party.stats?.lastProgressAt || 0);
    const gained = previous.at && wins > Number(previous.wins || 0);
    const noProgressSince = gained || (progressAt > Number(previous.noProgressSince || 0))
        ? Math.max(progressAt, gained ? timestamp : 0)
        : Number(previous.noProgressSince || timestamp);
    const attemptsSinceProgress = gained || progressAt > Number(previous.noProgressSince || 0) ? 0
        : Number(previous.attemptsSinceProgress || 0) + Math.max(0, fights - Number(previous.fights ?? fights));
    const profitable = (gained || progressAt > 0) && timestamp - noProgressSince < 2 * interval;
    const paused = party.stats?.travel || Number(party.stats?.restUntil || 0) > timestamp;
    const target = Number(party.stats?.objective?.npcId || party.stats?.acquisitionGoal?.next?.npcId || 0);
    const concerns = {}, decisions = [];
    for (const member of members) {
        const traits = (options.personaFor?.(member) || member.persona)?.traits || {};
        const commitment = clamp(traits.commitment ?? 0.5), caution = clamp(traits.caution ?? 0.5);
        const social = clamp(traits.sociability ?? 0.5), empathy = clamp(traits.empathy ?? 0.5);
        let friendly = false, hostile = false, memoryReady = true;
        for (const peer of members) {
            if (peer.characterId === member.characterId) continue;
            const relation = options.assessRelationship?.({ id: member.characterId }, { id: peer.characterId }, {}, timestamp);
            if (!relation?.ready) { memoryReady = false; continue; }
            friendly ||= relation.disposition === 'friendly';
            hostile ||= relation.disposition === 'hostile' || relation.diplomaticEnemy === true;
            friendly ||= Number(relation.effective?.trust || 0) >= 5;
            hostile ||= Number(relation.effective?.hostility || 0) >= 10;
        }
        const plan = member.stats?.equipmentPlan;
        const active = plan?.status === 'active' && !!plan.next?.spotId;
        const sameTarget = active && ((target > 0 && Number(plan.next?.npcId || plan.targetNpcId) === target)
            || plan.next.spotId === party.spotId);
        const clanObjective = member.stats?.clanPartyObjective;
        const sharedClan = clanObjective?.status === 'open' && !!clanObjective.clanGoalKey
            && clanObjective.clanGoalKey === party.stats?.objective?.clanGoalKey;
        const helping = friendly && (empathy + commitment >= 1.2);
        const patience = (8 + commitment * 8 + (friendly ? social * 6 : 0) - caution * 2) * MINUTE;
        const stalled = attemptsSinceProgress >= 3 && timestamp - noProgressSince >= patience;
        let reason = null;
        if (!paused) {
            if (hostile) reason = 'party_relationship_conflict';
            else if (active && !sameTarget && !sharedClan && !helping
                && (!profitable || plan.requiresParty || plan.partyNeed === 'required')) reason = 'party_goals_diverged';
        }
        // Recovery alone proves nothing, but it must not hide repeated failed
        // fights already observed over the member's patience window.
        if (!reason && stalled) reason = 'party_no_progress';
        const prior = previous.concerns?.[member.characterId];
        const since = prior?.reason === reason ? Number(prior.since) : timestamp;
        // Suspend a goal/conflict grace period while recovering instead of
        // erasing its accumulated evidence on every ordinary rest cycle.
        if (paused && !reason && prior) concerns[member.characterId] = {
            ...prior, since: Number(prior.since) + Math.max(0, timestamp - Number(previous.at || timestamp))
        };
        if (reason) concerns[member.characterId] = { reason, since };
        const grace = reason === 'party_no_progress' ? 0 : (2 + commitment * 4) * MINUTE;
        const leave = !!reason && timestamp - since >= grace;
        decisions.push({ characterId: member.characterId, leave,
            reason: reason || (paused ? 'party_recovering_or_travelling' : sameTarget || sharedClan ? 'party_shared_goal'
                : friendly ? 'party_friends' : 'party_observing_progress'), memoryReady });
    }
    return { decisions, review: { at: timestamp, nextAt, wins, fights, attemptsSinceProgress,
        noProgressSince, concerns,
        decisions } };
}
module.exports = { assess };
