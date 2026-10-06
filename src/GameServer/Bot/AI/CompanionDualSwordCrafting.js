const refreshPartyMemberships = require('../../World/PartyMembershipPublication');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Recipes = invoke('GameServer/Items/C4DualSwordCombinations');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const Warehouse = invoke('GameServer/Warehouse/PersonalWarehouse');
const Services = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Item = invoke('GameServer/Item/Item');

const CACHE_MS = 30000;
function recipeFor(state, plan = state.stats?.equipmentPlan) {
    if (plan?.status === 'complete') return null;
    const recipe = Recipes.resolveByRecipeId(plan?.recipeId)
        || Recipes.resolveByProductId(plan?.combine?.resultId);
    const role = Roles.inferRole(state);
    const classId = Roles.classIdOf(state);
    if (!recipe || !Compatibility.profileFor(role,classId).weaponKinds.includes('Weapon.Dual')) return null;
    const ranks = ['none','d','c','b','a','s'];
    const item = DataCache.items.find(item => Number(item.selfId) === recipe.productId);
    const rank = invoke('GameServer/Bot/AI/GearAcquisitionPlanner').gradeForLevel(state.level);
    return item && ranks.indexOf(item.etc.rank) <= ranks.indexOf(rank) ? recipe : null;
}

function refreshWarehouse(session, bot) {
    if (session.dualWarehousePending) return session.dualWarehousePending;
    session.dualWarehousePending = Database.fetchWarehouseItems(bot.fetchId()).then(rows => {
        if (session.actor === bot) {
            session.dualWarehouseCache = { actor:bot, rows, at:Date.now() };
            session.lastCompanionEquipmentCheckAt = 0;
        }
        return rows;
    }).finally(() => { delete session.dualWarehousePending; });
    return session.dualWarehousePending;
}

function count(inventory, id) {
    return Object.values(inventory || {}).filter(i => Number(i.selfId) === id)
        .reduce((n,i) => n + Number(i.amount || 0),0);
}

function stationTarget(recipe, town) {
    // Companions settle equipment in the town their leader is visiting.
    if (recipe.station.townName !== town.name) return null;
    const npc = (invoke('GameServer/World/World').npc?.spawns || [])
        .find(npc => Number(npc.fetchSelfId?.()) === recipe.station.npcId);
    return npc ? { actorId:npc.fetchId(),npcSelfId:npc.fetchSelfId(),name:npc.fetchName(),
        locX:npc.fetchLocX(),locY:npc.fetchLocY(),locZ:npc.fetchLocZ(),town:town.name } : null;
}

// handled=true also protects a ready objective while its warehouse lookup is
// pending or its blacksmith is in another town. No per-tick database scan.
function plan(session, bot, town, state, candidate = state.stats?.equipmentPlan) {
    if (session.partyCompanion !== true) return { handled:false };
    const recipe = recipeFor(state,candidate);
    if (!recipe) return { handled:false };
    if (bot.backpack.fetchItems().some(i=>i.fetchSelfId()===recipe.productId && i.fetchEquipped())) {
        session.coldLifeState = {...state,stats:{...state.stats,equipmentPlan:{
            ...candidate,status:'complete',completedAt:Date.now(),reason:'dual_sword_equipped'
        }}};
        refreshPartyMemberships([session], invoke);
        return {handled:true,errand:null};
    }
    const missing = recipe.materials.filter(m => count(state.inventory,m.selfId) < m.amount);
    let rows = [];
    if (missing.length && !count(state.inventory,recipe.productId)) {
        const cache = session.dualWarehouseCache;
        if (cache?.actor !== bot || Date.now()-cache.at >= CACHE_MS) {
            refreshWarehouse(session,bot).catch(() => {});
            return { handled:true, errand:null };
        }
        rows = cache.rows;
        if (!missing.every(m => count(state.inventory,m.selfId)+count(rows,m.selfId) >= m.amount)) {
            return { handled:false };
        }
    }
    const target = stationTarget(recipe,town);
    const refreshed = { ...candidate, status:missing.length ? 'active' : 'ready_to_craft',
        strategy:'craft',recipeId:recipe.recipeId,
        target:{selfId:recipe.productId,name:DataCache.items.find(i=>Number(i.selfId)===recipe.productId)?.template?.name,slot:14},
        combine:{type:'dual_sword',resultId:recipe.productId,requirements:recipe.materials},
        materials:recipe.materials.map(m=>({...m,owned:count(state.inventory,m.selfId),missing:Math.max(0,m.amount-count(state.inventory,m.selfId))})) };
    session.coldLifeState = { ...state,stats:{...state.stats,equipmentPlan:refreshed} };
    refreshPartyMemberships([session], invoke);
    if (!target) return {handled:true,errand:null};
    if (missing.length && !count(state.inventory,recipe.productId)) {
        const warehouse = Services.targetFor(Services.ROLES.WAREHOUSE,town.name,{
            from:{locX:bot.fetchLocX(),locY:bot.fetchLocY(),locZ:bot.fetchLocZ()}
        });
        return {handled:true,errand:warehouse ? {kind:'dual_component_withdrawal',recipeId:recipe.recipeId,slot:14,target:warehouse} : null};
    }
    return {handled:true,errand:{kind:'dual_sword_combine',recipeId:recipe.recipeId,slot:14,target}};
}

