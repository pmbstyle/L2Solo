'use strict';

// The accepted clan equipment owner asks the shared economy for its next
// crystal ingredient. Purchases, travel, exchanges and crystallization still
// use the ordinary wish graph and native commands.
function identity(state) {
    const plan = state.stats?.equipmentPlan;
    return plan?.clanGoal?.clanId ? [plan.clanGoal.clanId, plan.clanGoal.goalKey, plan.clanGoal.beneficiaryId,
        plan.target?.selfId, plan.target?.slot, plan.status, plan.strategy,
        (plan.materials || []).filter(row => [1458, 1459].includes(Number(row.selfId))).map(row => [row.selfId, row.amount,
            Math.min(Number(row.amount) || 0, Math.max(0, Number(state.inventory?.[row.selfId]?.amount) || 0))])] : null;
}

function requirement(state) {
    const plan = state.stats?.equipmentPlan;
    if (!plan?.clanGoal?.clanId || Number(plan.clanGoal.beneficiaryId) !== Number(state.characterId)
        || Number(state.clanId ?? state.stats?.clanId) !== Number(plan.clanGoal.clanId)
        || !['active', 'component_ready', 'ready_to_craft'].includes(plan.status)
        || !['craft', 'luxury_exchange'].includes(plan.strategy)
        || !plan.target?.selfId || !plan.target?.slot
        || Number(state.inventory?.[plan.target.selfId]?.amount || 0) > 0
        || !invoke('GameServer/Bot/AI/GearAcquisitionPlanner').combatReadiness(state).hasWeapon
        || !invoke('GameServer/Bot/AI/GearAcquisitionPlanner').acquisitionTargetAllowed(state, plan)
        || invoke('GameServer/Bot/AI/GearAcquisitionPlanner').equipmentTargetFulfilled(state, plan)) return null;
    const material = (plan.materials || []).find(row => [1458, 1459].includes(Number(row.selfId))
        && Number(row.amount) > Number(state.inventory?.[row.selfId]?.amount || 0));
    const delivery = !material && plan.strategy === 'luxury_exchange' && plan.exchange?.materials?.length
        && plan.exchange.materials.every(row => Number(state.inventory?.[row.selfId]?.amount || 0) >= Number(row.amount));
    // An exchange goal is the worn target, its crystals only one way to it: the
    // root asks for the target, whose node weighs a direct offer against the
    // exchange and its crystal inputs. A craft goal's crystals are the
    // beneficiary's share of the clan recipe, so its root stays the crystals.
    const crystals = material && plan.strategy !== 'luxury_exchange';
    return material || delivery ? { plan, selfId: crystals ? Number(material.selfId) : Number(plan.target.selfId),
        amount: crystals ? Number(material.amount) : 1,
        key: `power:${plan.target.selfId}:${plan.target.slot}` } : null;
}

function stock(state, id) {
    // Only this equipment owner's materials are released to its own root.
    // Other roots and native item-disposition readers keep their reservations.
    const demand = { ...state.stats?.clanMaterialDemand };
    delete demand[id];
    const source = { ...state, stats: { ...state.stats, equipmentPlan: null, clanMaterialDemand: demand } };
    return invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(source, state.inventory?.[id] || {});
}

function freesSpace(state, leaf) {
    if (!requirement(state) || leaf?.activity !== 'improving' || leaf.improvement?.kind !== 'crystallize') return false;
    const inventory = { ...state.inventory }, Crystals = require('./BotCrystallization');
    const Data = invoke('GameServer/DataCache'), Index = require('../../Item/ItemTemplateIndex');
    const inputs = leaf.improvement.items || [{ selfId: leaf.improvement.sourceSelfId,
        amount: Number(leaf.improvement.amount || leaf.batches || 1) }];
    let crystalId = null, received = 0;
    const seen = new Set();
    for (const input of inputs) {
        const item = inventory[input.selfId], amount = Number(input.amount);
        const reward = Crystals.reward(Index.find(Data.items, input.selfId), 0, leaf.improvement.mode === 'self');
        if (seen.has(input.selfId) || !reward || !Number.isSafeInteger(amount) || amount <= 0 || Crystals.free(state, input.selfId) < amount
            || crystalId && crystalId !== reward.crystalId) return false;
        seen.add(input.selfId);
        crystalId = reward.crystalId; received += reward.net * amount;
        const left = Number(item?.amount || 0) - amount;
        if (left > 0) {
            let removed = 0;
            inventory[input.selfId] = { ...item, amount: left,
                ...(item.instances ? { instances: item.instances.filter(row => row.equipped || removed++ >= amount) } : {}) };
        }
        else delete inventory[input.selfId];
    }
    if (!crystalId) return false;
    inventory[crystalId] = { ...inventory[crystalId], selfId: crystalId, stackable: true,
        amount: Number(inventory[crystalId]?.amount || 0) + received };
    const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
    const before = Floor.stateInventory(state, Data.items), after = Floor.stateInventory({ ...state, inventory }, Data.items);
    return after.slots < before.slots && after.load <= before.load;
}

module.exports = { requirement, stock, identity, freesSpace };
