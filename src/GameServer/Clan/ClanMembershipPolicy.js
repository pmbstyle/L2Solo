// Membership is authoritative; an old solo plan must not survive joining a clan.
function reconcileState(state, clanId = Number(state?.stats?.clanId || 0)) {
    const current = state.stats || {};
    const plan = current.equipmentPlan;
    const foreignGoal = Number(plan?.clanGoal?.clanId || 0) > 0 && Number(plan.clanGoal.clanId) !== clanId;
    const personalCraft = require('./ClanCraftingPolicy').isPersonalCraft({ clanId }, plan);
    const request = current.partyRequest;
    const invalidRequest = (Number(request?.clanId || 0) > 0 && Number(request.clanId) !== clanId)
        || (clanId > 0 && request?.strategy === 'craft' && !request.clanGoalKey);
    const invalidObjective = current.clanPartyObjective && Number(current.clanPartyObjective.clanId) !== clanId;
    if (Number(current.clanId || 0) === clanId && !foreignGoal && !personalCraft && !invalidRequest && !invalidObjective) return state;
    const stats = { ...current, clanId };
    let activity = state.activity;
    if (personalCraft || foreignGoal) {
        delete stats.equipmentPlan;
        delete stats.craftReturn;
        delete stats.clanMaterialDemand;
        if (/^(equipment_craft|component_craft|dual_sword_combine)/.test(stats.travel?.reason || '')) {
            delete stats.travel;
            if (activity === 'traveling') activity = 'hunting';
        }
        if (activity === 'crafting' && !stats.craftShop && !stats.craftStationId) activity = 'hunting';
    }
    if (invalidRequest) delete stats.partyRequest;
    if (invalidObjective) delete stats.clanPartyObjective;
    return { ...state, activity, stats };
}

function reconcileParty(party, leaderClanId) {
    const objective = party.stats?.objective;
    if (!Number(leaderClanId) || objective?.strategy !== 'craft' || objective.clanGoalKey) return party;
    const stats = { ...party.stats, objective: null, acquisitionGoal: null, lastRequirementRefreshAt: 0 };
    return { ...party, stats };
}

function activeGoalKeys(clanState = {}) {
    return new Set([clanState.goal, clanState.productionGoal].filter(goal => goal?.goalKey
        && !['completed', 'cancelled', 'failed', 'abandoned'].includes(goal.status)).map(goal => goal.goalKey));
}

function reconcileGoals(state, keys) {
    const current = state.stats || {};
    const stalePlan = current.equipmentPlan?.clanGoal?.goalKey
        && !keys.has(current.equipmentPlan.clanGoal.goalKey);
    const staleObjective = current.clanPartyObjective?.clanGoalKey && !keys.has(current.clanPartyObjective.clanGoalKey);
    const staleRequest = current.partyRequest?.clanGoalKey && !keys.has(current.partyRequest.clanGoalKey);
    if (!stalePlan && !staleObjective && !staleRequest) return state;
    const stats = { ...current };
    let activity = state.activity;
    if (stalePlan) {
        delete stats.equipmentPlan;
        delete stats.craftReturn;
        if (/^(equipment_craft|component_craft|dual_sword_combine)/.test(stats.travel?.reason || '')) {
            delete stats.travel;
            if (activity === 'traveling') activity = 'hunting';
        }
        if (activity === 'crafting' && !stats.craftShop && !stats.craftStationId) activity = 'hunting';
    }
    if (staleObjective) delete stats.clanPartyObjective;
    if (staleRequest) delete stats.partyRequest;
    if (!stats.equipmentPlan?.clanGoal && !stats.clanPartyObjective) delete stats.clanMaterialDemand;
    if (activity === 'party_wait' && !stats.partyRequest && !state.partyId && !state.party?.partyId) activity = 'hunting';
    return { ...state, activity, stats };
}

// A delayed hot/cold save must not restore the plan cleared by a newer repair.
function preserveGoalInvalidation(state, current = {}) {
    if (Number(current.clanGoalInvalidationVersion || 0) <= Number(state.stats?.clanGoalInvalidationVersion || 0)) return state;
    const stats = { ...state.stats };
    for (const key of ['clanGoalInvalidationVersion', 'equipmentPlan', 'craftReturn',
        'clanMaterialDemand', 'clanPartyObjective', 'partyRequest']) {
        if (Object.hasOwn(current, key)) stats[key] = current[key];
        else delete stats[key];
    }
    if (/^(equipment_craft|component_craft|dual_sword_combine)/.test(stats.travel?.reason || '') && !stats.equipmentPlan) {
        delete stats.travel;
        return { ...state, activity: 'hunting', stats };
    }
    return { ...state, stats };
}

module.exports = { reconcileState, reconcileParty, activeGoalKeys, reconcileGoals, preserveGoalInvalidation };
