// Pure equipment calculation shared by the main-thread harnesses and the worker.
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const DataCache = invoke('GameServer/DataCache');
const Policy = require('./ClanEquipmentPolicy');
const Config = require('./ClanSimulationConfig');
const Crafting = require('./ClanCraftingPolicy');
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function plannerState(member) {
    return {
        ...member,
        characterId: number(member.characterId ?? member.id),
        name: member.name || member.memberName || '',
        stats: { ...(member.stats || {}) },
        inventory: { ...(member.inventory || {}) },
        adena: number(member.adena || member.inventory?.['57']?.amount),
        currentRegion: member.currentRegion || null,
        party: { partyId: member.partyId || null }
    };
}

// The clan's purchase budget for a member: what the member can pay itself
// plus the clan's free money (options.clanShare).
function clanBudget(state, options = {}) {
    return PurchaseFunding.spendable(state, 0, { upperBound: true }) + Math.max(0, number(options.clanShare));
}

function existingPlanFor(member) {
    const plan = member?.stats?.equipmentPlan;
    return Policy.isAcquisitionPlan(plan) ? plan : null;
}

function warehouseAvailable(rows = [], selfId) {
    return (rows || [])
        .filter((row) => number(row.selfId) === number(selfId))
        .reduce((sum, row) => sum + Math.max(0, number(row.amount) - number(row.reservedAmount)), 0);
}

function overlayWarehouseMaterials(state, plan, warehouseRows = []) {
    if (plan?.strategy !== 'craft' || !number(plan.recipeId)) return { state, materials: [] };
    const inventory = { ...(state.inventory || {}) };
    const materials = [];
    (plan.materials || []).forEach((material) => {
        const selfId = number(material.selfId);
        const missing = Math.max(0, number(material.missing));
        if (!selfId || missing <= 0) return;
        const available = warehouseAvailable(warehouseRows, selfId);
        const amount = Math.min(missing, available);
        if (amount <= 0) return;
        const current = inventory[String(selfId)] || {};
        inventory[String(selfId)] = {
            ...current,
            selfId,
            name: current.name || (warehouseRows.find((row) => number(row.selfId) === selfId)?.name || `Item ${selfId}`),
            amount: number(current.amount) + amount
        };
        materials.push({ selfId, amount });
    });
    return {
        state: materials.length ? { ...state, inventory } : state,
        materials
    };
}

// Towns that sell an NPC item at the same price are ranked by distance to
// the member. A member walking past the midpoint between two of them keeps
// its planned town, so the clan plan is not rewritten for the same purchase.
function keepPlannedTown(planned, current) {
    if (!planned?.town || current.sourceType !== 'npc' || planned.sourceType !== 'npc'
        || Number(planned.price) !== Number(current.price)) return current;
    return { ...current, town: planned.town };
}

