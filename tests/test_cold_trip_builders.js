const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

// Pins every cold trip a builder starts (U18): the market trip and its return
// (GoalExecutor), the craft station trip and its three returns
// (ColdCraftingService), the Mammon trip and its return (BotMammonUnseal), the
// hunting route (HuntingTravel) and the karma washing walk (ColdKarmaPolicy),
// with [BotPopulation] coldHonestTravel off (the default).
// Each case records the trip, the timing and the stats the builder writes; the
// digest lives in tests/fixtures/cold_trip_builders.json. Run with --record to
// rewrite it after a decided change, and review the diff.
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const DualSwords = invoke('GameServer/Items/C4DualSwordCombinations');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Mammon = invoke('GameServer/World/GiranMammon');
const MammonUnseal = invoke('GameServer/Bot/AI/BotMammonUnseal');

const FIXTURE = path.join(__dirname, 'fixtures', 'cold_trip_builders.json');
const RECORD = process.argv.includes('--record');
const T = 1000000;
const DION_FIELD = { locX: 22000, locY: 140000, locZ: -3000 };
const SPOT = { id: '19_-19', name: 'Pinned hunting ground', center: { locX: 116000, locY: -180000, locZ: -900 } };
// Everything a trip may pay with, so a later payment shows as a digest change.
const WALLET = { 57: { selfId: 57, name: 'Adena', amount: 500000 }, 736: { selfId: 736, name: 'Scroll of Escape', amount: 3 } };

// The part of a state a trip builder writes.
function digest(state) {
    if (!state) return null;
    const stats = state.stats || {};
    return {
        activity: state.activity,
        adena: state.adena ?? null,
        wallet: Object.fromEntries(['57', '736'].map((key) => [key, Number(state.inventory?.[key]?.amount ?? 0)])),
        timing: state.timing || null,
        travel: stats.travel || null,
        marketReturn: stats.marketReturn ?? null,
        craftReturn: stats.craftReturn ?? null,
        mammonReturn: stats.mammonReturn ?? null,
        mammonRetryAt: stats.mammonRetryAt ?? null
    };
}

function withStubs(stubs, work) {
    const saved = stubs.map(([target, key]) => [target, key, target[key]]);
    stubs.forEach(([target, key, value]) => { target[key] = value; });
    const restore = () => saved.forEach(([target, key, value]) => { target[key] = value; });
    let result;
    try {
        result = work();
    } catch (error) {
        restore();
        throw error;
    }
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
}

function hunter(overrides = {}) {
    return {
        characterId: 4242,
        name: 'TripPin',
        phase: 'cold',
        level: 40,
        adena: 500000,
        activity: 'hunting',
        currentRegion: 'Dion fields',
        spotId: 'pin_spot',
        loc: { ...DION_FIELD },
        timing: { activityStartedAt: T - 50000, nextResolveAt: T - 1 },
        inventory: { ...WALLET },
        stats: { classId: 2 },
        ...overrides
    };
}

