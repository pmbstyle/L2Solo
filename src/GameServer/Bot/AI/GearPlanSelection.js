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
const { GRADES } = invoke('GameServer/Bot/AI/GearGradeRule');
const { fnv1a32 } = require('../Fnv1a');

function hasInputProject(plan) {
    return !!(plan?.recipeId || plan?.exchange?.kind === 'luxury_exchange' || plan?.combine);
}

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
            const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
            const warehouse = Warehouse.ready() && Warehouse.hasItems(state)
                ? Object.values(Warehouse.inventory(state)) : [];
            // Pausing a personal recipe transfers its banked inputs along with
            // the bag reserve, so an alternative goal cannot sell the stash.
            const pooled = hasInputProject(plan)
                ? { ...state, inventory: require('../Economy/CraftWarehousePolicy').available(state, warehouse).combined } : state;
            const collected = Disposition.collectedEquipmentInputs(pooled, plan);
            plan.heldInputs = productionInputs
                ? Disposition.capDeferredInputs({ ...plan, heldInputs: productionInputs }, collected) : collected;
        }
    }
    delete plan.economyInputKey;
    // Consume the native recovery wake/expiry once, retaining the inactive
    // target and its historical stamps for a later acquisition decision.
    if (previousPlan?.recoveryTargets || replanContext.recoveryTargets?.length) plan.recoveryTargets = replanContext.recoveryTargets;
    if (previousPlan?.levelingRecovery && !replanContext.levelingRecovery) delete plan.levelingRecovery;
    return uniqueCraftProjects(plan);
}

// Old persisted plans may already contain the same project several times.
// A captured quantity is a snapshot, not a new stack: preserve the largest
// observed amount per item while removing duplicate target/slot entries.
function uniqueCraftProjects(plan) {
    if (!plan?.inputPreparation) return plan;
    const nodes = [], identities = new Map(), seen = new Set();
    let changed = false, row = plan;
    for (; row && !seen.has(row); row = row.inputPreparation) {
        seen.add(row);
        const id = Number(row.target?.selfId), slot = Number(row.target?.slot);
        const craft = hasInputProject(row) && (['craft', 'luxury_exchange'].includes(row.strategy)
            || row.status === 'deferred' && row.reason === 'wish_focus');
        const key = craft && id > 0 && slot > 0 ? `${id}:${slot}` : null;
        if (key && identities.has(key)) {
            changed = true;
            const index = identities.get(key), first = nodes[index];
            if (row.heldInputs) {
                const held = { ...(first.heldInputs || {}) };
                for (const [itemId, amount] of Object.entries(row.heldInputs))
                    held[itemId] = Math.max(Number(held[itemId] || 0), Number(amount || 0));
                nodes[index] = { ...first, heldInputs: held };
            }
            continue;
        }
        if (key) identities.set(key, nodes.length);
        nodes.push(row);
    }
    if (row) changed = true;
    if (!changed) return plan;
    let result = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
        const { inputPreparation, ...rest } = nodes[i];
        result = result ? { ...rest, inputPreparation: result } : rest;
    }
    return result;
}

function withBridgeInputPreparation(state, previous, next, timestamp = Date.now()) {
    if (!next?.weaponBridge || !['active', 'deferred'].includes(next.status)) return next;
    const retained = previous?.recipeId || previous?.exchange || previous?.combine ? previous : previous?.inputPreparation;
    if (!retained?.target?.selfId || retained.reason === 'cancelled' || previous?.reason === 'cancelled'
        || GearAcquisitionPlanner.isClanOwnedPlan(retained)) return next;
    const Data = invoke('GameServer/DataCache'), Index = invoke('GameServer/Item/ItemTemplateIndex');
    const target = Index.find(Data.items, Number(retained.combine?.resultId || retained.target.selfId));
    const bridge = Index.find(Data.items, Number(next.combine?.resultId || next.target?.selfId));
    const ranks = GRADES;
    if (!target || !bridge || ranks.indexOf(target.etc?.rank) < 2
        || ranks.indexOf(target.etc?.rank) <= ranks.indexOf(bridge.etc?.rank)
        || !GearAcquisitionPlanner.considerable(target, state)
        || GearAcquisitionPlanner.equipmentTargetFulfilled(state, retained)) return next;
    const inputPreparation = deferredWishPlan({
        target: retained.target, exchange: retained.exchange, recipeId: retained.recipeId,
        materials: retained.materials, combine: retained.combine, heldInputs: retained.heldInputs,
        inputPreparation: withoutRetainedTarget(retained.inputPreparation, next.target),
        status: retained.status, reason: retained.reason }, {}, state, timestamp);
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const proposed = { ...state, stats: { ...state.stats, equipmentPlan: { ...next, inputPreparation } } };
    if (!Object.keys(Disposition.retainedEquipmentAmounts(proposed)).length) return next;
    return { ...next, inputPreparation };
}

