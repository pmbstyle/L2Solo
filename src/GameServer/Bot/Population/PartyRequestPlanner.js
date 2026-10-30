const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Material = require('./CraftMaterialParty');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const Roles = invoke('GameServer/Bot/AI/BotRoles');

// No solo ground -> a party (decision 10-30, T106): a healer or buffer
// (BotRoles) whose solo gate admits no spot near its level
// (BotRoute.soloGroundMissing) seeks a party instead of farming grey ground
// alone. Read by the worker's step (no card reuse for it: its request is
// planned) and by the request below.
const NO_SOLO_GROUND = 'no_solo_ground';
function supportWithoutGround(state, spots) {
    return (Roles.isHealer(state) || Roles.canBuff(state))
        && invoke('GameServer/Bot/Population/BotRoute').soloGroundMissing(state, spots); // lazy: cycle BotRoute's chain loads this planner
}

// A bot whose open request is that seeking (main's party assembly reads it:
// the persona's intent, the recruitment across parties).
function seeksParty(state) {
    const request = state?.stats?.partyRequest;
    return request?.status === 'open' && request.reason === NO_SOLO_GROUND;
}

// The seeking objective: a party of its level meets at the spot a party
// search finds for it (mode party: the level fit and the group's matchup,
// not its solo gate), so it groups with the bots that hunt there
// (objectiveKey = their spot key) and joins parties that hunt there. The
// spot holds while the request is open or cools down; a reopened request
// searches again. Null: no such seeker, or no spot.
function seekObjective(state, previous, { spots, timestamp }) {
    if (!supportWithoutGround(state, spots)) return null;
    const held = previous?.reason === NO_SOLO_GROUND && (previous.status === 'open'
        || previous.status === 'deferred' && Number(previous.deferredUntil || 0) > timestamp) ? previous.spotId : null;
    // lazy: cycle SpotProfiles' chain loads this planner
    const searched = held ? null : invoke('GameServer/Bot/Population/SpotProfiles').findForState({ ...state, spotId: null,
        stats: Object.fromEntries(Object.entries(state.stats || {}).filter(([key]) => key !== 'equipmentPlan')) },
    { profiles: spots, mode: 'party', timestamp });
    const spotId = held || searched?.id || null;
    if (!spotId) return null;
    return { status: 'open', priority: 'preferred', objectiveKey: `spot:${spotId}`, reason: NO_SOLO_GROUND,
        spotId, npcId: null, itemId: null, targetId: null };
}

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
    if (objective?.opportunisticRaid === true) return { minSize: 9, maxSize: 9, levelRange: 7 };
    const maxSize = Number(defaults.maxSize ?? Config.partyMaxSize);
    const minSize = Number(defaults.minSize ?? Config.partyMinSize);
    if (objective?.fullRoster) return { maxSize: 9, minSize: 9, levelRange: defaults.levelRange ?? 99 };
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
        partyPreference: plan.clanGoal?.partyPreference || null,
        ...(plan.clanGoal?.fullRoster ? { fullRoster: plan.clanGoal.fullRoster, minPartySize: 9, maxPartySize: 9 } : {})
    };
}

function partyRequestEligible(state) {
    return !require('./RaidSupplyPolicy').held(state) && !state?.party?.partyId
        && ['hunting', 'resting', 'party_wait'].includes(state?.activity);
}

function clanPartyObjectiveForState(state) {
    const objective = state?.stats?.clanPartyObjective;
    return objective && ['open', 'deferred'].includes(objective.status) ? objective : null;
}

// options: spots, economy (the bot's own economy, built in the background
// thread; required, no build here) and memo (the bot's worker record).
function partyRequestForPlan(state, plan, timestamp = Date.now(), options = {}) {
    const previous = state?.stats?.partyRequest;
    const supplyPause = Material.supplyPause(state, plan, { ...options, timestamp });
    if (supplyPause) return supplyPause;
    // Travel and recovery are part of returning to solo hunting. Neither may
    // erase the recruitment cooldown before the bot gets its first fight.
    if (invoke('GameServer/Bot/Population/PartyAssemblyRecovery').coolingDown(state, timestamp)) {
        if (!previous.suspendedFor) return previous;
        const { suspendedFor, ...held } = previous;
        return held;
    }
    if (plan?.levelingRecovery) return null;
    if (!partyRequestEligible(state)) return null;
    const sharedTarget = previous?.reason === 'shared_target' && ['open', 'deferred'].includes(previous.status)
        && plan?.status === 'active' && previous.spotId === plan.next?.spotId
        && Number(previous.npcId) === Number(plan.next?.npcId || plan.targetNpcId)
        ? { ...previous, status: 'open' } : null;
    let objective = clanPartyObjectiveForState(state) || partyObjectiveForPlan(plan)
        || Material.request(state, plan, { ...options, timestamp }) || sharedTarget
        || seekObjective(state, previous, { spots: options.spots, timestamp });
    if (objective?.priority === 'required' && objective.itemId && !objective.clanGoalKey && !objective.helpDeal) {
        const context = options.economy;
        const amount = Math.max(1, Math.floor(Number(objective.materialParty ? objective.amount : plan?.next?.amount || 1)));
        // ARCH-NOTE: party value is pending; the help fee buys progress on its requested item.
        const fee = Math.floor(Math.min(invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(state, 0, { itemId: objective.itemId }),
            Math.max(0, Number(context.worth(objective.itemId)) || 0) * amount));
        if (fee > 0) objective = { ...objective, helpDeal: { payerId: Number(state.characterId),
            itemId: Number(objective.itemId), count: amount, fee } };
    }
    if (!objective) return null;
    const sameRequest = ['open', 'deferred'].includes(previous?.status)
        && previous.objectiveKey === objective.objectiveKey
        && Number(previous.itemId || 0) === Number(objective.itemId || 0)
        && Number(previous.targetId || 0) === Number(objective.targetId || 0);
    // Camp changes restart the waiting window, but retain this material
    // operation's failed assemblies so every bounded alternative is visited.
    const sameMaterialNeed = Material.isObjective(previous) && Material.isObjective(objective)
        && Number(previous.itemId) === Number(objective.itemId)
        && Number(previous.targetId) === Number(objective.targetId);
    const previousRequestedAt = sameRequest ? Number(previous.requestedAt || timestamp) : timestamp;
    const previousAttempts = sameRequest || sameMaterialNeed ? Number(previous.attempts || 0) : 0;

    if ((sameRequest || sameMaterialNeed) && previous.status === 'deferred' && Number(previous.deferredUntil || 0) > timestamp) {
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

    if (objective.reason === NO_SOLO_GROUND && !(sameRequest && previous.status === 'open')) {
        Diagnostics.count('party_seek', NO_SOLO_GROUND, 'seeking');
    }
    return {
        ...objective,
        status: 'open',
        requestedAt: sameRequest && previous.status === 'open' ? previousRequestedAt : timestamp,
        reviewAt: timestamp + Math.max(30000, Number(Config.partyWaitReplanMs) || 5 * 60 * 1000),
        attempts: previousAttempts,
        lastMatchedAt: sameRequest ? previous.lastMatchedAt || null : null
    };
}

function partyObjectiveForState(state) {
    if (invoke('GameServer/Bot/Population/PartyAssemblyRecovery').coolingDown(state)) return null;
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
    NO_SOLO_GROUND,
    supportWithoutGround,
    seeksParty,
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
