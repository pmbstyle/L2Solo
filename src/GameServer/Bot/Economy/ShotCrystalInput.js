'use strict';

// The one physical piece of gear a shot job bought to crystallize. Keep it
// separate from the wearable kit while it crosses a market/town handoff.
function itemId(state, timestamp = Date.now()) {
    const prep = state?.stats?.shotCraft?.preparing;
    if (!prep || !Number.isFinite(prep.at) || timestamp >= prep.at + 30 * 60000
        || !Number.isSafeInteger(prep.crystalGearId) || prep.crystalGearId <= 0) return 0;
    const recipe = require('../../Items/C4RecipeItems').resolveByRecipeId(Number(prep.recipeId));
    if (!recipe || !require('./ProductionPolicy').GRADED_SHOTS.has(Number(recipe.productId))) return 0;
    const template = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items,prep.crystalGearId);
    const crystalId = require('./ShotCraftPolicy').CRYSTAL_BY_RANK[template?.etc?.rank];
    return Number(template?.etc?.cristals) > 0 && recipe.materials.some(row => Number(row.selfId) === crystalId)
        ? prep.crystalGearId : 0;
}

function amount(state,id,timestamp) {
    const gearId = itemId(state,timestamp);
    return gearId > 0 && Number(id) === gearId ? 1 : 0;
}

// Hide one unworn, unenchanted copy from equipment selection, then restore
// its physical identity. An existing worn copy of the same type stays usable.
function equip(state, inventory, select) {
    const id = itemId(state), held = inventory?.[id];
    if (!id || !held || !(Number(held.amount) > Number(held.equippedCount || (held.equipped ? 1 : 0))))
        return select(state,inventory);
    const instances = held.instances;
    const reserved = Array.isArray(instances) ? instances.filter(row => !row.equipped && !Number(row.enchant))
        .sort((a,b)=>Number(b.id)-Number(a.id))[0] : !Number(held.enchant) ? {} : null;
    if (!reserved) return select(state,inventory);
    const visible = {...inventory};
    if (Number(held.amount) === 1) delete visible[id];
    else visible[id] = {...held,amount:Number(held.amount)-1,
        ...(instances ? {instances:instances.filter(row=>row.id!==reserved.id)} : {})};
    const selected = select({...state,inventory:visible},visible);
    const chosen = selected[id] || {...held,equipped:false,equippedCount:0,equippedSlots:[]};
    return {...selected,[id]:{...chosen,amount:Number(held.amount),
        ...(instances ? {instances:instances.map(row=>row.id===reserved.id ? {...row,equipped:false}
            : chosen.instances?.find(item=>item.id===row.id) || row)} : {})}};
}

module.exports = {itemId,amount,equip};