// A market offer is tentative until its purchase commits. Keep the collected
// craft inputs protected if the offer disappears or the bot has to retry.
function withMarketCraftPreparation(state, previous, next, timestamp = Date.now()) {
    if (next?.strategy !== 'market' || next.status !== 'active') return next;
    const retained = hasInputProject(previous) && (['craft', 'luxury_exchange'].includes(previous.strategy)
        || previous.status === 'deferred' || previous.strategy === 'market' && previous.materials?.length)
        ? previous : previous?.inputPreparation;
    if (!hasInputProject(retained) || retained.reason === 'cancelled' || previous?.reason === 'cancelled') return next;
    if (GearAcquisitionPlanner.isClanOwnedPlan(retained)
        || !sameTarget(retained.target, next.target)) return next;
    const inputPreparation = deferredWishPlan(retained, {}, state, timestamp);
    return { ...next, inputPreparation };
}

function sameTarget(a, b) {
    const id = Number(a?.selfId), other = Number(b?.selfId);
    if (!(id > 0) || id !== other) return false;
    const slot = Number(a?.slot), otherSlot = Number(b?.slot);
    return !(slot > 0 && otherSlot > 0) || slot === otherSlot;
}

function withoutRetainedTarget(head, target) {
    if (!head) return null;
    const nodes = [], seen = new Set();
    for (let row = head; row && !seen.has(row); row = row.inputPreparation) {
        seen.add(row);
        if (!sameTarget(row.target, target)) nodes.push(row);
    }
    let result = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
        const { inputPreparation, ...rest } = nodes[i];
        result = result ? { ...rest, inputPreparation: result } : rest;
    }
    return result;
}

// Retained projects form a chain; each keeps only its own captured inputs.
function withRetainedCraftPreparation(state, previous, next, timestamp = Date.now()) {
    if (!next) return next;
    // A completed or blocked current objective does not cancel the older
    // projects behind it; keep their captured stock and standing needs.
    if (['complete', 'blocked'].includes(next.status)) {
        let retained = previous?.inputPreparation;
        const nodes = [], seen = new Set();
        for (let row = next.inputPreparation; row && !seen.has(row); row = row.inputPreparation) {
            seen.add(row); nodes.push(row);
        }
        for (let i = nodes.length - 1; i >= 0; i--) {
            const { inputPreparation, ...rest } = nodes[i];
            retained = retained ? { ...rest, inputPreparation: retained } : rest;
        }
        return retained ? uniqueCraftProjects({ ...next, inputPreparation: retained }) : next;
    }
    if (!['active', 'deferred', 'component_ready', 'ready_to_craft'].includes(next.status)) return next;
    if (next.inputPreparation) return uniqueCraftProjects(next);
    if (sameTarget(previous?.target, next.target)) {
        const older = withoutRetainedTarget(previous?.inputPreparation, next.target);
        return uniqueCraftProjects(older ? { ...next, inputPreparation: older } : next);
    }
    const retained = hasInputProject(previous) ? previous : previous?.inputPreparation;
    if (!hasInputProject(retained) || GearAcquisitionPlanner.isClanOwnedPlan(retained)
        || sameTarget(retained.target, next.target)
        || !Number(retained.target?.selfId) || retained.reason === 'cancelled' || previous?.reason === 'cancelled'
        || GearAcquisitionPlanner.equipmentTargetFulfilled(state, retained)) return next;
    if (!['craft', 'luxury_exchange', 'market'].includes(retained.strategy)
        && !(retained.status === 'deferred' && retained.reason === 'wish_focus')) return next;
    const inputPreparation = deferredWishPlan({
        target: retained.target, recipeId: retained.recipeId, exchange: retained.exchange, combine: retained.combine,
        crystalPreparation: retained.crystalPreparation, materials: retained.materials,
        craftProviders: retained.craftProviders, componentRecipes: retained.componentRecipes,
        heldInputs: retained.heldInputs, inputPreparation: withoutRetainedTarget(retained.inputPreparation, next.target),
        status: retained.status, reason: retained.reason
    }, {}, state, timestamp);
    const usable = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state, inputPreparation);
    return uniqueCraftProjects(usable?.status === 'active' && hasInputProject(usable) ? { ...next, inputPreparation } : next);
}

