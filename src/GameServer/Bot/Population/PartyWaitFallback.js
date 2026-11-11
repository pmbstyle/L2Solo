// A bot whose gear needs a party asks for one and hunts a safe spot while it
// waits. One rule: the route search (BotRoute.choose) picks that spot, the
// cold worker (planLifecycle) reads whether the bot waits.
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');

// It waits while its party request is required (a party-only source, or a
// clan hunt), or was closed while its plan still needs a party. A bot in a
// party does not wait.
function waiting(state, plan, partyRequest) {
    if (state?.party?.partyId) return false;
    if (partyRequest?.materialParty && partyRequest.suspendedFor) return false;
    if (partyRequest?.priority === 'required') return true;
    return partyRequest?.status === 'closed'
        && (plan?.partyNeed === 'required' || plan?.requiresParty === true);
}

// Where it hunts meanwhile: the plan's own safe fallback, with the NPC to farm
// there, when the bot may hunt it; otherwise ordinary level ground chosen
// without the plan (a fitting current spot is kept). The crowd is met at
// arrival. Null when neither exists.
function spotFor(state, plan, profiles, { excludedSpotIds, timestamp } = {}) {
    const planned = GearAcquisitionPlanner.safeFallbackForPlan(state, plan, profiles, { excludedSpotIds });
    const plannedSpot = planned ? SpotIndex.spotById(profiles, planned.spotId) : null;
    if (plannedSpot && LevelingRoutes.isSpotAllowedForState(plannedSpot, state)) {
        return { spot: plannedSpot, npcId: Number(planned.npcId || 0) };
    }
    const spot = SpotProfiles.findForState({
        ...state,
        spotId: null,
        stats: Object.fromEntries(Object.entries(state.stats || {})
            .filter(([key]) => key !== 'equipmentPlan'))
    }, { profiles, excludedSpotIds, timestamp });
    return spot ? { spot, npcId: 0 } : null;
}

module.exports = { waiting, spotFor };
