// One re-plan of a bot's gear plan: failure check and cooldowns, weapon or
// armour bridge, source availability, replacement or a fresh plan, the craft
// that is nearly ready, then finalization. The cold worker, the main-thread
// resolve and the party requirement refresh all use it; only the offers
// differ (`planningOptions`: the worker's NPC catalogue, live offers on the
// main thread).
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');

function selectAcquisitionPlan(state, previousPlan, { spots = [], occupancy, timestamp = Date.now(), planningOptions = {} } = {}) {
    const excludedSpotIds = SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp);
    const planOptions = { ...planningOptions, excludedSpotIds };
    const clanRaidPlan = GearAcquisitionPlanner.isClanOwnedPlan(previousPlan)
        && previousPlan?.next?.sourceKind === 'raid';
    if (clanRaidPlan) planOptions.allowRaidSources = true;
    const replanContext = GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
    const weaponBridgePlan = GearAcquisitionPlanner.npcEquipmentBridgePlan(state, planOptions);
    const clanGoalLocked = !weaponBridgePlan
        && GearAcquisitionPlanner.clanGoalPlanLocked(state, previousPlan);
    const availabilitySource = !replanContext.failure && previousPlan?.status === 'active'
        && ['direct_drop', 'craft'].includes(previousPlan.strategy)
        ? GearAcquisitionPlanner.bestSourceForPlan(state, previousPlan, spots, {
            occupancy, excludedSpotIds, allowRaidSources: clanRaidPlan
        })
        : null;
    const availabilityRouteChanged = availabilitySource && (
        String(availabilitySource.spotId || '') !== String(previousPlan?.next?.spotId || '')
        || Number(availabilitySource.npcId || 0) !== Number(previousPlan?.next?.npcId || 0)
    );
    const availabilityPlan = weaponBridgePlan || (previousPlan?.status === 'blocked' && !clanGoalLocked
        ? GearAcquisitionPlanner.replacementPlanFor(state, previousPlan, spots, {
            occupancy,
            ...replanContext,
            ...planOptions
        })
        : availabilityRouteChanged
            ? GearAcquisitionPlanner.retargetPlanSource(state, previousPlan, availabilitySource)
            : previousPlan?.status === 'active'
            && ['direct_drop', 'craft'].includes(previousPlan.strategy)
            && !clanGoalLocked
                ? GearAcquisitionPlanner.replacementPlanFor(state, previousPlan, spots, {
                    occupancy,
                    ...replanContext,
                    ...planOptions
                })
                : null);
    const reusablePartyRequest = !weaponBridgePlan
        && !state.party?.partyId
        && previousPlan?.next
        && !!availabilitySource
        && replanContext.routeCurrent
        && !replanContext.failure
        && state.stats?.partyRequest?.status === 'open'
        && Number(state.stats.partyRequest.reviewAt || 0) > timestamp
        && !GearAcquisitionPlanner.fundedMarketPlanForTarget(state, previousPlan.target?.selfId, planOptions);
    const upgradedPlan = availabilityPlan || (
        reusablePartyRequest || clanGoalLocked
            ? previousPlan
            : GearAcquisitionPlanner.planFor(state, { spots, occupancy, ...replanContext, ...planOptions })
    );
    const previousRefresh = previousPlan?.recipeId && !reusablePartyRequest && !clanGoalLocked
        ? GearAcquisitionPlanner.planFor(state, {
            spots,
            occupancy,
            recipeId: previousPlan.recipeId,
            ...replanContext,
            ...planOptions
        })
        : null;
    const rawPlan = GearAcquisitionPlanner.shouldFinishPreviousPlan(previousPlan, previousRefresh)
        ? { ...previousRefresh, finishBeforeUpgrade: true }
        : upgradedPlan;
    const canFinalizeLockedRoute = clanGoalLocked && availabilityRouteChanged;
    const finalizationContext = weaponBridgePlan
        ? { ...replanContext, allowClanGoalReplan: true }
        : canFinalizeLockedRoute
        ? { ...replanContext, allowClanGoalReplan: true }
        : replanContext;
    const preservePreviousPlan = !weaponBridgePlan
        && (reusablePartyRequest || (clanGoalLocked && !canFinalizeLockedRoute));
    const finalizedPlan = preservePreviousPlan
        ? previousPlan
        : GearAcquisitionPlanner.finalizePlan(state, previousPlan, rawPlan, finalizationContext, timestamp);
    const costedPlan = GearAcquisitionPlanner.withMaterialFarmEffort(finalizedPlan, state, spots, { occupancy });
    const acquisitionPlan = {
        ...costedPlan,
        marketFallback: finalizedPlan.status === 'active' && finalizedPlan.strategy === 'craft'
            && Number(finalizedPlan.acquisitionProgress?.at || finalizedPlan.startedAt || timestamp) + 20 * 60 * 1000 <= timestamp
    };
    return { acquisitionPlan, replanContext, reusablePartyRequest, excludedSpotIds };
}

module.exports = { selectAcquisitionPlan };
