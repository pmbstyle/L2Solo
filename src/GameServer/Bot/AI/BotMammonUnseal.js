const Catalog = invoke('GameServer/Items/C4Unseal');
const Mammon = invoke('GameServer/World/GiranMammon');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const BotErrands = invoke('GameServer/Bot/Population/BotErrands');
// A Mammon trip waits for every other errand to finish, as the other trips do.
const BUSY_FLAGS = ['marketReturn', 'partyMarketReturn', 'marketStore', 'craftReturn', 'craftStationId',
    'supplyErrand', 'pvpEncounter'];

function recipeFor(selfId, state) {
    const style = Compatibility.armorStyleFor(Roles.inferRole(state),Roles.classIdOf(state));
    return Catalog.options(selfId).find(r => !r.style || r.style === style) || null;
}
function candidate(state) {
    return Object.values(state.inventory || {}).find(item => Number(item.amount)>0 && recipeFor(item.selfId,state));
}
function plan(session,bot,town,state) {
    if (town?.name !== 'Giran') return null;
    const item = bot.backpack.fetchItems().find(i=>recipeFor(i.fetchSelfId(),state));
    if (!item) return null;
    const npc = (invoke('GameServer/World/World').npc?.spawns || []).find(n=>n.fetchSelfId()===Mammon.npcId);
    if (!npc) return null;
    const recipe = recipeFor(item.fetchSelfId(),state);
    return {kind:'mammon_unseal',objectId:item.fetchId(),productId:recipe.productId,itemName:item.fetchName(),
        target:{actorId:npc.fetchId(),npcSelfId:Mammon.npcId,name:npc.fetchName(),town:'Giran',
            locX:npc.fetchLocX(),locY:npc.fetchLocY(),locZ:npc.fetchLocZ()}};
}
async function execute(session,bot,errand) {
    if (!String(session.accountId||'').startsWith('bot_') || session.actor !== bot
        || session.companionShopping !== errand || session.plan !== 'shopping') throw Error('unseal_errand_interrupted');
    const Service = invoke('GameServer/Items/MammonUnsealService');
    const oldTalk = session.activeNpcTalk;
    try {
        session.activeNpcTalk = {objectId:errand.target.actorId,selfId:Mammon.npcId};
        Service.nearby(session);
        const item = bot.backpack.fetchItemRaw(errand.objectId);
        if (!item) throw Error('unseal_item_missing');
        if (item.fetchEquipped()) bot.backpack.unequipGear(session,item.fetchSlot());
        await Service.exchange(session,errand.objectId,errand.productId,() => {
            if (session.actor !== bot || session.companionShopping !== errand || session.plan !== 'shopping') throw Error('unseal_errand_interrupted');
        });
        invoke('GameServer/Bot/AI/BotEquipmentUpgrade').applyBestUpgrades(session,{force:true});
        session.coldLifeState = {...session.coldLifeState,inventory:Life.inventorySummaryFromItems(bot.backpack.fetchItems())};
        if (!candidate(session.coldLifeState) && session.coldLifeState.stats?.mammonReturn) {
            session.coldLifeState.stats = {...session.coldLifeState.stats,mammonReturn:null};
        }
        return {completed:true};
    } finally { session.activeNpcTalk = oldTalk; }
}
// Cold solo bots use the existing SoE/gatekeeper transit model. Party members
// wait for a town errand instead of abandoning their group to cross the map;
// a shopping bot finishes its market steps first.
function beginTravel(state, timestamp = Date.now()) {
    if (state.phase !== 'cold' || state.activity !== 'hunting'
        || state.party?.partyId || state.partyId || Number(state.stats?.karma)>0
        || BotErrands.busyWith(state, BUSY_FLAGS)
        || Number(state.stats?.mammonRetryAt||0)>timestamp || !candidate(state)) return null;
    return {...state,activity:'traveling',stats:{...state.stats,
        mammonReturn:{loc:{...state.loc},spotId:state.spotId,regionName:state.currentRegion},
        travel:{from:{...state.loc},to:{...Mammon.loc},startedAt:timestamp,arrivalAt:timestamp+25000,
            townName:'Giran',regionName:'Giran',method:'soe_gatekeeper',arrivalActivity:'crafting',reason:'mammon_unseal',stationId:'Blacksmith of Mammon'}},
        timing:{...state.timing,nextResolveAt:timestamp+25000}};
}
async function finish(state,timestamp=Date.now()) {
    if (state.activity !== 'crafting' || !state.stats?.mammonReturn) return null;
    const Database = invoke('Database');
    const target = state.stats.mammonReturn;
    const near = Math.hypot(state.loc.locX-Mammon.loc.locX,state.loc.locY-Mammon.loc.locY)<=200
        && Math.abs(state.loc.locZ-Mammon.loc.locZ)<=200;
    let count = 0;
    const converted = new Map();
    if (near) {
        for (const item of await Database.fetchItems(state.characterId)) {
            const recipe = recipeFor(item.selfId,state);
            if (!recipe || Number(item.amount)!==1) continue;
            if (item.equipped) await Database.updateItemEquipState(state.characterId,item.id,false,item.slot);
            await Database.unsealInventoryItem(state.characterId,item.id,recipe.productId);
            converted.set(item.selfId,(converted.get(item.selfId)||0)+1);
            count++;
        }
    }
    // Retain unrelated virtual loot; replace only the converted source counts.
    const inventory = {...state.inventory};
    for (const [selfId,amount] of converted) {
        const previous = inventory[selfId];
        if (Number(previous?.amount)>amount) inventory[selfId] = {...previous,amount:previous.amount-amount,equipped:false,equippedSlots:[]};
        else delete inventory[selfId];
    }
    const refreshed = await Life.refreshInventory({...state,inventory},{equip:true});
    return {...refreshed,activity:'traveling',stats:{...refreshed.stats,mammonReturn:null,mammonRetryAt:count?0:timestamp+300000,
        travel:{from:{...state.loc},to:{...target.loc},startedAt:timestamp,arrivalAt:timestamp+25000,
            townName:target.regionName,regionName:target.regionName,spotId:target.spotId,method:'gatekeeper_spot',
            arrivalActivity:'hunting',reason:'mammon_unseal_return'}},timing:{...refreshed.timing,nextResolveAt:timestamp+25000}};
}
module.exports = {recipeFor,candidate,plan,execute,beginTravel,finish};