function calculateRoute(member, spots = [], warehouseRows = [], options = {}) {
    const planningMember = options.ignoreExistingPlan ? {
        ...member,
        stats: { ...(member?.stats || {}), equipmentPlan: undefined }
    } : member;
    const existing = existingPlanFor(planningMember);
    const state = plannerState(planningMember);
    const marketBudget = clanBudget(state, options);
    const plannerOptions = {
        spots,
        clanCrafting: true,
        craftRecipes: options.craftRecipes,
        ...(options.recipeId ? { recipeId: options.recipeId } : {}),
        allowedRecipeIds: options.allowedRecipeIds ? new Set(options.allowedRecipeIds) : undefined,
        maxExpectedKills: number(options.maxExpectedKills, Config.equipmentMaxExpectedKills),
        maxMarketPrice: marketBudget,
        spoilCapable: options.spoilCapable === true,
        allowRaidSources: options.allowRaidSources === true,
        ...(options.occupancy ? { occupancy: options.occupancy } : {}),
        ...(options.capacityUnits ? { capacityUnits: options.capacityUnits } : {}),
        ...(options.reservationKey ? { reservationKey: options.reservationKey } : {}),
        ...(options.maxReservationGroups ? { maxReservationGroups: options.maxReservationGroups } : {}),
        ...(options.excludedTargetIds ? { excludedTargetIds: options.excludedTargetIds } : {})
    };
    try {
        if (existing?.strategy === 'market') {
            // Reprice only this target against the already captured market snapshot.
            // An unfunded or sold-out listing must not lock the clan's goal.
            const current = GearAcquisitionPlanner.marketPlanForTarget(
                state, number(existing.target?.selfId), plannerOptions
            );
            if (current) return {
                ...existing,
                market: keepPlannedTown(existing.market, current.market),
                expectedKills: current.expectedKills,
                expectedEffort: current.expectedEffort ?? current.expectedKills,
                rateModelVersion: GearAcquisitionPlanner.RATE_MODEL_VERSION,
                rateProfileSignature: GearAcquisitionPlanner.rateProfileSignature()
            };
            return GearAcquisitionPlanner.planFor({
                ...state,
                stats: { ...state.stats, equipmentPlan: undefined }
            }, plannerOptions);
        }
        const rateProfileCurrent = !existing
            || Number(existing.rateModelVersion || 0) >= GearAcquisitionPlanner.RATE_MODEL_VERSION
                && String(existing.rateProfileSignature || '') === GearAcquisitionPlanner.rateProfileSignature();
        if (existing?.strategy === 'direct_drop' && !rateProfileCurrent) {
            // Route economics are part of the rate model. Reconsider the
            // target as well as the dropper so an old cheap-looking raid does
            // not stay locked after roster opportunity cost changes.
            const targetId = number(existing.target?.selfId);
            const overBudget = !GearAcquisitionPlanner.withinExpectedKillLimit(
                existing, plannerOptions.maxExpectedKills
            );
            return GearAcquisitionPlanner.planFor({
                ...state,
                stats: { ...(state.stats || {}), equipmentPlan: undefined }
            }, {
                ...plannerOptions,
                ...(overBudget && targetId ? {
                    excludedTargetIds: [...new Set([
                        ...(options.excludedTargetIds || []).map(number).filter(Boolean),
                        targetId
                    ])]
                } : {})
            });
        }
        if (existing?.status === 'blocked') {
            const targetId = number(existing.target?.selfId);
            return GearAcquisitionPlanner.planFor(state, {
                ...plannerOptions,
                excludedTargetIds: [...new Set([
                    ...(options.excludedTargetIds || []).map(number).filter(Boolean),
                    targetId
                ].filter(Boolean))]
            });
        }
        if (existing && existing.status === 'active' && ['direct_drop', 'craft'].includes(existing.strategy)) {
            const excluded = new Set((options.excludedTargetIds || []).map(number).filter(Boolean));
            const targetExcluded = excluded.has(number(existing.target?.selfId));
            const source = targetExcluded
                ? null
                : GearAcquisitionPlanner.bestSourceForPlan(state, existing, spots, plannerOptions);
            if (source) {
                const routed = GearAcquisitionPlanner.retargetPlanSource(state, existing, source);
                if (!GearAcquisitionPlanner.withinExpectedKillLimit(routed, plannerOptions.maxExpectedKills)) {
                    const targetId = number(existing.target?.selfId);
                    return GearAcquisitionPlanner.planFor(state, {
                        ...plannerOptions,
                        excludedTargetIds: [...new Set([
                            ...(options.excludedTargetIds || []).map(number).filter(Boolean),
                            targetId
                        ].filter(Boolean))]
                    });
                }
                if (existing.strategy !== 'craft') return routed;
                const overlay = overlayWarehouseMaterials(state, routed, warehouseRows);
                return overlay.materials.length ? { ...routed, warehouseMaterials: overlay.materials } : routed;
            }
            if (!targetExcluded && existing.strategy === 'craft' && number(existing.recipeId)) {
                const overlay = overlayWarehouseMaterials(state, existing, warehouseRows);
                const refreshed = GearAcquisitionPlanner.planFor(overlay.state, {
                    ...plannerOptions,
                    recipeId: number(existing.recipeId)
                });
                if (['active', 'ready_to_craft', 'component_ready'].includes(refreshed?.status)) {
                    return overlay.materials.length
                        ? { ...refreshed, warehouseMaterials: overlay.materials }
                        : refreshed;
                }
            }
            const targetId = number(existing.target?.selfId);
            return GearAcquisitionPlanner.planFor(state, {
                ...plannerOptions,
                excludedTargetIds: [...new Set([
                    ...(options.excludedTargetIds || []).map(number).filter(Boolean),
                    targetId
                ])]
            });
        }
        if (existing && require('../Bot/AI/EquipmentAcquisitionProgress').componentAcquired(state, existing)) {
            return GearAcquisitionPlanner.planFor(state, plannerOptions);
        }
        if (existing && GearAcquisitionPlanner.clanGoalPlanLocked(planningMember, existing)) return existing;
        if (existing && existing.strategy !== 'craft') return existing;
        const initial = existing || GearAcquisitionPlanner.planFor(state, plannerOptions);
        if (initial?.strategy !== 'craft' || !number(initial.recipeId)) return initial;
        const overlay = overlayWarehouseMaterials(state, initial, warehouseRows);
        if (!overlay.materials.length) return initial;
        const refreshed = GearAcquisitionPlanner.planFor(overlay.state, {
            ...plannerOptions,
            recipeId: number(initial.recipeId)
        });
        return {
            ...refreshed,
            warehouseMaterials: overlay.materials
        };
    } catch (error) {
        if (options.throwOnError) throw error;
        return { status: 'blocked', reason: 'gear_planner_unavailable', strategy: 'none', target: null };
    }
}

