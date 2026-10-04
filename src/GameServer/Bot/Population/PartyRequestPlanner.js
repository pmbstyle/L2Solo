const Config = invoke('GameServer/Bot/Population/PopulationConfig');

// How long an open party request may wait for a group, by its priority.
function maxAgeMs(priority) {
    return priority === 'required'
        ? Math.max(30000, Number(Config.partyRequestMaxAgeMs) || 15 * 60 * 1000)
        : Math.max(30000, Number(Config.partyPreferredMaxAgeMs) || 5 * 60 * 1000);
}

// How long an expired request rests before the bot asks again.
function cooldownMs() {
    return Math.max(30000, Number(Config.partyRequestCooldownMs) || 5 * 60 * 1000);
}

// An open request older than its age is deferred for the cooldown and
// counted as one more attempt; any other request is returned as it is.
function expire(request, now = Date.now()) {
    if (request?.status !== 'open') return request;
    if (now - Number(request.requestedAt || now) < maxAgeMs(request.priority)) return request;
    return {
        ...request,
        status: 'deferred',
        deferredUntil: now + cooldownMs(),
        expiredAt: now,
        attempts: Number(request.attempts || 0) + 1
    };
}

// Party size and level spread: a clan equipment duty sets its own within
// fixed bounds, any other party uses the defaults (the configured sizes
// unless the caller gives its own).
function limitsForObjective(objective = null, defaults = {}) {
    const maxSize = Number(defaults.maxSize ?? Config.partyMaxSize);
    const minSize = Number(defaults.minSize ?? Config.partyMinSize);
    const clanEquipment = objective?.clanOperation === 'equipment'
        && Number(objective?.clanId || 0) > 0;
    if (!clanEquipment) return { maxSize, minSize, levelRange: defaults.levelRange };
    const clanMaxSize = Math.max(2, Math.min(9, Number(objective.maxPartySize) || maxSize));
    return {
        maxSize: clanMaxSize,
        minSize: Math.max(2, Math.min(clanMaxSize, Number(objective.minPartySize) || minSize)),
        levelRange: Math.max(4, Number(objective.levelRange) || 99)
    };
}

// The spot a party for this bot hunts: its objective's, else the next spot of
// an active gear plan, else where the bot is. The SQL prefilter column
// bot_life_state.partyObjectiveSpot follows it with the party request as the
// objective (database/sql/sqlite.sql, migration 51).
function objectiveSpot(state, objective = null) {
    return objective?.spotId
        || (state?.stats?.equipmentPlan?.status === 'active' ? state.stats.equipmentPlan.next?.spotId : null)
        || state?.spotId
        || null;
}

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
    const previous = state?.stats?.partyRequest;
    // Travel and recovery are part of returning to solo hunting. Neither may
    // erase the recruitment cooldown before the bot gets its first fight.
    if (require('./PartyAssemblyRecovery').coolingDown(state, timestamp)) return previous;
    if (plan?.levelingRecovery) return null;
    if (!partyRequestEligible(state)) return null;
    const sharedTarget = previous?.reason === 'shared_target' && ['open', 'deferred'].includes(previous.status)
        && plan?.status === 'active' && previous.spotId === plan.next?.spotId
        && Number(previous.npcId) === Number(plan.next?.npcId || plan.targetNpcId)
        ? { ...previous, status: 'open' } : null;
    const objective = clanPartyObjectiveForState(state) || partyObjectiveForPlan(plan) || sharedTarget;
    if (!objective) return null;
    const sameRequest = ['open', 'deferred'].includes(previous?.status)
        && previous.objectiveKey === objective.objectiveKey
        && Number(previous.itemId || 0) === Number(objective.itemId || 0)
        && Number(previous.targetId || 0) === Number(objective.targetId || 0);
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

    if (sameRequest && previous.status === 'open') {
        const kept = {
            ...objective,
            status: 'open',
            requestedAt: previousRequestedAt,
            attempts: previousAttempts,
            lastMatchedAt: previous.lastMatchedAt || null
        };
        const expired = expire(kept, timestamp);
        if (expired !== kept) return expired;
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
    if (require('./PartyAssemblyRecovery').coolingDown(state)) return null;
    if (state?.stats?.equipmentPlan?.levelingRecovery) return null;
    const request = state?.stats?.partyRequest;
    const clanObjective = clanPartyObjectiveForState(state);
    if (clanObjective?.status === 'open') {
        if (request?.status === 'open'
            && String(request.clanGoalKey || '') === String(clanObjective.clanGoalKey || '')) {
            return { ...request, ...clanObjective, requestedAt: request.requestedAt || clanObjective.requestedAt };
        }
        return clanObjective;
    }
    if (request) {
        return request.status === 'open' ? request : null;
    }
    return partyObjectiveForPlan(state?.stats?.equipmentPlan) || clanObjective;
}

module.exports = {
    maxAgeMs,
    cooldownMs,
    expire,
    limitsForObjective,
    objectiveSpot,
    partyObjectiveForPlan,
    clanPartyObjectiveForState,
    partyRequestForPlan,
    partyObjectiveForState
};
