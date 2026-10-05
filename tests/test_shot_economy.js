const assert = require('assert');

require('../src/Global');

const previousRate = process.env.L2NODE_PROGRESSION_RATE;
process.env.L2NODE_PROGRESSION_RATE = 'x10';

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const PriceScale = require('../src/GameServer/World/Generics/NpcShopPriceScale');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');

assert.strictEqual(PriceScale.price(250, 1), 250);
assert.strictEqual(PriceScale.price(250, 10), 500);
assert(PriceScale.price(250, 50) < 250 * 5, 'even x50 must avoid a linear NPC price jump');
assert.strictEqual(NpcShopBuyLists.fetchForNpc(7315).find((row) => row.selfId === 1785)?.price,
    600, 'the taxed Gludio Soul Ore price should double at x10');

const dwarf = { characterId: 100, classId: 57, level: 60, adena: 1000000,
    stats: { classId: 57 }, inventory: {}, vitals: { mp: 1000 } };
const dRecipeItem = { selfId: 1804, name: 'Recipe: Soulshot: D-Grade', amount: 1 };
assert.strictEqual(ItemDisposition.canLearnRecipe(dwarf, dRecipeItem), true,
    'a high-level crafter should still learn a D-grade shot recipe');
assert.strictEqual(ItemDisposition.isNpcOnlyItem(dRecipeItem), false,
    'shot recipes must be offered to other crafters before NPC liquidation');
const dRecipeSeller = { characterId: 101, level: 40, classId: 28,
    stats: { classId: 28 }, inventory: { 1804: { ...dRecipeItem, kind: 'Other.Recipe' } } };
const dRecipeListing = ItemDisposition.saleCandidates(dRecipeSeller, { unlimited: true })
    .find((item) => item.selfId === 1804);
assert.strictEqual(dRecipeListing?.rank, 'd', 'D-grade shot recipes must follow the D market');
assert.strictEqual(MarketTownPolicy.targetTownForItems(dRecipeSeller, [dRecipeListing]),
    MarketTownPolicy.dGradeMarketFor(dRecipeSeller));
assert.strictEqual(MarketTownPolicy.targetTownForItems(dRecipeSeller, [{ selfId: 1804 }]),
    MarketTownPolicy.dGradeMarketFor(dRecipeSeller),
    'a restored AFK recipe line must retain the grade of its product');
assert.strictEqual(MarketTownPolicy.targetTownForItems(dRecipeSeller, [{ selfId: 1805 }]), 'Giran');

const now = Date.now();
const buyer = { characterId: 200, name: 'Buyer', adena: 100000,
    stats: { shotDemand: { itemId: 1463, amount: 1000, maxSpend: 90000, at: now } } };
const signal = MarketDemandIndex.demandSignal(buyer, 1463, now);
assert.strictEqual(signal.amount, 1000);
assert.strictEqual(signal.budget, 90000);
assert.strictEqual(signal.source, 'shots');

// A shot lot and a shot recipe are the market's like any item (group E):
// no floor to match, no demand count to fill; the expected value decides.
const shotLot = { selfId: 1463, name: 'Soulshot: D-grade', kind: 'Other.Shot',
    count: 10000, price: 90, basePrice: 10 };
assert.strictEqual(MarketListingPolicy.classify(dwarf, shotLot).action, 'market');
assert.strictEqual(MarketListingPolicy.listingPrice, undefined, 'no listing floor');
const recipeSeller = { characterId: 201, name: 'LootSeller', level: 50, classId: 28,
    adena: 100000, stats: {}, inventory: { '1805': {
        selfId: 1805, name: 'Recipe: Soulshot: C-Grade', amount: 1, kind: 'Other.Recipe'
    } } };
const recipeItem = ItemDisposition.saleCandidates(recipeSeller, { unlimited: true })
    .find((item) => item.selfId === 1805);
assert(recipeItem, 'a non-crafter holding a shot recipe should be able to sell it');
assert.strictEqual(recipeItem.rank, 'c', 'C-grade shot recipes belong in Giran');
assert.strictEqual(MarketListingPolicy.classify(recipeSeller, recipeItem).action, 'market');

const index = {
    itemTemplates: new Map(DataCache.items.map((item) => [Number(item.selfId), item])),
    npcPrice: new Map([[1785, 550]]),
    gear: new Map([
        ['d', [{ selfId: 45, price: 22324, crystals: 56, source: 'afk', count: 1, ownerId: 201 }]],
        ['c', [{ selfId: 325, price: 100000, crystals: 1148, source: 'afk', count: 1, ownerId: 202 }]]
    ]),
    shotDemand: new Map([[1463, [{ characterId: 200, amount: 1000, budget: 1000000 }]]]),
    shotSupply: new Map()
};
const recipe = Recipes.resolveByRecipeId(20);
const candidate = Shots.craftCandidate(dwarf, recipe, index);
assert(candidate, 'a level-60 dwarf may choose profitable D-grade shots');
assert.strictEqual(ItemDisposition.priceFor({ ...dwarf, stats: {
    ...dwarf.stats, shotCraft: { productId: 1463, unitPrice: candidate.salePrice }
} }, { selfId: 1463, amount: recipe.productCount }, index.itemTemplates.get(1463)),
candidate.salePrice, 'the published shot price must match the profitable route calculation');
assert.strictEqual(Shots.recipeTarget(dwarf, { ...index, recipeStock: new Map([[1805, 1]]),
    shotDemand: new Map([[1464, [{ characterId: 200, amount: 1000, budget: 1000000 }]]]), shotSupply: new Map() })?.recipeItemId, 1805,
    'a crafter should ask for a recipe that somebody actually holds');