async function cases() {
    const out = {};

    out.market_sell = digest(GoalExecutor.beginMarketTravel(hunter(), {
        type: 'sell_inventory', plan: { expectedBenefit: 'market_sale_inventory', cleanupReason: 'inventory_full' }
    }, T));
    // The trip builder is pinned here; whether a purchase trip pays for itself
    // (24512a44) has its own fixture (test_acquisition_trip_value.js).
    out.market_buy = withStubs([
        [invoke('GameServer/Bot/Economy/ColdMarketService'), 'canTravelForPurchase', () => true]
    ], () => digest(GoalExecutor.beginMarketTravel(hunter(), {
        type: 'upgrade_gear', plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Giran' }
    }, T)));

    const giranCenter = { locX: 83396, locY: 147904, locZ: -3400 };
    const shopping = hunter({
        activity: 'shopping', currentRegion: 'Giran', loc: giranCenter, spotId: null,
        stats: { classId: 2, marketReturn: { loc: { ...SPOT.center }, regionName: SPOT.name, spotId: SPOT.id } }
    });
    out.market_return = withStubs([
        [SpotService, 'findById', (id) => (id === SPOT.id ? SPOT : null)],
        [SpotProfiles, 'findForState', () => SPOT],
        [SpotService, 'arrivalPointForState', (_state, spot) => ({ ...spot.center, locX: spot.center.locX + 100 })]
    ], () => digest(GoalExecutor.finishMarketVisit(shopping, T)));

    // Dual sword combine: the station trip and the return after combining.
    const saberRevolution = DualSwords.resolveByProductId(2523);
    const swords = {
        123: { selfId: 123, name: 'Saber', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7, rank: 'd', kind: 'Weapon.Sword' },
        129: { selfId: 129, name: 'Sword of Revolution', amount: 1, equipped: false, equippedCount: 0, equippedSlots: [], slot: 7, rank: 'd', kind: 'Weapon.Sword' }
    };
    const dualState = hunter({ inventory: { ...WALLET, ...swords }, stats: { classId: 2, role: 'dps', forcedRecipeId: saberRevolution.recipeId } });
    const dualPlan = GearAcquisitionPlanner.planFor(dualState, { recipeId: saberRevolution.recipeId, spots: [], findMarketOffer: () => null });
    const dualTrip = ColdCraftingService.beginTravel({ ...dualState, stats: { ...dualState.stats, equipmentPlan: dualPlan } }, T);
    out.craft_dual = digest(dualTrip);

    const craftReturn = { loc: { ...DION_FIELD }, spotId: 'pin_spot', regionName: 'Dion fields' };
    const atStation = { ...dualTrip, activity: 'crafting', loc: { ...dualTrip.stats.travel.to },
        stats: { ...dualTrip.stats, travel: null, craftReturn } };
    out.craft_dual_return = await withStubs([
        [Date, 'now', () => T],
        [Database, 'fetchItems', async () => [
            { id: 1, selfId: 123, amount: 1, equipped: 1, slot: 7 },
            { id: 2, selfId: 129, amount: 1, equipped: 0, slot: 0 },
            { id: 3, selfId: 57, amount: 500000, equipped: 0, slot: 0 }
        ]],
        [Database, 'combineInventoryItems', async (_id, value) => ({ product: { id: 99, selfId: value.product.selfId, amount: 1 } })],
        [LifeState, 'refreshInventory', async (state) => state]
    ], async () => digest((await ColdCraftingService.craft(atStation)).state));

    // A nested component crafted at a public station, then the return.
    const finalRecipe = Recipes.resolveByRecipeId(189);
    const componentRecipe = Recipes.resolveByRecipeId(29);
    const componentItems = componentRecipe.materials.map((material, index) => ({ id: index + 1, selfId: material.selfId, amount: material.amount * 3 }));
    componentItems.push({ id: 99, selfId: 57, amount: 500000 });
    const componentInventory = { ...WALLET, ...Object.fromEntries(componentItems.map((item) => [item.selfId, { ...item }])) };
    finalRecipe.materials.filter((material) => Number(material.selfId) !== Number(componentRecipe.productId))
        .forEach((material) => { componentInventory[material.selfId] = { selfId: material.selfId, amount: material.amount }; });
    const crafterStubs = (items, stationId) => [
        [Date, 'now', () => T],
        [Database, 'fetchCharacters', async () => [{ id: 900 }]],
        [Database, 'fetchItems', async () => items],
        [Database, 'craftForCustomer', async () => ({ ok: true })],
        [LifeState, 'findByCharacterId', async () => ({ characterId: 900, level: 70, phase: 'cold', vitals: { mp: 1, maxMp: 1000 },
            stats: { classId: 57, craftStationId: stationId } })],
        [LifeState, 'upsertState', async (state) => state],
        [LifeState, 'refreshInventory', async (state) => state]
    ];
    out.craft_component_return = await withStubs(crafterStubs(componentItems, 'resource_core'), async () => digest((await ColdCraftingService.craft(hunter({
        activity: 'crafting', loc: { locX: 83396, locY: 147904, locZ: -3400 }, inventory: componentInventory,
        stats: { classId: 2, equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: finalRecipe.recipeId }, craftReturn }
    }))).state));

    // The final equipment crafted at a public station, then the return.
    const finalItems = finalRecipe.materials.map((material, index) => ({ id: index + 1, selfId: material.selfId, amount: material.amount }));
    finalItems.push({ id: 99, selfId: 57, amount: 500000 });
    const finalInventory = { ...WALLET, ...Object.fromEntries(finalItems.map((item) => [item.selfId, { ...item }])) };
    out.craft_equipment_return = await withStubs(crafterStubs(finalItems, 'd_weapons'), async () => digest((await ColdCraftingService.craft(hunter({
        activity: 'crafting', loc: { locX: 83396, locY: 147904, locZ: -3400 }, inventory: finalInventory,
        stats: { classId: 2, equipmentPlan: { status: 'ready_to_craft', strategy: 'craft', recipeId: finalRecipe.recipeId }, craftReturn }
    }))).state));

    // The Mammon trip and its return (away from the Blacksmith: nothing unsealed).
    const sealed = hunter({ inventory: { ...WALLET, 6674: { selfId: 6674, amount: 1 } } });
    const mammonTrip = MammonUnseal.beginTravel(sealed, T);
    out.mammon = digest(mammonTrip);
    out.mammon_return = await withStubs([
        [LifeState, 'refreshInventory', async (state) => state]
    ], async () => digest(await MammonUnseal.finish({ ...mammonTrip, activity: 'crafting',
        loc: { locX: Mammon.loc.locX + 5000, locY: Mammon.loc.locY, locZ: Mammon.loc.locZ },
        stats: { ...mammonTrip.stats, travel: null } }, T)));

    // The hunting route (solo and party) and the karma washing walk: with
    // coldHonestTravel off these keep the author's times.
    const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');
    const route = { needed: true, mode: 'solo', spotId: SPOT.id, regionName: SPOT.name, travelMs: 25000, to: { ...SPOT.center } };
    out.hunting_solo = digest(beginHuntingTrip(hunter(), route, T));
    out.hunting_party = digest(beginHuntingTrip(hunter({ party: { partyId: 'pin' } }), { ...route, mode: 'party' }, T));
    // Keep the pinned ground height independent of optional local geodata files;
    // the real arrival builder still chooses the offset and route.
    out.karma_washing = withStubs([
        [invoke('GameServer/Geodata/GeodataEngine'), 'getHeight', () => -2544]
    ], () => digest(invoke('GameServer/Bot/Population/ColdKarmaPolicy').plan(hunter({ stats: { classId: 2, karma: 100 } }), [{
        id: 'wash', name: 'Wash', minLevel: 35, maxLevel: 45, center: { locX: 40000, locY: 140000, locZ: -3000 },
        npcEntries: [{ selfId: 20001, level: 38 }]
    }], T).plannedState));
    return out;
}

cases().then((out) => {
    const actual = JSON.parse(JSON.stringify(out));
    if (RECORD) {
        fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
        console.log(`recorded ${Object.keys(actual).length} cold trip cases`);
        return;
    }
    const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    assert.deepStrictEqual(Object.keys(actual), Object.keys(expected), 'the pinned trip cases');
    for (const key of Object.keys(expected)) {
        assert.ok(actual[key], `${key}: the builder starts a trip`);
        assert.deepStrictEqual(actual[key], expected[key], `${key}: the trip matches the pinned digest`);
    }
    console.log('cold trip builder pins passed');
}).then(() => process.exit(0), (error) => {
    console.error(error);
    process.exit(1);
});
