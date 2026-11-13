// A plan serving another clan's goal than the bot's clan (clanId): membership drops it.
function foreignGoal(state, plan, clanId = Number(state?.stats?.clanId || 0)) {
    return Number(plan?.clanGoal?.clanId || 0) > 0 && Number(plan.clanGoal.clanId) !== clanId;
}

// Membership is authoritative; joining keeps unrelated personal acquisition.
function reconcileState(state, clanId = Number(state?.stats?.clanId || 0)) {
    const current = state.stats || {};
    const foreign = foreignGoal(state, current.equipmentPlan, clanId);
    const request = current.partyRequest;
    const invalidRequest = Number(request?.clanId || 0) > 0 && Number(request.clanId) !== clanId;
    const invalidObjective = current.clanPartyObjective && Number(current.clanPartyObjective.clanId) !== clanId;
    if (Number(current.clanId || 0) === clanId && !foreign && !invalidRequest && !invalidObjective) return state;
    const stats = { ...current, clanId };
    let activity = state.activity;
    if (foreign) {
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

function reconcileParty(party) { return party; }

function activeGoalKeys(clanState = {}) {
    return new Set([clanState.goal, clanState.productionGoal].filter(goal => goal?.goalKey
        && !['completed', 'cancelled', 'failed', 'abandoned'].includes(goal.status)).map(goal => goal.goalKey));
}

function activeRaidGoalKeys(parties = []) {
    return new Set((parties || []).filter((party) => {
        const objective = party?.stats?.objective;
        const started = (objective?.sourceKind === 'raid' || objective?.raidBoss === true)
            && (['preparing', 'ready'].includes(party?.stats?.raidPreparation?.status)
                || party?.stats?.raidEncounter?.status === 'active');
        const minPartySize = Math.max(2, Number(objective?.minPartySize) || 7);
        return party?.status !== 'dissolved'
            && started
            && !['defeated', 'failed'].includes(party?.stats?.raidEncounter?.status)
            && (party?.memberIds || []).length >= minPartySize
            && objective?.clanGoalKey;
    }).map((party) => party.stats.objective.clanGoalKey));
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

module.exports = { foreignGoal, reconcileState, reconcileParty, activeGoalKeys, activeRaidGoalKeys,
    reconcileGoals, preserveGoalInvalidation };
