// Native shot decisions, shared by town reviews and the cold worker.
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const StaticMerchantPricing = require('./StaticMerchantPricing');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Profit = require('./CraftProfitPolicy');
const PurchaseFunding = require('./PurchaseFunding');
const SHOT_RECIPE_IDS = [20, 21, 22, 23, 24, 317, 318, 319, 320, 321,
    323, 324, 325, 326, 327];
const SHOT_PRODUCT_IDS = new Set(SHOT_RECIPE_IDS
    .map((id) => Number(Recipes.resolveByRecipeId(id)?.productId || 0)).filter(Boolean));
const SHOT_RECIPE_ITEM_IDS = new Set(SHOT_RECIPE_IDS
    .map((id) => Number(Recipes.resolveByRecipeId(id)?.recipeItemId || 0)).filter(Boolean));
const CRYSTAL_BY_RANK = { d: 1458, c: 1459, b: 1460, a: 1461, s: 1462 };
const SHOT_RANK_BY_ID = new Map([
    [1463, 'd'], [2510, 'd'], [3948, 'd'],
    [1464, 'c'], [2511, 'c'], [3949, 'c'],
    [1465, 'b'], [2512, 'b'], [3950, 'b'],
    [1466, 'a'], [2513, 'a'], [3951, 'a'],
    [1467, 's'], [2514, 's'], [3952, 's']
]);
function fundedDemand(index, productId, price, characterId) {
    const signals = index.shotDemand.get(Number(productId)) || [];
    return signals.reduce((sum, signal) => sum + (Number(signal.characterId) === Number(characterId) ? 0
        : (Number(signal.maxPrice ?? Infinity) < price ? 0 : Math.min(Number(signal.amount), Math.floor(Number(signal.budget) / price)))), 0);
}


function recipeTarget(state, index = null, knownRecipeIds = []) {
    const known = new Set(knownRecipeIds.map(Number));
    const candidates = SHOT_RECIPE_IDS
        .filter((id) => !known.has(id))
        .map((id) => Recipes.resolveByRecipeId(id))
        .filter((recipe) => recipe && CraftShopService.canCraft(state, recipe));
    const needed = candidates;
    const viable = index ? needed.map((recipe) => ({ recipe, route: craftCandidate(state, recipe, index) }))
        .filter((entry) => entry.route) : needed.map((recipe) => ({ recipe, route: null }));
    viable.sort((left, right) =>
        Number(index?.recipeStock?.get(Number(right.recipe.recipeItemId)) > 0)
            - Number(index?.recipeStock?.get(Number(left.recipe.recipeItemId)) > 0)
        || Number(right.route?.profit || 0) - Number(left.route?.profit || 0));
    return viable.find(entry => entry.route?.profit > 0) || null;
}


function availableMaterial(state, selfId) {
    const reserved = ItemDisposition.reservedEquipmentAmounts(state);
    return Math.max(0, Number(state.inventory?.[selfId]?.amount || 0)
        - Math.max(Number(reserved[selfId] || 0), Number(state.stats?.clanMaterialDemand?.[selfId] || 0)));
}

function scrapCraftRoutes(state, knownRecipes, index) {
    const routes = [];
    const owned = new Map(ItemDisposition.saleCandidates(state, { unlimited: true })
        .map(item => [Number(item.selfId), item]));
    const prices = new Map();
    const purchasePrice = id => {
        if (!prices.has(id)) {
            const offers = index.offersFor(id, 1, state.characterId);
            prices.set(id, { offers, npc: Number(index.npcPrice.get(id) || Infinity) });
        }
        return prices.get(id);
    };
    for (const known of knownRecipes) {
        const recipe = Recipes.resolveByRecipeId(known.recipeId);
        const template = recipe && index.itemTemplates.get(Number(recipe.productId));
        if (!recipe || recipe.type !== 'dwarven' || !CraftShopService.canCraft(state, recipe)
            || Number(recipe.successRate) !== 100 || Number(recipe.productCount) !== 1
            || !/^(Weapon|Armor)\./.test(String(template?.template?.kind || ''))
            || Number(template?.etc?.cristals || 0) <= 0 || Number(recipe.mpCost) >= Number(state.vitals?.mp || 0)) continue;
        let cost = 0, cash = 0;
        const inputs = [];
        for (const material of recipe.materials || []) {
            const id = Number(material.selfId), amount = Number(material.amount);
            const stock = owned.get(id);
            const own = Math.min(amount, Number(stock?.count || 0));
            const { offers, npc } = purchasePrice(id);
            // Each ingredient must have a concrete source for the whole deficit.
            const offer = offers.filter(o => Number(o.count) >= amount - own && Number(o.price) > 0)
                .sort((a, b) => a.price - b.price)[0];
            const price = Math.min(npc, Number(offer?.price || Infinity));
            if (own < amount && !Number.isFinite(price)) { cost = Infinity; break; }
            const spend = own < amount ? (amount - own) * price : 0;
            cost += own * Number(stock?.price || 0) + spend;
            cash += spend;
            inputs.push({ selfId: id, amount, npcPrice: npc, maxPrice: price });
        }
        if (!Number.isFinite(cost) || cost <= 0 || cash > PurchaseFunding.spendable(state, 0, { upperBound: true })) continue;
        routes.push({ selfId: Number(recipe.productId), rank: template.etc.rank,
            source: 'craft', crystals: Number(template.etc.cristals), price: cost, cash,
            unitValue: cost / Number(template.etc.cristals), recipe, inputs });
    }
    return routes;
}

