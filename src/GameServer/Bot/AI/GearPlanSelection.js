// One re-plan of a bot's gear plan: failure check and cooldowns, weapon or
// armour bridge, source availability, replacement or a fresh plan, the craft
// that is nearly ready, then finalization. The cold worker, the main-thread
// resolve and the party requirement refresh all use it; `planningOptions`
// carries what differs between them: the offers (the worker's NPC catalogue,
// live offers on the main thread) and the bot's own buy-order escrow.
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const OfferOrder = invoke('GameServer/Bot/Economy/OfferOrder');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');

const planningCache = new Map();
function selectAcquisitionPlan(state, previousPlan, { spots = [], occupancy, timestamp = Date.now(), planningOptions = {} } = {}) {
    const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(state, {
        spots, occupancy, timestamp, board: planningOptions.board
    });
    const chosen = economy.network.queue.find(wish => wish.key === economy.network.focus?.[0]);
    const wishTargetId = chosen?.object?.slot ? chosen.object.itemId : null;
    const activity = economy.network.activity;
    const activeGear = wishTargetId && activity?.rootKey === chosen.key
        && ['hunting', 'shopping', 'crafting'].includes(activity.activity) && activity.kind !== 'production';
    if (!activeGear && !GearAcquisitionPlanner.isClanOwnedPlan(previousPlan)) {
        // Acquisition metadata remains resumable, but cannot override the
        // common engine's book, social, sale or production activity.
        return { acquisitionPlan: { ...previousPlan, status: 'deferred', strategy: 'none', next: null,
            reason: 'wish_focus', economyInputKey: economy.inputKey }, replanContext: {},
            reusablePartyRequest: false, excludedSpotIds: SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp) };
    }
    const bag = Object.values(state.inventory || {}).filter(row => row.equipped || row.equippedCount)
        .map(row => [row.selfId, row.enchant, row.slot].join(':')).sort().join(',');
    const materials = (previousPlan?.materials || []).map(row => [row.selfId,
        Math.min(row.amount, Number(state.inventory?.[row.selfId]?.amount || 0))].join(':')).join(',');
    const key = [state.level, state.stats?.classId, bag, materials, wishTargetId,
        chosen?.funded, activity?.key, previousPlan?.status, previousPlan?.acquisitionProgress?.failures,
        previousPlan?.target?.selfId, state.stats?.partyRequest?.status,
        state.stats?.clanEquipmentOrder?.revision].join('|');
    const held = planningCache.get(state.characterId);
    if (held?.key === key && held.spots === spots && !state.stats?.lastResolveDebug?.failed) {
        // A transport copy retains the current native progress/claims; only
        // the expensive choice is cached, never a stale whole state.
        return { ...held.result, acquisitionPlan: previousPlan || held.result.acquisitionPlan };
    }
    const excludedSpotIds = SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp);
    // Equal-price towns are ranked from the bot's hunting ground, for every caller.
    const origin = OfferOrder.farmingOrigin(state, (spotId) => SpotIndex.spotById(spots, spotId));
    const planOptions = { ...planningOptions, excludedSpotIds, origin, wishTargetId };
    const clanRaidPlan = GearAcquisitionPlanner.isClanOwnedPlan(previousPlan)
        && previousPlan?.next?.sourceKind === 'raid';
    if (clanRaidPlan) planOptions.allowRaidSources = true;
    const replanContext = GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
    const weaponBridgePlan = !GearAcquisitionPlanner.combatReadiness(state).hasWeapon
        ? GearAcquisitionPlanner.npcEquipmentBridgePlan(state, planOptions) : null;
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
    const result = { acquisitionPlan: { ...acquisitionPlan, economyInputKey: economy.inputKey },
        replanContext, reusablePartyRequest, excludedSpotIds };
    planningCache.set(state.characterId, { key, spots, previous: result.acquisitionPlan, result });
    return result;
}

module.exports = { selectAcquisitionPlan };
