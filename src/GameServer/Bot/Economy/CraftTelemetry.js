const DataCache = invoke('GameServer/DataCache');

function amount(state = {}, selfId) {
    return Number(state.inventory?.[String(selfId)]?.amount || state.inventory?.[selfId]?.amount || 0);
}

function itemName(selfId, plan = {}) {
    const material = (plan.materials || []).find((entry) => Number(entry.selfId) === Number(selfId));
    return material?.name || (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId))?.template?.name || `Item ${selfId}`;
}

function active(plan) {
    return ['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) && ['craft', 'direct_drop'].includes(plan?.strategy);
}

function planEvents(state, previous = {}, next = {}) {
    previous = previous || {};
    next = next || {};
    if (!active(next)) return [];
    const objectiveChanged = !active(previous)
        || Number(previous.recipeId || 0) !== Number(next.recipeId || 0)
        || Number(previous.target?.selfId || 0) !== Number(next.target?.selfId || 0)
        || previous.strategy !== next.strategy;
    const events = [];

    if (objectiveChanged) {
        const nextItemId = Number(next.next?.itemId || next.target?.selfId || 0);
        events.push({
            type: 'gear_acquisition_started',
            summary: `${state.name} chose ${next.target?.name || `Item ${next.target?.selfId}`} via ${next.strategy}${nextItemId ? `; next: ${itemName(nextItemId, next)}` : ''}`,
            weight: 3,
            meta: {
                strategy: next.strategy,
                recipeId: next.recipeId || null,
                targetId: next.target?.selfId || null,
                nextItemId: nextItemId || null,
                nextSpotId: next.next?.spotId || null,
                expectedKills: next.expectedKills || 0
            }
        });
    }

    if (previous.strategy === 'craft' && next.strategy === 'craft'
        && Number(previous.recipeId || 0) === Number(next.recipeId || 0)
        && Number(previous.next?.itemId || 0) > 0
        && Number(previous.next?.itemId || 0) !== Number(next.next?.itemId || 0)) {
        const completedId = Number(previous.next.itemId);
        const nextId = Number(next.next?.itemId || 0);
        events.push({
            type: next.status === 'ready_to_craft'
                ? 'craft_materials_ready'
                : next.status === 'component_ready' ? 'craft_component_ready' : 'craft_material_complete',
            summary: next.status === 'ready_to_craft'
                ? `${state.name} collected all final materials and can craft ${next.target?.name}`
                : next.status === 'component_ready'
                    ? `${state.name} collected enough ${itemName(completedId, previous)} and can craft an intermediate resource for ${next.target?.name}`
                    : `${state.name} collected enough ${itemName(completedId, previous)}; next: ${itemName(nextId, next)}`,
            weight: 3,
            meta: {
                recipeId: next.recipeId || null,
                completedItemId: completedId,
                nextItemId: nextId || null,
                nextSpotId: next.next?.spotId || null
            }
        });
    }
    return events;
}

function progressEvents(before = {}, plan = {}, after = {}) {
    if (!active(plan) || !plan.next?.itemId) return [];
    const selfId = Number(plan.next.itemId);
    const previousAmount = amount(before, selfId);
    const currentAmount = amount(after, selfId);
    const gained = currentAmount - previousAmount;
    if (gained <= 0) return [];
    const material = (plan.materials || []).find((entry) => Number(entry.selfId) === selfId);
    const required = Number(material?.amount || 1);
    return [{
        type: plan.strategy === 'craft' ? 'craft_material_progress' : 'equipment_drop_progress',
        summary: `${after.name || before.name} obtained ${gained} ${itemName(selfId, plan)} (${currentAmount}/${required})`,
        weight: 1,
        meta: {
            strategy: plan.strategy,
            recipeId: plan.recipeId || null,
            itemId: selfId,
            gained,
            owned: currentAmount,
            required,
            spotId: plan.next.spotId || null
        }
    }];
}

function stationTravelEvent(state, travel = {}) {
    return {
        type: 'craft_station_travel',
        summary: `${state.name} is traveling to ${travel.stationId} to ${travel.reason === 'component_craft' ? 'craft a component' : 'craft equipment'}`,
        weight: 2,
        meta: { stationId: travel.stationId || null, recipeId: state.stats?.equipmentPlan?.recipeId || null, reason: travel.reason || null }
    };
}

module.exports = { planEvents, progressEvents, stationTravelEvent };
