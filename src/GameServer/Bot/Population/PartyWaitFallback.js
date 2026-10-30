// A bot whose gear needs a party asks for one and hunts a safe spot while it
// waits. One rule for the cold worker (planLifecycle), the route search
// (BotRoute.choose) and the command resolve (PopulationService.resolveColdState).
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');

// It waits while its party request is required (a party-only source, or a
// clan hunt), or was deferred while its plan still needs a party. A bot in a
// party does not wait.
function waiting(state, plan, partyRequest) {
    if (state?.party?.partyId) return false;
    if (partyRequest?.materialParty && partyRequest.suspendedFor) return false;
    if (partyRequest?.priority === 'required') return true;
    return partyRequest?.status === 'deferred'
        && (plan?.partyNeed === 'required' || plan?.requiresParty === true);
}

// Where it hunts meanwhile: the plan's own safe fallback, with the NPC to farm
// there, when the bot may hunt it; otherwise ordinary level ground chosen
// without the plan (a fitting current spot is kept). hasRoom (ROUTE-ROOM-3):
// a planned spot other than the bot's own with no room for it is no fallback,
// and the level search takes the filter too. The worker passes its own; main
// passes none and reads main's world index (SpotProfiles.defaultRoomFilter,
// ROUTE-ROOM-4). Null when neither exists.
function spotFor(state, plan, profiles, { excludedSpotIds, timestamp, hasRoom: given = null, spotHunters = null } = {}) {
    const hasRoom = given ?? SpotProfiles.defaultRoomFilter(state, profiles);
    const planned = GearAcquisitionPlanner.safeFallbackForPlan(state, plan, profiles, { excludedSpotIds });
    const plannedSpot = planned ? SpotIndex.spotById(profiles, planned.spotId) : null;
    const refused = !!plannedSpot && !!hasRoom && String(plannedSpot.id) !== String(state.spotId || '')
        && !hasRoom(plannedSpot.id);
    if (plannedSpot && !refused && LevelingRoutes.isSpotAllowedForState(plannedSpot, state)) {
        return { spot: plannedSpot, npcId: Number(planned.npcId || 0) };
    }
    const spot = SpotProfiles.findForState({
        ...state,
        spotId: null,
        stats: Object.fromEntries(Object.entries(state.stats || {})
            .filter(([key]) => key !== 'equipmentPlan'))
    }, { profiles, excludedSpotIds, timestamp, ...(hasRoom ? { hasRoom } : {}), ...(spotHunters ? { spotHunters } : {}) });
    return spot ? { spot, npcId: 0 } : null;
}

module.exports = { waiting, spotFor };
