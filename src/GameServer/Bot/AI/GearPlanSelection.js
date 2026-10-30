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

function deferredWishPlan(previousPlan, replanContext, state, timestamp = Date.now()) {
    const plan = { ...previousPlan, status: 'deferred', strategy: 'none', next: null, reason: 'wish_focus' };
    const pausedInputs = previousPlan?.status === 'deferred' && previousPlan.reason === 'wish_focus' && plan.heldInputs;
    if (state && !previousPlan?.clanGoal?.clanId && plan.target?.selfId) {
        const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
        const preparing = state.stats?.shotCraft?.preparing;
        const productionInputs = Number(preparing?.gearTarget) === Number(plan.target.selfId)
            && preparing.gearInputs && Number(preparing.at) + 30 * 60 * 1000 > timestamp ? preparing.gearInputs : null;
        if (!pausedInputs || productionInputs) {
            delete plan.heldInputs;
            const collected = Disposition.collectedEquipmentInputs(state, plan);
            plan.heldInputs = productionInputs
                ? Disposition.capDeferredInputs({ ...plan, heldInputs: productionInputs }, collected) : collected;
        }
    }
    delete plan.economyInputKey;
    // Consume the native recovery wake/expiry once, retaining the inactive
    // target and its historical stamps for a later acquisition decision.
    if (previousPlan?.recoveryTargets || replanContext.recoveryTargets?.length) plan.recoveryTargets = replanContext.recoveryTargets;
    if (previousPlan?.levelingRecovery && !replanContext.levelingRecovery) delete plan.levelingRecovery;
    return plan;
}

function withBridgeInputPreparation(state, previous, next, timestamp = Date.now()) {
    if (!next?.weaponBridge || !['active', 'deferred'].includes(next.status)) return next;
    const retained = previous?.inputPreparation || previous;
    if (!retained?.target?.selfId || retained.reason === 'cancelled' || previous?.reason === 'cancelled'
        || GearAcquisitionPlanner.isClanOwnedPlan(retained)) return next;
    const Data = invoke('GameServer/DataCache'), Index = invoke('GameServer/Item/ItemTemplateIndex');
    const target = Index.find(Data.items, Number(retained.combine?.resultId || retained.target.selfId));
    const bridge = Index.find(Data.items, Number(next.combine?.resultId || next.target?.selfId));
    const ranks = ['none', 'd', 'c', 'b', 'a', 's'];
    if (!target || !bridge || ranks.indexOf(target.etc?.rank) < 2
        || ranks.indexOf(target.etc?.rank) <= ranks.indexOf(bridge.etc?.rank)
        || !GearAcquisitionPlanner.considerable(target, state)
        || GearAcquisitionPlanner.equipmentTargetFulfilled(state, retained)) return next;
    const inputPreparation = deferredWishPlan({
        target: retained.target, exchange: retained.exchange, recipeId: retained.recipeId,
        materials: retained.materials, combine: retained.combine, heldInputs: retained.heldInputs,
        status: retained.status, reason: retained.reason }, {}, state, timestamp);
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const proposed = { ...state, stats: { ...state.stats, equipmentPlan: { ...next, inputPreparation } } };
    if (!Object.keys(Disposition.retainedEquipmentAmounts(proposed)).length) return next;
    return { ...next, inputPreparation };
}

