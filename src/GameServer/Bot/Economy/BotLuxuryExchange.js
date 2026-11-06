'use strict';

const Shop = require('../../World/Generics/NpcExchangeShopLists');
const Index = require('../../Item/ItemTemplateIndex');
const NPC_IDS = [7097, 7098], CRYSTAL_D = 1458;
let spawns, items, catalog;
// One immutable index per thread, rebuilt only when authored spawns change.
// Bots pay the catalogue's D crystals; the player catalogue keeps both grades.
function recipes() {
    const Data = invoke('GameServer/DataCache');
    if (catalog && spawns === Data.npcSpawns && items === Data.items) return catalog;
    spawns = Data.npcSpawns; items = Data.items; catalog = new Map();
    const enabled = new Set();
    for (const region of spawns || []) for (const row of region.spawns || [region])
        if (Number(row.total) > 0 && NPC_IDS.includes(Number(row.selfId))) enabled.add(Number(row.selfId));
    for (const npcId of enabled) Shop.fetchForNpc(npcId).forEach((row, recipeIndex) => {
        if (Index.find(items, row.result.selfId)?.etc?.rank !== 'c') return;
        const required = row.required.filter(item => Number(item.selfId) === CRYSTAL_D);
        if (required.length !== 1 || !(Number(required[0].amount) > 0)) return;
        catalog.set(Number(row.result.selfId), Object.freeze({ npcId, recipeIndex,
            itemId: Number(row.result.selfId), amount: Number(row.result.amount),
            materials: Object.freeze(required.map(item => Object.freeze({ selfId: CRYSTAL_D, amount: Number(item.amount) }))) }));
    });
    return catalog;
}
function resolve(proposal) {
    const recipe = recipes().get(Number(proposal?.itemId));
    return recipe && recipe.npcId === Number(proposal.npcId)
        && recipe.recipeIndex === Number(proposal.recipeIndex) ? recipe : null;
}
function dualComponent(state, item, role, Planner) {
    if (item.template?.kind !== 'Weapon.Sword') return false;
    const Data = invoke('GameServer/DataCache');
    // A source blade need not fit the paperdoll: its native combination must
    // produce a usable dual within this bot's current acquisition ceiling.
    return invoke('GameServer/Items/C4DualSwordCombinations').loadRecipes().some(combination => {
        if (!combination.materials.some(row => row.selfId === item.selfId)) return false;
        const product = Index.find(Data.items, combination.productId);
        return product && Planner.suitable(product, state, role, product.etc.rank)
            && Planner.acquisitionTargetAllowed(state, { target: { selfId: product.selfId } });
    });
}
function eligible(state, recipe, forCrystals = false) {
    const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
    if (!recipe || !Progression.allowsCGradeAcquisition(state) || Number(state.level) < 20
        || Number(state.level) < 40 && Progression.assess(state).required) return false;
    const Data = invoke('GameServer/DataCache'), Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const item = Index.find(Data.items, recipe.itemId);
    const role = Planner.roleFor(state);
    return !!item && (forCrystals && Number(state.level) >= 40 || Planner.suitable(item, state, role, 'c')
        || dualComponent(state, item, role, Planner));
}
module.exports = { recipes, resolve, eligible, NPC_IDS, CRYSTAL_D };