function crystalRoute(state, rank, crystalId, required, index) {
    const routes = (index.gear.get(rank) || []).filter(gear => gear.ownerId !== Number(state.characterId)
        && gear.price <= PurchaseFunding.spendable(state, 0, { upperBound: true }))
        .map(gear => ({ ...gear, cash: gear.price, unitValue: gear.price / gear.crystals }));
    routes.push(...(index.scrapCraftRoutes || []).filter(route => route.rank === rank));
    for (const stock of ItemDisposition.saleCandidates(state, { unlimited: true })) {
        const template = index.itemTemplates.get(Number(stock.selfId));
        if (template?.etc?.rank !== rank || Number(template?.etc?.cristals || 0) < required
            || !/^(Weapon|Armor)\./.test(String(template?.template?.kind || ''))
            || stock.npcComparable === false || Number(stock.enchant || 0) > 0) continue;
        routes.push({ selfId: Number(stock.selfId), source: 'owned', crystals: Number(template.etc.cristals),
            price: stock.price, cash: 0, unitValue: stock.price / Number(template.etc.cristals) });
    }
    for (const offer of index.offersFor(crystalId, 1, state.characterId)) {
        if (Number(offer.price) <= 0 || Number(offer.count) < required) continue;
        routes.push({ selfId: crystalId, source: 'crystals', ownerId: Number(offer.sourceId),
            price: Number(offer.price), unitValue: Number(offer.price), cash: Number(offer.price) * required,
            crystals: Number(offer.count) });
    }
    return routes.filter(route => route.cash <= PurchaseFunding.spendable(state, 0, { upperBound: true }))
        .sort((a, b) => a.unitValue - b.unitValue || a.cash - b.cash)[0] || null;
}

function craftCandidate(state, recipe, index) {
    const output = index.itemTemplates.get(Number(recipe.productId));
    const rank = SHOT_RANK_BY_ID.get(Number(recipe.productId));
    const crystalId = CRYSTAL_BY_RANK[rank];
    if (!output || !crystalId) return null;
    const requiredCrystals = Number(recipe.materials.find(row => Number(row.selfId) === crystalId)?.amount || 0);
    const ore = recipe.materials.find(row => Number(row.selfId) !== crystalId);
    if (!requiredCrystals || !ore) return null;
    const context = index.context || Profit.contextFor(state, index.at);
    const fixed = StaticMerchantPricing.botPurchasePrice(recipe.productId);
    const competing = Number(index.shotMinPrice?.get(Number(recipe.productId)) || Infinity);
    const estimated = context.price?.(Number(recipe.productId))
        || invoke('GameServer/Bot/Economy/MarketCounters').firstPrice(recipe.productId);
    const fundedBid = Math.max(0, ...(index.shotDemand.get(Number(recipe.productId)) || [])
        .filter(signal => Number(signal.characterId) !== Number(state.characterId))
        .map(signal => Number(signal.maxPrice || 0)));
    const salePrice = Math.max(1, Math.floor(Math.min(fixed, competing,
        Math.max(fundedBid, Number(estimated) || 0) || Infinity)));
    if (!Number.isFinite(salePrice)) return null;
    const demand = Math.max(0, fundedDemand(index, recipe.productId, salePrice, state.characterId)
        - Number(index.shotSupply.get(Number(recipe.productId)) || 0)
        - Number(index.unlistedSupply?.get(Number(recipe.productId)) || 0));
    if (demand <= 0) return null;
    const ownedCrystals = availableMaterial(state, crystalId);
    const gear = crystalRoute(state, rank, crystalId, requiredCrystals, index);
    if (ownedCrystals < requiredCrystals && !gear) return null;
    const crystalValue = ownedCrystals >= requiredCrystals
        ? ItemDisposition.priceFor(state, { selfId: crystalId }, index.itemTemplates.get(crystalId))
        : gear.unitValue;
    const orePrice = Number(index.npcPrice.get(Number(ore.selfId)) || Infinity);
    if (!Number.isFinite(orePrice)) return null;
    const cost = Math.ceil(crystalValue * requiredCrystals + orePrice * Number(ore.amount));
    const margin = Profit.margin(recipe, salePrice, cost, context);
    const cash = (ownedCrystals >= requiredCrystals ? 0 : gear.cash) + orePrice * Number(ore.amount);
    const r = margin?.profit > 0 && cash > 0 ? margin.profit / context.hourAdena / cash : 0;
    if (!margin || margin.profit <= 0 || PurchaseFunding.spendable(state, 0, { r }) < cash) return null;
    const profit = margin.profit;
    return { recipe, output, rank, crystalId, requiredCrystals, ore, orePrice,
        gear: ownedCrystals >= requiredCrystals ? null : gear, salePrice, profit, cost, demand, r };
}