function validate(session,bot,errand) {
    if (!String(session.accountId || '').startsWith('bot_') || session.actor !== bot || session.partyCompanion !== true || session.companionShopping !== errand
        || session.plan !== 'shopping' || bot.isDead?.() || bot.state?.fetchCombats?.()
        || bot.state?.fetchHits?.() || bot.state?.fetchCasts?.() || bot.state?.fetchTowards?.()) throw Error('equipment_errand_interrupted');
    const recipe = recipeFor({level:bot.fetchLevel(),stats:{classId:bot.fetchClassId()}},{recipeId:errand.recipeId});
    if (!recipe) throw Error('equipment_recipe_changed');
    const npc = (invoke('GameServer/World/World').npc?.spawns || []).find(n =>
        Number(n.fetchId?.()) === Number(errand.target.actorId) && Number(n.fetchSelfId?.()) === Number(errand.target.npcSelfId));
    if (!npc || Math.hypot(bot.fetchLocX()-npc.fetchLocX(),bot.fetchLocY()-npc.fetchLocY()) > 300
        || (errand.kind === 'dual_sword_combine' && npc.fetchSelfId() !== recipe.station.npcId)) throw Error('equipment_npc_unavailable');
    return recipe;
}

function refreshState(session,bot) {
    const previous = session.coldLifeState || {};
    session.coldLifeState = {...previous,inventory:Life.inventorySummaryFromItems(bot.backpack.fetchItems()),
        adena:Number(bot.backpack.fetchItemFromSelfId(57)?.fetchAmount() || 0)};
    refreshPartyMemberships([session], invoke);
}

async function execute(session,bot,errand) {
    if (session.dualCraftInFlight) return session.dualCraftInFlight;
    const work = async () => {
        const recipe = validate(session,bot,errand);
        if (errand.kind === 'dual_component_withdrawal') {
            const stored = await Warehouse.list(bot.fetchId());
            validate(session,bot,errand);
            const lines = [];
            for (const material of recipe.materials) {
                let needed = material.amount - bot.backpack.fetchItems().filter(i=>i.fetchSelfId()===material.selfId)
                    .reduce((n,i)=>n+i.fetchAmount(),0);
                for (const item of stored.filter(i=>i.fetchSelfId()===material.selfId)) {
                    const amount = Math.min(needed,item.fetchAmount());
                    if (amount > 0) { lines.push({objectId:item.fetchId(),amount});needed -= amount; }
                }
                if (needed > 0) throw Error('warehouse_components_changed');
            }
            const oldTalk = session.activeNpcTalk;
            try {
                session.activeNpcTalk = {objectId:errand.target.actorId,selfId:errand.target.npcSelfId};
                await Warehouse.withdraw(session,lines);
            } finally { session.activeNpcTalk = oldTalk;delete session.dualWarehouseCache;refreshState(session,bot); }
            return {completed:false,reason:'components_withdrawn'};
        }
        let product = bot.backpack.fetchItemFromSelfId(recipe.productId);
        if (!product) {
            const template = DataCache.items.find(i=>Number(i.selfId)===recipe.productId);
            // Same bot-only atomic combination and fee policy as cold crafting.
            const result = await Database.combineInventoryItems(bot.fetchId(),{
                ingredients:recipe.materials,product:{selfId:recipe.productId,name:template.template.name,amount:1,slot:14},
                validate:() => validate(session,bot,errand)
            });
            for (const source of result.sources) {
                const item = bot.backpack.fetchItemRaw(source.id);
                if (!item) continue;
                if (source.remaining > 0) item.setAmount(source.remaining);
                else {
                    if (item.fetchEquipped()) bot.backpack.unequipPaperdoll(item.fetchSlot());
                    bot.backpack.items = bot.backpack.items.filter(i=>i!==item);
                }
            }
            product = new Item(result.product.id,{...utils.crushOb(template),amount:1,equipped:false});
            bot.backpack.items.push(product);
        }
        invoke('GameServer/Bot/AI/BotEquipmentUpgrade').applyBestUpgrades(session,{force:true});
        refreshState(session,bot);
        const completed = product.fetchEquipped();
        if (completed) session.coldLifeState.stats = {...session.coldLifeState.stats,equipmentPlan:{
            ...session.coldLifeState.stats.equipmentPlan,status:'complete',completedAt:Date.now(),reason:'dual_sword_equipped'
        }};
        return {completed,reason:completed?'dual_sword_equipped':'equipment_pending',productId:recipe.productId};
    };
    session.dualCraftInFlight = work().finally(()=>{delete session.dualCraftInFlight;});
    return session.dualCraftInFlight;
}

module.exports = { plan, execute, refreshWarehouse, recipeFor };
