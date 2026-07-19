const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');

DataCache.init();

const stoneGolemSpot = {
    id: 'stone-golem-field',
    avgLevel: 19,
    npcEntries: [{ selfId: 16, name: 'Stone Golem', count: 8 }]
};

const ironSources = GearAcquisitionPlanner.sourceForItem(1869, [stoneGolemSpot]);
assert(ironSources.length > 0, 'known material drops must resolve to their real NPC source');
assert.strictEqual(ironSources[0].spotId, stoneGolemSpot.id, 'source lookup must retain the matching farming spot');
assert(ironSources[0].chance > 0, 'source lookup must retain an expected drop chance');

const noGradePlan = GearAcquisitionPlanner.planFor({ level: 10, stats: { classId: 0, role: 'dps' }, inventory: {} }, { spots: [stoneGolemSpot] });
assert.strictEqual(noGradePlan.strategy, 'direct_drop', 'no-grade bots must use drop goals rather than recipes');
assert.strictEqual(noGradePlan.recipeId, null, 'no-grade bots must never receive a crafting recipe');

const mage = { level: 40, stats: { classId: 10, role: 'mage' }, inventory: {} };
const target = GearAcquisitionPlanner.preferredTarget(mage);
assert(target, 'a C-grade mage without gear must receive a craftable target');
assert(['Weapon.Sword', 'Weapon.Blunt'].includes(target.item.template.kind), 'mage target must use a caster weapon family');
const station = ColdCraftingService.stationForRecipe(target.recipe.recipeId);
assert(station, 'a selected equipment recipe must be published by a Giran crafting station');

const missing = GearAcquisitionPlanner.missingMaterials(target.recipe, {
    [target.recipe.materials[0].selfId]: { selfId: target.recipe.materials[0].selfId, amount: target.recipe.materials[0].amount - 1 }
});
assert.strictEqual(missing[0].missing, 1, 'material planning must account for what the bot already owns');
assert.strictEqual(missing.length, target.recipe.materials.length, 'a plan must retain fulfilled materials so they remain reserved for crafting');

const readyInventory = target.recipe.materials.reduce((inventory, material) => ({
    ...inventory,
    [material.selfId]: { selfId: material.selfId, amount: material.amount }
}), {});
const travel = ColdCraftingService.beginTravel({
    level: mage.level,
    activity: 'hunting',
    loc: { locX: 0, locY: 0, locZ: 0 },
    inventory: readyInventory,
    stats: { equipmentPlan: { status: 'active', strategy: 'craft', recipeId: target.recipe.recipeId } }
}, 1000);
assert.strictEqual(travel.stats.travel.stationId, station.id, 'ready materials must route the bot to the station that publishes its recipe');
assert.strictEqual(travel.stats.travel.arrivalActivity, 'crafting', 'arrival must enter the cold manufacture state');
assert.strictEqual(travel.stats.craftReturn.spotId, null, 'craft travel must preserve the previous hunting destination for the return trip');
const readyPlan = GearAcquisitionPlanner.planFor({ ...mage, inventory: readyInventory }, { spots: [] });
assert.strictEqual(readyPlan.status, 'ready_to_craft', 'a complete material list must become a station visit, not a blocked farming plan');

const oriharkonRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(27);
const syntheticCokesRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(36);
const resourceState = {
    inventory: {
        1879: { selfId: 1879, amount: 3 },
        1874: { selfId: 1874, amount: 1 },
        1873: { selfId: 1873, amount: 12 },
        1872: { selfId: 1872, amount: 4 }
    }
};
assert.strictEqual(
    ColdCraftingService.readyRecipeFor(resourceState, oriharkonRecipe).recipeId,
    syntheticCokesRecipe.recipeId,
    'a ready crafted component must be manufactured before its parent equipment resource'
);
assert.strictEqual(
    ColdCraftingService.stationForRecipe(syntheticCokesRecipe.recipeId).id,
    'resource_core',
    'crafted resources must route bots to the dedicated Giran resource station'
);

const protectedMaterial = { selfId: 1869, name: 'Iron Ore', amount: 5, kind: 'Other.Material', rank: 'none' };
const sellable = ItemDisposition.saleCandidates({
    characterId: 1,
    inventory: { 1869: protectedMaterial },
    stats: { equipmentPlan: { status: 'active', strategy: 'craft', materials: [{ selfId: 1869, amount: 3, owned: 5 }] } }
});
assert.strictEqual(sellable[0].count, 2, 'market listings must retain the material amount reserved for the active recipe');

const materialGoal = NeedsEvaluator.evaluate({
    level: 40,
    adena: 100000,
    inventory: {},
    stats: {
        equipmentPlan: {
            status: 'active', strategy: 'craft', marketFallback: true, recipeId: target.recipe.recipeId,
            next: { itemId: 1869 }, materials: [{ selfId: 1869, missing: 4 }]
        }
    }
}, { now: 1000 }).find((goal) => goal.type === 'buy_craft_material');
assert.strictEqual(materialGoal.target.itemId, 1869, 'a stalled material route must create a buy-material market goal');

const materialPlan = GearAcquisitionPlanner.planFor(mage, { spots: [stoneGolemSpot] });
if (materialPlan.strategy === 'craft' && materialPlan.next) {
    assert(Number.isFinite(materialPlan.next.itemId), 'a craft route must persist the next farmable material for market fallback');
}

assert.strictEqual(GearAcquisitionPlanner.shouldFinishPreviousPlan(
    { grade: 'd', strategy: 'craft' },
    { grade: 'c', strategy: 'craft', status: 'active', materials: [{ amount: 10, missing: 1 }] }
), true, 'a nearly complete previous-grade recipe should finish before a grade switch');
assert.strictEqual(GearAcquisitionPlanner.shouldFinishPreviousPlan(
    { grade: 'd', strategy: 'craft' },
    { grade: 'c', strategy: 'craft', status: 'active', materials: [{ amount: 10, missing: 5 }, { amount: 10, missing: 5 }] }
), false, 'a largely incomplete previous-grade recipe should yield to the new grade');

assert.strictEqual(GearAcquisitionPlanner.sameObjective(
    { target: { selfId: 100 }, next: { spotId: 'a' } },
    { target: { selfId: 101 }, next: { spotId: 'a' } }
), true, 'bots gathering at the same source must be party-compatible');

SpotProfiles.cache = [
    { id: 'old-spot', avgLevel: 40, minLevel: 38, maxLevel: 42, density: 8, center: {}, npcEntries: [] },
    { ...stoneGolemSpot, minLevel: 17, maxLevel: 21, density: 8, center: {} }
];
const routed = SpotProfiles.findForState({
    level: 20,
    spotId: 'old-spot',
    stats: { equipmentPlan: { status: 'active', next: { spotId: stoneGolemSpot.id } } }
});
assert.strictEqual(routed.id, stoneGolemSpot.id, 'an active equipment plan must override the previous farming spot');
SpotProfiles.reset();

console.log('Bot gear acquisition checks passed');