function batchCount(state, candidate) {
    const productPerBatch = Number(candidate.recipe.productCount);
    const orePerBatch = Number(candidate.ore.amount);
    const mpPerBatch = Number(candidate.recipe.mpCost || 0);
    const route = candidate.gear;
    const availableCrystals = availableMaterial(state, candidate.crystalId);
    const potentialCrystals = availableCrystals + Number(route?.crystals || 0);
    const fixedCash = route && route.source !== 'crystals' ? Number(route.cash || 0) : 0;
    const crystalCashPerBatch = route?.source === 'crystals' ? route.price * candidate.requiredCrystals : 0;
    return Math.min(64,
        Math.ceil(candidate.demand / productPerBatch),
        Math.floor(potentialCrystals / candidate.requiredCrystals),
        mpPerBatch > 0 ? Math.floor(Math.max(0, Number(state.vitals?.mp || 0) - Number(route?.recipe?.mpCost || 0)) / mpPerBatch) : 64,
        Math.floor(Math.max(0, PurchaseFunding.spendable(state, 0, { r: candidate.r }) - fixedCash)
            / (candidate.orePrice * orePerBatch + crystalCashPerBatch)));
}

function eligible(state, now = Date.now()) {
    return state?.phase === 'cold' && ['hunting', 'resting', 'shopping', 'grouped'].includes(state.activity)
        && CraftShopService.isServiceCrafter(state) && CraftShopService.craftLevelFor(state) >= 2
        && !state.party?.partyId && !state.partyId && !state.stats?.craftStationId
        && !require('../Population/CombinedErrandPolicy').pending(state, now).length
        && !(state.stats?.equipmentPlan?.strategy === 'craft'
            && ['active', 'component_ready', 'ready_to_craft'].includes(state.stats.equipmentPlan.status));
}
function decide(state, index, knownRecipeIds = []) {
    if (!eligible(state, index.at)) return null;
    // Existing published workshop entries also carry learned gear recipes
    // for the unchanged scrap-craft rule; shot DB ids arrive in context.
    const ids = new Set([...knownRecipeIds.map(Number), ...(state.stats?.workshop?.entries || []).map(row => Number(row.recipeId))]);
    const known = [...ids].map(recipeId => ({ recipeId }));
    const shotRecipes = known.map(row => Recipes.resolveByRecipeId(row.recipeId))
        .filter(recipe => recipe && SHOT_RECIPE_IDS.includes(Number(recipe.recipeId))
            && CraftShopService.canCraft(state, recipe));
    const view = { ...index, scrapCraftRoutes: scrapCraftRoutes(state, known, index) };
    const candidate = shotRecipes.map(recipe => craftCandidate(state, recipe, view)).filter(Boolean)
        .sort((a, b) => b.profit - a.profit)[0];
    if (candidate) {
        const batches = batchCount(state, candidate);
        if (batches > 0) return { craft: { recipeId: Number(candidate.recipe.recipeId), batches } };
    }
    const selected = recipeTarget(state, view, shotRecipes.map(recipe => Number(recipe.recipeId)));
    return selected ? { recipeTarget: Number(selected.recipe.recipeId) } : null;
}
// ARCH-NOTE: the native catalogue has fifteen shot recipes. Ordinary contexts
// carry <=8 IDs; a rare larger collection uses one negative 15-bit bitmap, so
// every known recipe is retained within the fixed eight-number/64-byte budget.
function packKnown(ids) {
    const shot = [...new Set(ids.map(Number))].filter(id => SHOT_RECIPE_IDS.includes(id));
    if (shot.length <= 8) return shot;
    return [-1 - shot.reduce((mask, id) => mask | (1 << SHOT_RECIPE_IDS.indexOf(id)), 0)];
}
function unpackKnown(ids = []) {
    if (ids.length === 1 && Number(ids[0]) < 0) {
        const mask = -1 - Number(ids[0]);
        return SHOT_RECIPE_IDS.filter((id, at) => mask & (1 << at));
    }
    return ids.map(Number).filter(id => SHOT_RECIPE_IDS.includes(id));
}
// ARCH-NOTE: named craft fields exceed +32 JSON bytes. Two numbers in the
// craft tuple, or a wealth recipe number, preserve the same decision and fit.
function packStep(step) {
    if (step?.craft) return { craft: [Number(step.craft.recipeId), Number(step.craft.batches)] };
    if (step?.wealth) return { wealth: Number(step.wealth.recipeId) };
    return step;
}
function unpackStep(step) {
    if (Array.isArray(step?.craft)) return { craft: { recipeId: step.craft[0], batches: step.craft[1] } };
    if (typeof step?.wealth === 'number') return { wealth: { recipeId: step.wealth } };
    return step;
}

module.exports = { SHOT_RECIPE_IDS, SHOT_PRODUCT_IDS, SHOT_RECIPE_ITEM_IDS, CRYSTAL_BY_RANK,
    availableMaterial, fundedDemand, recipeTarget, scrapCraftRoutes, crystalRoute, craftCandidate,
    batchCount, eligible, decide, packKnown, unpackKnown, packStep, unpackStep };