// The clan routes only purchases the member and the clan share can pay now. The
// planner's NPC bridge still returns an unaffordable item as the saving target
// of a bot's own plan; for the clan that is no route, or a replan returns the
// same target and the goal stays locked on it.
function calculate(member, spots = [], warehouseRows = [], options = {}) {
    const plan = calculateRoute(member, spots, warehouseRows, options);
    if (plan?.strategy !== 'market') return plan;
    // A dual sword is funded by its whole combination (bridgeCost), not one blade.
    const cost = number(plan.bridgeCost ?? plan.market?.price);
    if (!(cost > clanBudget(plannerState(member), options))) return plan;
    return { status: 'blocked', reason: 'clan_market_unfunded', strategy: 'none', target: null };
}

function planForMember(member, spots = [], warehouseRows = [], options = {}) {
    const inventory = member.inventory || {};
    const pooled = Crafting.stockInventory(inventory, warehouseRows);
    // Recalculate craft shortages against the pooled inventory before routing.
    const previous = member.stats?.equipmentPlan;
    const state = { ...member, inventory: pooled, stats: { ...(member.stats || {}) } };
    if (previous?.strategy === 'craft') delete state.stats.equipmentPlan;
    const retainedRecipe = previous?.strategy === 'craft' && previous.status !== 'blocked' && !options.ignoreExistingPlan
        && !(options.excludedTargetIds || []).map(Number).includes(Number(previous.target?.selfId))
        ? Number(previous.recipeId) : null;
    const plan = calculate(state, spots, [], { ...options, recipeId: retainedRecipe });
    if (plan?.strategy !== 'craft') return plan;
    const providers = {};
    const componentRecipes = {};
    const recipes = invoke('GameServer/Items/C4RecipeItems');
    const byProduct = new Map((options.craftRecipes || []).map(recipe => [Number(recipe.productId), recipe]));
    const visit = (recipe, seen = new Set()) => {
        if (!recipe || seen.has(recipe.recipeId)) return;
        seen.add(recipe.recipeId);
        if (options.craftProviders?.[recipe.recipeId]) providers[recipe.recipeId] = options.craftProviders[recipe.recipeId];
        for (const material of recipe.materials || []) {
            const child = byProduct.get(Number(material.selfId)) || recipes.resolveByProductId(material.selfId);
            if (child) { componentRecipes[material.selfId] = child.recipeId; visit(child, seen); }
        }
    };
    visit(Crafting.resolveRecipe(plan.recipeId));
    plan.craftProviders = providers;
    plan.componentRecipes = componentRecipes;
    return { ...plan, warehouseMaterials: Crafting.warehouseMaterials(plan, inventory, warehouseRows),
        ...(Object.keys(providers).length ? { craftProviders: providers } : {}) };
}

module.exports = { planForMember };