function deferredAcquisitionPlan(state, previous, economy, replanContext = {}, timestamp = Date.now()) {
    if (previous?.reason === 'cancelled') return { ...previous, status: 'deferred', strategy: 'none', next: null };
    const paused = deferredWishPlan(previous, replanContext, state, timestamp);
    const usable = invoke('GameServer/Bot/Economy/ItemDisposition').equipmentInputPlan(state, paused);
    if (hasInputProject(usable) && usable.status === 'active' && economy.network?.activity === null) {
        const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
        if (Warehouse.ready() && Warehouse.hasItems(state)) {
            const { reason, ...resumed } = usable;
            const ready = require('../Economy/CraftWarehousePolicy').stage(
                { ...state, stats: { ...state.stats, equipmentPlan: resumed } }, Object.values(Warehouse.inventory(state)));
            // Stored inputs are advisory incoming stock, not a physical
            // executable leaf. With no competing action, resume their owner
            // so the ordinary warehouse trip can collect the ready stage.
            if (ready?.requests.length) return resumed;
        }
    }
    if (hasInputProject(usable) && usable.status === 'active' || paused.inputPreparation) return paused;
    // A completed piece releases its old plan before the next review. Even
    // when shots win that review, bank the collected inputs of the next
    // concrete equipment choice instead of exposing them as market surplus.
    const keys = new Set([
        ...(economy.network?.queue || []).map(row => row.key),
        ...(economy.projection?.roots || [])
    ]);
    const Providers = invoke('GameServer/Bot/Economy/WishProviders');
    const owned = economy.board?.ownerLines?.(Number(state.characterId)) || [];
    const stockState = owned.length
        ? invoke('GameServer/Bot/Economy/MarketListingPolicy').ownSaleInputs(state, owned).state : state;
    for (const key of keys) {
        if (!/^power:\d+:\d+$/.test(key)) continue;
        const candidate = Providers.personalCraftPlan(state, economy, { wishKey: key });
        if (!candidate || candidate.clanGoal || GearAcquisitionPlanner.equipmentTargetFulfilled(state, candidate)) continue;
        const project = deferredWishPlan(candidate, replanContext, stockState, timestamp);
        if (Object.values(project.heldInputs || {}).some(amount => amount > 0)) return project;
    }
    return paused;
}

// The plan's review with the route's verdict on its source (withRoutedSource).
function selectAcquisitionPlan(state, previousPlan, options = {}) {
    const selection = select(state, previousPlan, options);
    return { ...selection, acquisitionPlan: withRoutedSource(state, selection.acquisitionPlan,
        options.spots || [], options.timestamp ?? Date.now()) };
}

// The route's verdict on an active plan's source, judged with the plan and held with it
// until its next review: routedSpotId names the source spot when the solo route takes it
// (the route's own source test, GearAcquisitionPlanner.isPlanSourceViableForState over the
// catalogue: an eligible source, the voluntary hunt band, the solo source reader), absent
// when it refuses it. Main reads it where it sends a bot to hunt without searching
// (DecisionEvents.heldSpotOf), never judges it again; room and the bot's exclusions are
// met at the trip. A verdict names its spot: one carried onto another source is none.
function withRoutedSource(state, plan, spots, timestamp) {
    const spotId = plan?.status === 'active' && plan.next?.spotId != null
        && GearAcquisitionPlanner.isPlanSourceViableForState(state, plan, { spots, timestamp }) ? String(plan.next.spotId) : undefined;
    if (!plan || plan.routedSpotId === spotId) return plan;
    const next = { ...plan, routedSpotId: spotId };
    if (spotId === undefined) delete next.routedSpotId;
    return next;
}

