const Config = invoke('GameServer/Bot/Population/PopulationConfig');

function partyObjectiveForPlan(plan) {
    if (!plan || !['active', 'blocked'].includes(plan.status) || !plan.next?.spotId) return null;
    const partyNeed = plan.clanGoal?.partyNeed
        || plan.partyNeed
        || (plan.requiresParty ? 'required' : 'solo_ok');
    if (!['required', 'preferred'].includes(partyNeed)) return null;
    const strategy = plan.strategy || 'acquisition';
    const targetItemId = Number(plan.next.itemId || plan.target?.selfId || 0);
    const npcId = Number(plan.next.npcId || 0);
    // A party hunts a route/NPC, not one item at a time. The item remains in
    // the request for personal reward tracking, but it must not fragment all
    // bots killing the same dropper into incompatible groups.
    const objectiveKey = npcId > 0
        ? [strategy, plan.next.spotId, npcId].join(':')
        : [strategy, plan.next.spotId, npcId, targetItemId].join(':');
    return {
        status: 'open',
        priority: partyNeed,
        objectiveKey,
        reason: strategy === 'craft' ? 'craft_material' : 'gear_acquisition',
        partyNeedReason: plan.partyNeedReason || null,
        strategy,
        spotId: plan.next.spotId,
        npcId: npcId || null,
        itemId: targetItemId || null,
        targetId: Number(plan.target?.selfId || 0) || null,
        clanId: Number(plan.clanGoal?.clanId || 0) || null,
        clanGoalKey: plan.clanGoal?.goalKey || null,
        partyPreference: plan.clanGoal?.partyPreference || null
    };
}

function partyRequestEligible(state) {
    return !state?.party?.partyId
        && ['hunting', 'resting', 'party_wait'].includes(state?.activity);
}

function clanPartyObjectiveForState(state) {
    const objective = state?.stats?.clanPartyObjective;
    return objective && ['open', 'deferred'].includes(objective.status) ? objective : null;
}

function partyRequestForPlan(state, plan, timestamp = Date.now()) {
    if (!partyRequestEligible(state)) return null;
    const objective = partyObjectiveForPlan(plan) || clanPartyObjectiveForState(state);
    if (!objective) return null;
    const previous = state.stats?.partyRequest;
    const sameRequest = ['open', 'deferred'].includes(previous?.status)
        && previous.objectiveKey === objective.objectiveKey
        && Number(previous.itemId || 0) === Number(objective.itemId || 0)
        && Number(previous.targetId || 0) === Number(objective.targetId || 0);
    const maxAge = objective.priority === 'required'
        ? Math.max(30000, Number(Config.partyRequestMaxAgeMs) || 15 * 60 * 1000)
        : Math.max(30000, Number(Config.partyPreferredMaxAgeMs) || 5 * 60 * 1000);
    const cooldownMs = Math.max(30000, Number(Config.partyRequestCooldownMs) || 5 * 60 * 1000);
    const previousRequestedAt = sameRequest ? Number(previous.requestedAt || timestamp) : timestamp;
    const previousAttempts = sameRequest ? Number(previous.attempts || 0) : 0;

    if (sameRequest && previous.status === 'deferred' && Number(previous.deferredUntil || 0) > timestamp) {
        return {
            ...objective,
            status: 'deferred',
            requestedAt: previousRequestedAt,
            deferredUntil: Number(previous.deferredUntil),
            expiredAt: Number(previous.expiredAt || 0) || null,
            attempts: previousAttempts,
            lastMatchedAt: previous.lastMatchedAt || null
        };
    }

    if (sameRequest && previous.status === 'open' && timestamp - previousRequestedAt >= maxAge) {
        return {
            ...objective,
            status: 'deferred',
            requestedAt: previousRequestedAt,
            deferredUntil: timestamp + cooldownMs,
            expiredAt: timestamp,
            attempts: previousAttempts + 1,
            lastMatchedAt: previous.lastMatchedAt || null
        };
    }

    return {
        ...objective,
        status: 'open',
        requestedAt: sameRequest && previous.status === 'open' ? previousRequestedAt : timestamp,
        reviewAt: timestamp + Math.max(30000, Number(Config.partyWaitReplanMs) || 5 * 60 * 1000),
        attempts: sameRequest ? previousAttempts : 0,
        lastMatchedAt: sameRequest ? previous.lastMatchedAt || null : null
    };
}

function partyObjectiveForState(state) {
    if (state?.stats?.partyRequest) {
        return state.stats.partyRequest.status === 'open' ? state.stats.partyRequest : null;
    }
    return partyObjectiveForPlan(state?.stats?.equipmentPlan) || clanPartyObjectiveForState(state);
}

module.exports = {
    partyObjectiveForPlan,
    clanPartyObjectiveForState,
    partyRequestForPlan,
    partyObjectiveForState
};
