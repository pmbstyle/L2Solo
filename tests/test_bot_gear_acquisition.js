const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
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
assert.strictEqual(GearAcquisitionPlanner.soloSafeForSource({ level: 30 }, { spotLevel: 28 }), true, 'a bot should solo only sources below its combat safety margin');
assert.strictEqual(GearAcquisitionPlanner.soloSafeForSource({ level: 30 }, { spotLevel: 29 }), false, 'a bot must not call an equal-level source solo-safe');
assert.strictEqual(
    GearAcquisitionPlanner.bestSourceForState([{ spotLevel: 32, id: 'dangerous' }, { spotLevel: 27, id: 'safe' }], { level: 30 }).id,
    'safe',
    'material planning must prefer a viable lower-yield solo source over a dangerous one'
);

const previousProgressionRate = process.env.L2NODE_PROGRESSION_RATE;
process.env.L2NODE_PROGRESSION_RATE = 'x50';
const caveMaidenSpot = {
    id: 'cave-maiden-field',
    avgLevel: 59,
    npcEntries: [{ selfId: 134, name: 'Cave Maiden', count: 4 }]
};
const steelSourceAtX50 = GearAcquisitionPlanner.sourceForItem(1880, [caveMaidenSpot], { level: 52 })[0];
assert(steelSourceAtX50.expectedYield > 1, 'high-rate material plans must include the scaled drop quantity, not only the selection chance');
assert(Math.ceil(220 / steelSourceAtX50.expectedYield) < 300, '220 Steel from Cave Maiden at x50 must not be estimated as thousands of kills');
if (previousProgressionRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
else process.env.L2NODE_PROGRESSION_RATE = previousProgressionRate;

const noGradePlan = GearAcquisitionPlanner.planFor({ level: 10, stats: { classId: 0, role: 'dps' }, inventory: {} }, { spots: [stoneGolemSpot] });
assert(['direct_drop', 'market'].includes(noGradePlan.strategy), 'no-grade bots must choose a drop or market route, never recipes');
assert.strictEqual(noGradePlan.recipeId, null, 'no-grade bots must never receive a crafting recipe');
assert.strictEqual(noGradePlan.rateModelVersion, GearAcquisitionPlanner.RATE_MODEL_VERSION, 'all acquisition plans must persist the drop-rate model used for their estimates');

const preFocusPlan = GearAcquisitionPlanner.planFor({ level: 4, stats: { classId: 0, role: 'dps' }, inventory: {} }, { spots: [stoneGolemSpot] });
assert.strictEqual(preFocusPlan.status, 'deferred', 'starter bots must level naturally before gear acquisition begins');
assert.strictEqual(preFocusPlan.strategy, 'none');

const forcedRecipeBeforeTwenty = GearAcquisitionPlanner.planFor({ level: 19, stats: { classId: 0, role: 'dps' }, inventory: {} }, { spots: [stoneGolemSpot], recipeId: 189 });
assert.notStrictEqual(forcedRecipeBeforeTwenty.strategy, 'craft', 'no-grade bots must never enter a craft route before level twenty');

const marketNoGradePlan = GearAcquisitionPlanner.planFor({ level: 5, stats: { classId: 0, role: 'dps' }, inventory: {} }, {
    spots: [],
    findMarketOffer: (item) => ({ selfId: item.selfId, price: 1, town: 'Giran', sourceType: 'npc' })
});
assert.strictEqual(marketNoGradePlan.strategy, 'market', 'an affordable no-grade market offer must beat an unavailable drop route');
assert.strictEqual(marketNoGradePlan.recipeId, null, 'no-grade market purchases must never request crafting');

const serviceCrafter = {
    level: 70,
    activity: 'crafting',
    stats: { classId: 57, generatedIndex: 10026, craftStationId: 'resource_core', craftShop: { entries: [] } },
    inventory: {}
};
assert.strictEqual(GearAcquisitionPlanner.isCraftService(serviceCrafter), true, 'public craft stations must be identified as services');
assert.strictEqual(GearAcquisitionPlanner.planFor(serviceCrafter, { spots: [stoneGolemSpot] }).status, 'service', 'public craft stations must never receive a gear-acquisition plan');

const mage = { level: 40, stats: { classId: 10, role: 'mage' }, inventory: {} };
const target = GearAcquisitionPlanner.preferredTarget(mage);
assert(target, 'a C-grade mage without gear must receive a craftable target');
assert(['Weapon.Sword', 'Weapon.Blunt'].includes(target.item.template.kind), 'mage target must use a caster weapon family');

const dMarketPlan = GearAcquisitionPlanner.planFor({ ...mage, level: 20 }, {
    spots: [],
    findMarketOffer: (item) => ({ selfId: item.selfId, price: 1, town: 'Giran', sourceType: 'npc' })
});
assert.strictEqual(dMarketPlan.strategy, 'market', 'D-grade bots must compare a ready market offer with crafting and drops');
const atubaMace = DataCache.items.find((item) => item.template?.name === 'Atuba Mace');
const entryDSword = DataCache.items.find((item) => String(item.etc?.rank).toLowerCase() === 'd' && item.template?.kind === 'Weapon.Sword');
const noGradeSword = DataCache.items.find((item) => String(item.etc?.rank).toLowerCase() === 'none' && item.template?.kind === 'Weapon.Sword');
const equippedUpgrade = GearAcquisitionPlanner.equipInventoryUpgrades({ level: 20, stats: { role: 'tank' } }, {
    [noGradeSword.selfId]: { selfId: noGradeSword.selfId, amount: 1, equipped: true, slot: 7 },
    [entryDSword.selfId]: { selfId: entryDSword.selfId, amount: 1, equipped: false, slot: 7 }
});
assert.strictEqual(equippedUpgrade[entryDSword.selfId].equipped, true, 'a useful D drop must equip immediately in the cold inventory');
assert.strictEqual(equippedUpgrade[noGradeSword.selfId].equipped, false, 'the replaced no-grade weapon must be unequipped');
const entryDTarget = GearAcquisitionPlanner.preferredTarget({ level: 20, stats: { classId: 0, role: 'dps' }, inventory: {} });
assert(entryDTarget, 'a new D-grade bot must receive an attainable equipment target');
assert(Number(entryDTarget.item.template.price) < Number(atubaMace.template.price), 'a fresh D-grade bot must not begin by chasing the top D weapon');
const entryDArcherTarget = GearAcquisitionPlanner.preferredTarget({ level: 20, stats: { classId: 3, role: 'archer' }, inventory: {} });
assert(entryDArcherTarget, 'an archer must retain a D-grade target when every entry bow is above the early cap');
assert.strictEqual(entryDArcherTarget.item.template.kind, 'Weapon.Bow', 'an archer must keep weapon-first progression even when its entry bow exceeds the cap');
assert(Number.isFinite(GearAcquisitionPlanner.progressionPriceCap('d', 39)), 'D-grade planning must retain an adequate-kit ceiling through the whole grade band');
assert(Number.isFinite(GearAcquisitionPlanner.progressionPriceCap('c', 51)), 'C-grade planning must retain an adequate-kit ceiling through the whole grade band');
const fullLeather = DataCache.items.find((item) => item.etc?.rank === 'd' && item.template?.kind === 'Armor.Leather' && Number(item.etc?.slot) === 15);
const leatherChest = DataCache.items.find((item) => item.etc?.rank === 'd' && item.template?.kind === 'Armor.Leather' && Number(item.etc?.slot) === 10);
const leatherLegs = DataCache.items.find((item) => item.etc?.rank === 'd' && item.template?.kind === 'Armor.Leather' && Number(item.etc?.slot) === 11);
assert(fullLeather && leatherChest && leatherLegs, 'the datapack must expose D leather full and separate body armour for equip arbitration');
const equipInventory = (items) => GearAcquisitionPlanner.equipInventoryUpgrades(
    { level: 20, stats: { role: 'archer' } },
    Object.fromEntries(items.map((item) => [item.selfId, { selfId: item.selfId, amount: 1, slot: item.etc.slot }]))
);
const equippedIds = (inventory) => Object.values(inventory)
    .filter((item) => item.equipped)
    .map((item) => Number(item.selfId))
    .sort((left, right) => left - right);
const fullFirst = equippedIds(equipInventory([fullLeather, leatherChest, leatherLegs]));
const separateFirst = equippedIds(equipInventory([leatherChest, leatherLegs, fullLeather]));
assert.deepStrictEqual(fullFirst, separateFirst, 'full-body and chest/legs equipment must resolve identically regardless of inventory insertion order');
assert(!(fullFirst.includes(fullLeather.selfId) && (fullFirst.includes(leatherChest.selfId) || fullFirst.includes(leatherLegs.selfId))), 'a full-body item must never equip alongside a conflicting chest or legs item');
const lowDSource = { spotLevel: 18 };
const tankReadiness = GearAcquisitionPlanner.combatReadiness({
    level: 20,
    stats: { role: 'tank' },
    inventory: { 1: { selfId: 1, amount: 1, equipped: true }, 10: { selfId: 10, amount: 1, equipped: true } }
});
const healerReadiness = GearAcquisitionPlanner.combatReadiness({ level: 20, stats: { role: 'healer' }, inventory: {} });
assert(tankReadiness.effectiveLevel > healerReadiness.effectiveLevel, 'readiness must recognise that a geared tank can take safer solo routes than an unprepared support');
assert.strictEqual(GearAcquisitionPlanner.soloSafeForSource({ level: 20, stats: { role: 'tank' }, inventory: { 1: { selfId: 1, amount: 1, equipped: true } } }, lowDSource), true, 'a tank may solo an entry D route when its actual kit supports it');
assert.strictEqual(GearAcquisitionPlanner.soloSafeForSource({ level: 20, stats: { role: 'healer' }, inventory: {} }, lowDSource), false, 'an unprepared support must wait for party help at the same route');
assert(Number(target.item.template.price) <= 2290000, 'a new C-grade bot must begin with an entry-tier weapon target');
const station = ColdCraftingService.stationForRecipe(target.recipe.recipeId);
assert(station, 'a selected equipment recipe must be published by a Giran crafting station');
const entryWeaponOnly = {
    [target.item.selfId]: { selfId: target.item.selfId, amount: 1 }
};
const afterEntryWeapon = GearAcquisitionPlanner.preferredTarget({ ...mage, inventory: entryWeaponOnly });
assert(!['Weapon.Sword', 'Weapon.Blunt'].includes(afterEntryWeapon.item.template.kind), 'a C-grade mage must gear another slot after its entry weapon instead of crafting alternate weapons');
let entryBandInventory = {};
for (;;) {
    const entryBandTarget = GearAcquisitionPlanner.preferredTarget({ ...mage, inventory: entryBandInventory });
    if (!entryBandTarget) break;
    assert(Number(entryBandTarget.item.template.price) <= 2290000, 'level-40 bots must stop after their entry C band instead of falling through to top C gear');
    entryBandInventory = {
        ...entryBandInventory,
        [entryBandTarget.item.selfId]: { selfId: entryBandTarget.item.selfId, amount: 1 }
    };
}
const midCMageTarget = GearAcquisitionPlanner.preferredTarget({ ...mage, level: 44 });
assert(Number(midCMageTarget.item.template.price) <= 2870000, 'mid-C bots must not skip straight to the expensive endgame C weapons');
const lateCMageTarget = GearAcquisitionPlanner.preferredTarget({ ...mage, level: 48 });
assert(Number(lateCMageTarget.item.template.price) <= 4300000, 'late-C bots must receive a progression target below top C gear');
for (const recipeId of [191, 192, 198, 199, 201, 205, 208, 209, 213, 214, 216, 217, 312, 220, 222, 223, 228, 230, 234, 237, 238, 240]) {
    assert(ColdCraftingService.stationForRecipe(recipeId), `C progression recipe ${recipeId} must be available from a Giran craft station`);
}

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
assert.strictEqual(travel.stats.travel.method, 'soe_gatekeeper', 'a remote craft station visit must use SoE and the Giran gatekeeper rather than map-walking');
assert.strictEqual(travel.stats.travel.arrivalAt - travel.stats.travel.startedAt, ColdCraftingService.NATIVE_TRAVEL_MS, 'craft station transit must remain a short native-travel sequence');
assert.strictEqual(travel.stats.craftReturn.spotId, null, 'craft travel must preserve the previous hunting destination for the return trip');
const readyPlan = GearAcquisitionPlanner.planFor({ ...mage, inventory: readyInventory }, { spots: [] });
assert.strictEqual(readyPlan.status, 'ready_to_craft', 'a complete material list must become a station visit, not a blocked farming plan');

const oriharkonRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(27);
const syntheticCokesRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(36);
const atubaMaceRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(189);
const steelRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(30);
const crystalSupplement = invoke('GameServer/Bot/Economy/CraftSupplementMaterials');
const atubaWithCokesIngredients = atubaMaceRecipe.materials.reduce((inventory, material) => {
    if (Number(material.selfId) === 1879 || crystalSupplement.isSupplementalMaterial(material.selfId)) return inventory;
    inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };
    return inventory;
}, {
    1870: { selfId: 1870, amount: 3 },
    1871: { selfId: 1871, amount: 3 }
});
const componentPlan = GearAcquisitionPlanner.planFor({
    level: 20,
    stats: { classId: 0, role: 'dps' },
    inventory: atubaWithCokesIngredients
}, { spots: [], recipeId: atubaMaceRecipe.recipeId });
assert.strictEqual(componentPlan.status, 'component_ready', 'a ready Cokes batch must be distinguished from final Atuba Mace readiness');
assert.strictEqual(componentPlan.requiresParty, false, 'a ready component must go to its station instead of waiting for a party for a later farming source');
assert(ColdCraftingService.beginTravel({
    level: 20,
    activity: 'hunting',
    inventory: atubaWithCokesIngredients,
    stats: { equipmentPlan: componentPlan }
}, 1000), 'a component-ready plan must still travel to its crafting station');
const resourceStationRecipeIds = new Set(CraftShopService.stationRecipes(
    CraftShopService.CraftStations.find((entry) => entry.id === 'resource_core'),
    CraftShopService.availableRecipes({ level: 70, stats: { classId: 57 } })
).map((recipe) => Number(recipe.recipeId)));
for (const recipeId of [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]) {
    assert(resourceStationRecipeIds.has(recipeId), `resource station must publish crafted component recipe ${recipeId}`);
}
const resourceProfile = CraftShopService.profileFor({
    level: 70,
    stats: { classId: 57, generatedIndex: 10026, craftStationId: 'resource_core', craftShop: { entries: [{ recipeId: 32 }] } }
});
assert(resourceProfile.entries.some((entry) => Number(entry.recipeId) === 29), 'public resource stations must regenerate their full catalogue instead of retaining stale persisted entries');
assert.strictEqual(resourceProfile.entries.length, 15, 'public resource stations must retain every published base component recipe');
const resourceState = {
    inventory: {
        1879: { selfId: 1879, amount: 3 },
        1874: { selfId: 1874, amount: 1 },
        1873: { selfId: 1873, amount: 12 },
        1872: { selfId: 1872, amount: 4 }
    }
};
assert.strictEqual(crystalSupplement.isSupplementalMaterial(1458), true, 'crystals must be supplemented only at the final manufacture step');
assert.strictEqual(crystalSupplement.isSupplementalMaterial(2130), true, 'gemstones must be supplemented only at the final manufacture step');
assert.strictEqual(crystalSupplement.isSupplementalMaterial(1869), false, 'farmable craft resources must never be supplemented');
assert.strictEqual(
    ColdCraftingService.hasNonSupplementalMaterials([{ selfId: 1869, amount: 5 }], {
        materials: [{ selfId: 1869, amount: 5 }, { selfId: 1458, amount: 99 }]
    }),
    true,
    'missing supplements must not block a final manufacture'
);
assert.strictEqual(
    ColdCraftingService.hasNonSupplementalMaterials([{ selfId: 1869, amount: 4 }], {
        materials: [{ selfId: 1869, amount: 5 }, { selfId: 1458, amount: 99 }]
    }),
    false,
    'supplements must not be granted when a real craft material is missing from the live inventory'
);
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
assert.strictEqual(
    ColdCraftingService.requiredCraftCount(atubaMaceRecipe, steelRecipe, { inventory: {} }),
    220,
    'a final recipe must request the full missing component batch, not only one Steel'
);
assert.strictEqual(
    ColdCraftingService.craftableBatchCount(steelRecipe.materials.map((material, index) => ({
        id: index + 1,
        selfId: material.selfId,
        amount: Number(material.amount) * 220
    })), steelRecipe, 220),
    220,
    'a station must craft the whole prepared component batch in one exchange'
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