function select(state, previousPlan, { spots = [], timestamp = Date.now(), planningOptions = {}, preparedEconomy = null, preparedReplanContext = null } = {}) {
    if (previousPlan?.economyInputKey !== undefined) { previousPlan = { ...previousPlan }; delete previousPlan.economyInputKey; }
    const economy = preparedEconomy || invoke('GameServer/Bot/Economy/EconomyContext').forState(state, {
        spots, timestamp, board: planningOptions.board, buyOrderEscrow: planningOptions.buyOrderEscrow, caller: 'gear_plan'
    });
    const preparedAcquisition = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(state, economy);
    const lockedClan = GearAcquisitionPlanner.isClanOwnedPlan(previousPlan)
        && GearAcquisitionPlanner.clanGoalPlanLocked(state, previousPlan);
    if (!lockedClan && (['luxury_exchange', 'craft'].includes(preparedAcquisition?.strategy) || preparedAcquisition?.combine?.type === 'dual_sword')) return {
        acquisitionPlan: withRetainedCraftPreparation(state, previousPlan, { ...preparedAcquisition,
            ...(previousPlan?.clanGoal && Number(previousPlan.target?.selfId) === Number(preparedAcquisition.target?.selfId)
                ? { clanGoal: previousPlan.clanGoal } : {}) }, timestamp), replanContext: {}, reusablePartyRequest: false, economy };
    const chosen = economy.network.queue.find(wish => wish.key === economy.network.activity?.rootKey)
        || economy.network.queue.find(wish => wish.key === economy.network.focus?.[0]);
    const wishTargetId = chosen?.object?.slot ? chosen.object.itemId : null;
    const activity = economy.network.activity;
    const activeGear = wishTargetId && activity?.rootKey === chosen.key
        && ['hunting', 'shopping', 'crafting'].includes(activity.activity) && !activity.funding;
    if (!activeGear && !GearAcquisitionPlanner.isClanOwnedPlan(previousPlan)) {
        // Acquisition metadata remains resumable, but cannot override the
        // common engine's book, social, sale or production activity.
        const replanContext = preparedReplanContext || GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
        const acquisitionPlan = deferredAcquisitionPlan(state, previousPlan, economy, replanContext, timestamp);
        return { acquisitionPlan, replanContext, reusablePartyRequest: false, economy };
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
    // The open party request carries the hash of the key its plan was chosen
    // under (PartyRequestPlanner): while the bot waits, the plan is kept until
    // one of those inputs moves (level, kit, plan materials, the wish and its
    // funding, the plan's status, failures and replan context).
    const planKey = fnv1a32(key);
    const held = economy.gearPlanMemo;
    if (held?.key === key && held.spots === spots && replanContext.routeCurrent
        && !replanContext.failure && !replanContext.invalidSource
        && GearAcquisitionPlanner.isPlanSourceViableForState(state, previousPlan, { spots, timestamp })) {
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
    const bridge = !GearAcquisitionPlanner.combatReadiness(state).hasWeapon
        ? GearAcquisitionPlanner.npcEquipmentBridgePlan(state, planOptions) : null;
    // The bridge is taken unless the held clan plan stands against it (clanPlanKeptAgainst:
    // a weapon bridge beats the lock, an armour bridge does not).
    const weaponBridgePlan = bridge && !GearAcquisitionPlanner.clanPlanKeptAgainst(
        state.stats?.equipmentPlan === previousPlan ? state : { ...state, stats: { ...state.stats, equipmentPlan: previousPlan } },
        bridge) ? bridge : null;
    const clanGoalLocked = GearAcquisitionPlanner.clanGoalPlanLocked(state, previousPlan);
    const finishedOffer = !weaponBridgePlan && !clanGoalLocked && previousPlan?.strategy === 'craft'
        && ['active', 'component_ready'].includes(previousPlan.status)
        ? GearAcquisitionPlanner.fundedMarketPlanForTarget(state, previousPlan.target?.selfId, planOptions) : null;
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
    const availabilityPlan = weaponBridgePlan || finishedOffer || (previousPlan?.status === 'blocked' && !clanGoalLocked
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
                    ...planOptions,
                    finishedOfferChecked: previousPlan.strategy === 'craft'
                })
                : null);
    const reusablePartyRequest = !weaponBridgePlan
        && !state.party?.partyId
        && previousPlan?.next
        && !!availabilitySource
        && replanContext.routeCurrent
        && !replanContext.failure
        && state.stats?.partyRequest?.status === 'open'
        && Number(state.stats.partyRequest.planKey) === planKey
        && !(previousPlan.strategy === 'craft' ? finishedOffer
            : GearAcquisitionPlanner.fundedMarketPlanForTarget(state, previousPlan.target?.selfId, planOptions));
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
    const acquisitionPlan = retainedInputs ? deferredWishPlan(previousPlan, replanContext, state, timestamp) : withRetainedCraftPreparation(state, previousPlan, withMarketCraftPreparation(state, previousPlan, withBridgeInputPreparation(state, previousPlan, {
        ...finalizedPlan,
        ...(finalizedPlan.target?.selfId === wishTargetId ? { target: { ...finalizedPlan.target, slot: Number(chosen.object.slot) } } : {})
    }, timestamp), timestamp), timestamp);
    const result = { acquisitionPlan: { ...acquisitionPlan },
        replanContext, reusablePartyRequest, planKey };
    economy.gearPlanMemo = { key, spots, result };
    return { ...result, economy };
}

module.exports = { selectAcquisitionPlan, withRoutedSource, deferredWishPlan, deferredAcquisitionPlan, withBridgeInputPreparation, withMarketCraftPreparation, withRetainedCraftPreparation, uniqueCraftProjects };