assert.strictEqual(Shots.recipeTarget(dwarf, { ...index, recipeStock: new Map([[1805, 1]]),
    shotDemand: new Map(), shotSupply: new Map() }), null,
    'a crafter should not buy a recipe for a shot with no market demand');
assert.strictEqual(Shots.recipeTarget(dwarf, { ...index, recipeStock: new Map([[1805, 1]]) })?.recipeItemId,
    1804, 'a viable D-grade route should create recipe demand even before somebody lists the recipe');
assert.strictEqual(Shots.recipeTarget(dwarf, { ...index, recipeStock: new Map([[1805, 1]]) }, [318])?.recipeItemId,
    1804, 'knowing a higher-grade recipe must not prevent a profitable D-grade route');
assert.strictEqual(candidate.requiredCrystals, 1);
assert.strictEqual(candidate.ore.selfId, 1785);
assert(candidate.profit > 100);
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const originalOffers = Afk.offers;
try {
    Afk.offers = id => Number(id) === 1458
        ? [{ sourceId: 500, price: 50, count: 100 }] : [];
    assert.strictEqual(Shots.craftCandidate(dwarf, recipe, index).gear.source, 'crystals',
        'cheap actual crystal offers should beat buying and breaking equipment');
    Afk.offers = () => [{ sourceId: 500, price: 1, count: 1000 }];
    const routes = Shots.scrapCraftRoutes(dwarf, [{ recipeId: 44 }], index);
    assert.strictEqual(routes.length, 1, 'a learned guaranteed equipment recipe can source crystals');
    assert.strictEqual(routes[0].cash, 25);
    assert.strictEqual(routes[0].crystals, 65);
    assert.strictEqual(Shots.scrapCraftRoutes(dwarf, [], index).length, 0,
        'unknown equipment recipes cannot be used for crystal production');
    assert.strictEqual(Shots.scrapCraftRoutes({ ...dwarf, vitals: { mp: 84 } }, [{ recipeId: 44 }], index).length, 0,
        'equipment crafting must leave MP for shots');
    Afk.offers = () => [];
    assert.strictEqual(Shots.scrapCraftRoutes(dwarf, [{ recipeId: 44 }], index).length, 0,
        'missing component supply must close the equipment craft route');
} finally { Afk.offers = originalOffers; }
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const originalHotOffers = MarketOpportunity.hotOffers;
try {
    MarketOpportunity.hotOffers = () => [{ sourceType: 'afk_bot_store', sourceId: 500,
        projection: { actor: { fetchId: () => 900500, fetchLocX: () => 1,
            fetchLocY: () => 2, fetchLocZ: () => 3 } } }];
    const actor = { fetchId: () => 1 };
    const target = ShotStock.restockTarget(actor, 'Giran');
    assert.strictEqual(target.actorId, 900500);
    assert.strictEqual(target.sourceId, 500);
    assert.strictEqual(ShotStock.restockTarget(actor, 'Giran', [target.sourceId]), null,
        'an unreachable AFK projection must be excluded by its shop owner identity');
} finally { MarketOpportunity.hotOffers = originalHotOffers; }
const ownSupply = { ...dwarf, inventory: { '129': {
    selfId: 129, amount: 1, equipped: true, slot: 7
}, '1463': { selfId: 1463, amount: ShotStock.PURCHASE_TARGET_AMOUNT + 156, kind: 'Other.Shot' } } };
assert(Shots.hasShotSurplus({ ...ownSupply, stats: { shotCraft: { productId: 1463 } } }),
    'leftover crafted shots must be admitted for a listing review');
assert(!Shots.hasShotSurplus({ ...ownSupply, stats: { shotCraft: { productId: 1463 } },
    inventory: { ...ownSupply.inventory, 1463: { selfId: 1463, amount: ShotStock.PURCHASE_TARGET_AMOUNT } } }),
    'the personal reserve alone must not trigger a surplus listing review');
assert.strictEqual(ItemDisposition.saleCandidates(ownSupply, { unlimited: true })
    .find((item) => item.selfId === 1463)?.count, 156,
    'a shot seller must keep enough stock for their own weapon: what its restock fills it to');
index.shotSupply.set(1463, 1000);
assert.strictEqual(Shots.craftCandidate(dwarf, recipe, index), null,
    'existing shot supply must close the speculative crafting route');

if (previousRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
else process.env.L2NODE_PROGRESSION_RATE = previousRate;

console.log('Shot economy pricing, recipe and demand checks passed');