function selectAcquisitionPlan(state, previousPlan, { spots = [], timestamp = Date.now(), planningOptions = {}, preparedEconomy = null, preparedReplanContext = null } = {}) {
    if (previousPlan?.economyInputKey !== undefined) { previousPlan = { ...previousPlan }; delete previousPlan.economyInputKey; }
    const economy = preparedEconomy || invoke('GameServer/Bot/Economy/EconomyContext').forState(state, {
        spots, timestamp, board: planningOptions.board, buyOrderEscrow: planningOptions.buyOrderEscrow
    });
    const preparedAcquisition = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(state, economy);
    const preparedB = preparedAcquisition?.strategy === 'craft'
        && ['b', 'a', 's'].includes(invoke('GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items,
            preparedAcquisition.target?.selfId)?.etc?.rank);
    if (preparedAcquisition?.strategy === 'luxury_exchange' || preparedB || preparedAcquisition?.combine?.type === 'dual_sword') return {
        acquisitionPlan: { ...preparedAcquisition,
            ...(previousPlan?.clanGoal && Number(previousPlan.target?.selfId) === Number(preparedAcquisition.target?.selfId)
                ? { clanGoal: previousPlan.clanGoal } : {}) }, replanContext: {}, reusablePartyRequest: false,
        excludedSpotIds: SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp), economy };
    const chosen = economy.network.queue.find(wish => wish.key === economy.network.activity?.rootKey)
        || economy.network.queue.find(wish => wish.key === economy.network.focus?.[0]);
    const wishTargetId = chosen?.object?.slot ? chosen.object.itemId : null;
    const activity = economy.network.activity;
    const activeGear = wishTargetId && activity?.rootKey === chosen.key
        && ['hunting', 'shopping', 'crafting'].includes(activity.activity) && activity.kind !== 'production' && !activity.funding;
    if (!activeGear && !GearAcquisitionPlanner.isClanOwnedPlan(previousPlan)) {
        // Acquisition metadata remains resumable, but cannot override the
        // common engine's book, social, sale or production activity.
        const replanContext = preparedReplanContext || GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
        const acquisitionPlan = deferredWishPlan(previousPlan, replanContext, state, timestamp);
        return { acquisitionPlan, replanContext,
            reusablePartyRequest: false, excludedSpotIds: SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp), economy };
    }
    // The selected item's native funding gate reads the packet made by this
    // same review, including the bot's own funded buy-order escrow.
    state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
    const bag = Object.values(state.inventory || {}).filter(row => row.equipped || row.equippedCount)
        .map(row => [row.selfId, row.enchant, row.slot].join(':')).sort().join(',');
    const materials = (previousPlan?.materials || []).map(row => [row.selfId,
        Math.min(row.amount, Number(state.inventory?.[row.selfId]?.amount || 0))].join(':')).join(',');
    const replanContext = preparedReplanContext || GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
    const key = [state.level, state.stats?.classId, bag, materials, wishTargetId,
        chosen?.funded, activity?.key, previousPlan?.status, previousPlan?.acquisitionProgress?.failures,
        previousPlan?.target?.selfId, state.stats?.partyRequest?.status,
        state.stats?.clanEquipmentOrder?.revision, JSON.stringify(replanContext)].join('|');
    const held = economy.gearPlanMemo;
    if (held?.key === key && held.spots === spots && replanContext.routeCurrent
        && !replanContext.failure && !replanContext.invalidSource) {
        // A transport copy retains the current native progress/claims; only
        // the expensive choice is cached, never a stale whole state.
        return { ...held.result, replanContext,
            acquisitionPlan: GearAcquisitionPlanner.finalizePlan(state, previousPlan,
                previousPlan || held.result.acquisitionPlan, replanContext, timestamp), economy };
    }
    const excludedSpotIds = SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp);
    // Equal-price towns are ranked from the bot's hunting ground, for every caller.
    const origin = OfferOrder.farmingOrigin(state, (spotId) => SpotIndex.spotById(spots, spotId));
    const planOptions = { ...planningOptions, excludedSpotIds, origin, wishTargetId, wishSlot: Number(chosen?.object?.slot) };
    const clanRaidPlan = GearAcquisitionPlanner.isClanOwnedPlan(previousPlan)
        && previousPlan?.next?.sourceKind === 'raid';
    if (clanRaidPlan) planOptions.allowRaidSources = true;
    const weaponBridgePlan = !GearAcquisitionPlanner.combatReadiness(state).hasWeapon
        ? GearAcquisitionPlanner.npcEquipmentBridgePlan(state, planOptions) : null;
    const clanGoalLocked = !weaponBridgePlan
        && GearAcquisitionPlanner.clanGoalPlanLocked(state, previousPlan);
    const availabilitySource = !replanContext.failure && previousPlan?.status === 'active'
        && ['direct_drop', 'craft'].includes(previousPlan.strategy)
        ? GearAcquisitionPlanner.bestSourceForPlan(state, previousPlan, spots, {
            excludedSpotIds, allowRaidSources: clanRaidPlan
        })
        : null;
    const availabilityRouteChanged = availabilitySource && (
        String(availabilitySource.spotId || '') !== String(previousPlan?.next?.spotId || '')
        || Number(availabilitySource.npcId || 0) !== Number(previousPlan?.next?.npcId || 0)
    );
    const availabilityPlan = weaponBridgePlan || (previousPlan?.status === 'blocked' && !clanGoalLocked
        ? GearAcquisitionPlanner.replacementPlanFor(state, previousPlan, spots, {
            ...replanContext,
            ...planOptions
        })
        : availabilityRouteChanged
            ? GearAcquisitionPlanner.retargetPlanSource(state, previousPlan, availabilitySource)
            : previousPlan?.status === 'active'
            && ['direct_drop', 'craft'].includes(previousPlan.strategy)
            && !clanGoalLocked
                ? GearAcquisitionPlanner.replacementPlanFor(state, previousPlan, spots, {
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
            : GearAcquisitionPlanner.planFor(state, { spots, ...replanContext, ...planOptions })
    );
    const previousRefresh = previousPlan?.recipeId && !reusablePartyRequest && !clanGoalLocked
        ? GearAcquisitionPlanner.planFor(state, {
            spots,
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
    const retainedInputs = previousPlan?.crystalPreparation && ['complete', 'blocked'].includes(finalizedPlan.status)
        && !GearAcquisitionPlanner.equipmentTargetFulfilled(state, previousPlan)
        && GearAcquisitionPlanner.acquisitionTargetAllowed(state, previousPlan)
        && (previousPlan.materials || []).some(row => Number(state.inventory?.[row.selfId]?.amount || 0) > 0);
    const acquisitionPlan = retainedInputs ? deferredWishPlan(previousPlan, replanContext, state, timestamp) : withBridgeInputPreparation(state, previousPlan, {
        ...finalizedPlan,
        ...(finalizedPlan.target?.selfId === wishTargetId ? { target: { ...finalizedPlan.target, slot: Number(chosen.object.slot) } } : {}),
        marketFallback: finalizedPlan.status === 'active' && finalizedPlan.strategy === 'craft'
            && Number(finalizedPlan.acquisitionProgress?.at || finalizedPlan.startedAt || timestamp) + 20 * 60 * 1000 <= timestamp
    }, timestamp);
    const result = { acquisitionPlan: { ...acquisitionPlan },
        replanContext, reusablePartyRequest, excludedSpotIds };
    economy.gearPlanMemo = { key, spots, result };
    return { ...result, economy };
}

module.exports = { selectAcquisitionPlan, deferredWishPlan, withBridgeInputPreparation };
