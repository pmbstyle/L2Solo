const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketDemandIndex = require('./MarketDemandIndex');
const MarketListingPolicy = require('./MarketListingPolicy');

const SHOT_RECIPE_IDS = [20, 21, 22, 23, 24, 317, 318, 319, 320, 321,
    323, 324, 325, 326, 327];
const SHOT_PRODUCT_IDS = new Set(SHOT_RECIPE_IDS
    .map((id) => Number(Recipes.resolveByRecipeId(id)?.productId || 0)).filter(Boolean));
const SHOT_RECIPE_ITEM_IDS = new Set(SHOT_RECIPE_IDS
    .map((id) => Number(Recipes.resolveByRecipeId(id)?.recipeItemId || 0)).filter(Boolean));
const CRYSTAL_BY_RANK = { d: 1458, c: 1459, b: 1460, a: 1461, s: 1462 };
const CRYSTAL_SKILL_LEVEL = { d: 1, c: 2, b: 3, a: 4, s: 5 };
const SHOT_RANK_BY_ID = new Map([
    [1463, 'd'], [2510, 'd'], [3948, 'd'],
    [1464, 'c'], [2511, 'c'], [3949, 'c'],
    [1465, 'b'], [2512, 'b'], [3950, 'b'],
    [1466, 'a'], [2513, 'a'], [3951, 'a'],
    [1467, 's'], [2514, 's'], [3952, 's']
]);
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const MARKET_CACHE_MS = 30 * 1000;
const scanAt = new Map();
const active = new Set();
let marketCache = null;
let marketBuild = null;
let catalogCache = null;

function catalog() {
    const rate = invoke('GameServer/ProgressionRates').profile().multiplier;
    if (catalogCache?.source === DataCache.items && catalogCache.rate === rate) return catalogCache;
    const itemTemplates = new Map((DataCache.items || []).map((item) => [Number(item.selfId), item]));
    const npcPrice = new Map();
    for (const line of NpcShopBuyLists.allOffers()) {
        const price = Number(line.price ?? itemTemplates.get(Number(line.selfId))?.template?.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        const id = Number(line.selfId);
        npcPrice.set(id, Math.min(npcPrice.get(id) || Infinity, price));
    }
    catalogCache = { source: DataCache.items, rate, itemTemplates, npcPrice };
    return catalogCache;
}

async function marketSnapshot(now = Date.now()) {
    if (marketCache && now - marketCache.at < MARKET_CACHE_MS) return marketCache;
    if (marketBuild) return marketBuild;
    marketBuild = buildMarketSnapshot(now);
    try { return marketCache = await marketBuild; }
    finally { marketBuild = null; }
}

async function buildMarketSnapshot(now) {
    const { itemTemplates, npcPrice } = catalog();
    const gear = new Map();
    const addGear = (selfId, price, source, count = 1, ownerId = 0, enchant = 0) => {
        const template = itemTemplates.get(Number(selfId));
        const rank = String(template?.etc?.rank || '').toLowerCase();
        const crystals = Number(template?.etc?.cristals || 0);
        if (!CRYSTAL_BY_RANK[rank] || crystals <= 0 || !Number.isFinite(price) || price <= 0
            || Number(enchant) > 0 || !/^(Weapon|Armor)\./.test(String(template?.template?.kind || ''))) return;
        if (!gear.has(rank)) gear.set(rank, []);
        gear.get(rank).push({ selfId: Number(selfId), price, crystals, source, count, ownerId });
    };
    for (const [selfId, price] of npcPrice) addGear(selfId, price, 'npc');
    const shotSupply = new Map();
    const shotMinPrice = new Map();
    const recipeStock = new Map();
    const recipeHolders = new Map();
    let visited = 0;
    for (const shop of AfkTrade.activeShops()) {
        if (Number(shop.storeType) !== AfkTrade.SELL) continue;
        for (const line of shop.lines || []) {
            if (Number(line.count) <= 0 || Number(line.price) <= 0) continue;
            addGear(line.selfId, Number(line.price), 'afk', Number(line.count), Number(shop.ownerId), line.enchant);
            if (SHOT_PRODUCT_IDS.has(Number(line.selfId))) {
                shotSupply.set(Number(line.selfId), (shotSupply.get(Number(line.selfId)) || 0) + Number(line.count));
                shotMinPrice.set(Number(line.selfId), Math.min(shotMinPrice.get(Number(line.selfId)) || Infinity, Number(line.price)));
            }
            if (SHOT_RECIPE_ITEM_IDS.has(Number(line.selfId))) {
                recipeStock.set(Number(line.selfId), (recipeStock.get(Number(line.selfId)) || 0) + Number(line.count));
            }
        }
        if (++visited % 32 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    const shotDemand = new Map();
    const unlistedSupply = new Map();
    const states = LifeState.allStates(5000);
    for (const state of states) {
        // Direct lookups avoid walking every equipment/material stack in the world.
        for (const id of SHOT_RECIPE_ITEM_IDS) {
            const item = state.inventory?.[id];
            if (!item || Number(item.amount) <= 0 || state.activity === 'merchant') continue;
            recipeStock.set(id, (recipeStock.get(id) || 0) + Number(item.amount));
            if (Number(state.level || 0) >= 10) {
                if (!recipeHolders.has(id)) recipeHolders.set(id, []);
                recipeHolders.get(id).push({ characterId: Number(state.characterId),
                    price: ItemDisposition.priceFor(state, item, itemTemplates.get(id)) });
            }
        }
        if (state.stats?.shotCraft) {
            const kept = ShotStock.keptAmounts(state);
            for (const id of SHOT_PRODUCT_IDS) {
                const surplus = Math.max(0, Number(state.inventory?.[id]?.amount || 0) - Number(kept[id] || 0));
                unlistedSupply.set(id, (unlistedSupply.get(id) || 0) + surplus);
            }
        }
        const wanted = state.stats?.shotDemand;
        const id = Number(wanted?.itemId || 0);
        const signal = wanted && MarketDemandIndex.demandSignal(state, id, now);
        if (signal?.source === 'shots' && signal.budget > 0) {
            if (!shotDemand.has(id)) shotDemand.set(id, []);
            shotDemand.get(id).push(signal);
        }
        if (++visited % 32 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    for (const rows of gear.values()) rows.sort((a, b) => a.price / a.crystals - b.price / b.crystals || a.price - b.price);
    for (const holders of recipeHolders.values()) holders.sort((a, b) => a.price - b.price);
    return { at: now, itemTemplates, npcPrice, gear, shotSupply, shotMinPrice,
        shotDemand, recipeStock, recipeHolders, unlistedSupply };
}

function fundedDemand(index, productId, price, characterId) {
    const signals = index.shotDemand.get(Number(productId)) || [];
    return signals.reduce((sum, signal) => sum + (Number(signal.characterId) === Number(characterId) ? 0
        : Math.min(Number(signal.amount), Math.floor(Number(signal.budget) / price))), 0);
}

function noteBuyer(state) {
    if (!marketCache) return;
    for (const [id, signals] of marketCache.shotDemand) {
        marketCache.shotDemand.set(id, signals.filter(s => s.characterId !== Number(state.characterId)));
    }
    const wanted = state.stats?.shotDemand;
    const signal = wanted && MarketDemandIndex.demandSignal(state, wanted.itemId, Date.now());
    if (signal?.source === 'shots' && signal.budget > 0) {
        const id = Number(wanted.itemId);
        marketCache.shotDemand.set(id, [...(marketCache.shotDemand.get(id) || []), signal]);
    }
}

async function candidates(limit = 16, now = Date.now()) {
    const index = await marketSnapshot(now);
    const priority = (state) => {
        const learned = state.stats?.lastRecipeBookLearning;
        if (Number(learned?.at || 0) > now - 10 * 60 * 1000
            && (learned.learned || []).some((entry) => SHOT_RECIPE_IDS.includes(Number(entry.recipeId)))
            && Number(state.stats?.shotCraft?.at || 0) < Number(learned.at)) return 4;
        const wanted = state.stats?.shotRecipeDemand;
        const holders = index.recipeHolders.get(Number(wanted?.itemId || 0)) || [];
        if (holders.length && Number(wanted?.maxSpend || 0) >= holders[0].price) return 3;
        return CraftShopService.isServiceCrafter(state) ? 2 : 1;
    };
    return LifeState.allStates(5000)
        .filter((state) => {
            if (state.phase !== 'cold' || !['hunting', 'resting', 'shopping', 'grouped'].includes(state.activity)
                || now - Number(scanAt.get(Number(state.characterId)) || 0) < SCAN_INTERVAL_MS) return false;
            if (CraftShopService.isServiceCrafter(state)) return true;
            const plan = ShotStock.planForState(state);
            return Number(state.inventory?.[String(plan.selfId)]?.amount || 0) < ShotStock.DEFAULT_TARGET_AMOUNT;
        })
        .sort((left, right) => priority(right) - priority(left)
            || Number(scanAt.get(Number(left.characterId)) || 0)
                - Number(scanAt.get(Number(right.characterId)) || 0))
        .slice(0, Math.max(1, Number(limit) || 16));
}

function hasShotSurplus(state) {
    if (!state?.stats?.shotCraft) return false;
    const kept = ShotStock.keptAmounts(state);
    // This is only a cheap admission check. The listing policy still applies
    // reservations, funded demand and competing supply before publishing.
    return [...SHOT_PRODUCT_IDS].some(id => Number(state.inventory?.[id]?.amount || 0) > Number(kept[id] || 0));
}

async function reviewDemand(state, now) {
    if (!state || state.phase !== 'cold' || !['hunting', 'resting', 'shopping', 'grouped'].includes(state.activity)) return state;
    const plan = ShotStock.planForState(state);
    const current = Number(state.inventory?.[String(plan.selfId)]?.amount || 0);
    if (current >= ShotStock.DEFAULT_TARGET_AMOUNT) {
        if (!state.stats?.shotDemand) return state;
        return await persist({ ...state, stats: { ...(state.stats || {}), shotDemand: null } },
            'shot_market_demand_filled') || state;
    }
    const staticPrice = StaticMerchantPricing.cheapestPurchase(plan.selfId);
    if (!Number.isFinite(staticPrice) || staticPrice <= 0) return state;
    const missing = Math.min(ShotStock.PURCHASE_TARGET_AMOUNT - current, 3000);
    const maxSpend = Math.max(0, Math.min(Math.floor(Number(state.adena || 0) * 0.05), missing * staticPrice));
    const wanted = state.stats?.shotDemand;
    if (!wanted || Number(wanted.itemId) !== plan.selfId || Number(wanted.amount) !== missing
        || maxSpend > Number(wanted.maxSpend || 0) * 1.25
        || Number(wanted.at || 0) + 15 * 60 * 1000 <= now) {
        state = await persist({ ...state, stats: { ...(state.stats || {}),
            shotDemand: { itemId: plan.selfId, amount: missing, maxSpend, at: now }
        } }, 'shot_market_demand') || state;
    }
    // The purchase follows the one restock rule of hot and cold bots.
    const restock = ShotStock.restockPlan(state, { plan, unitPrice: staticPrice,
        offers: AfkTrade.offers(plan.selfId, AfkTrade.SELL, { characterId: state.characterId }) });
    let bought = false;
    let boughtAmount = 0;
    let spent = 0;
    for (const line of restock.shops) {
        try {
            const trade = await AfkTrade.buyFromShop(state.characterId, line.offer.store, plan.selfId, line.amount,
                { expectedPrice: line.price, coldState: state });
            boughtAmount += line.amount;
            spent += line.cost;
            if (trade.coldState) {
                state = trade.coldState;
                bought = true;
            }
        } catch (_) {
            // The NPC sells what a failed line did not (ShotStock.npcRestockAmount).
        }
    }
    const npcAmount = ShotStock.npcRestockAmount(restock, boughtAmount, spent);
    if (npcAmount > 0) {
        const purchase = await Database.purchaseNpcInventoryItem(state.characterId, {
            selfId: plan.selfId, name: plan.name, amount: npcAmount, unitPrice: staticPrice, coldState: state
        });
        if (purchase.ok) {
            state = debitAdena(state, Number(purchase.spent || npcAmount * staticPrice));
            const refreshed = await acceptMutation(purchase, state, 'shot_static_inventory');
            return await persist({ ...refreshed, stats: { ...(refreshed.stats || {}), shotDemand: null } },
                'shot_static_purchase') || refreshed;
        }
    }
    if (!bought) return state;
    return await persist({ ...state, stats: { ...(state.stats || {}), shotDemand: null } },
        'shot_market_purchase') || state;
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
    return viable[0]?.recipe || null;
}

async function obtainRecipe(state, recipe, now) {
    const itemId = Number(recipe.recipeItemId);
    const maxSpend = Math.floor(Number(state.adena || 0) * 0.05);
    const wanted = state.stats?.shotRecipeDemand;
    if (!wanted || Number(wanted.itemId) !== itemId
        || maxSpend > Number(wanted.maxSpend || 0) * 1.25
        || Number(wanted.at || 0) + 15 * 60 * 1000 <= now) {
        state = await persist({ ...state, stats: { ...(state.stats || {}),
            shotRecipeDemand: { itemId, amount: 1, maxSpend, at: now }
        } }, 'shot_recipe_demand') || state;
    }
    const affordableOffer = () => AfkTrade.offers(itemId, AfkTrade.SELL, { characterId: state.characterId })
        .filter((entry) => Number(entry.price) > 0 && Number(entry.price) <= maxSpend && Number(entry.count) > 0)
        .sort((a, b) => a.price - b.price)[0];
    let offer = affordableOffer();
    if (!offer) {
        const holder = ((await marketSnapshot(now)).recipeHolders.get(itemId) || [])
            .find((entry) => entry.characterId !== Number(state.characterId) && entry.price <= maxSpend);
        const seller = holder ? LifeState.snapshot(holder.characterId) : null;
        if (seller?.phase === 'cold') {
            const goal = { type: 'sell_inventory', status: 'active',
                plan: { expectedBenefit: 'market_sale_inventory' } };
            await invoke('GameServer/Bot/Economy/BotAfkMarketService').reconcile(seller, goal);
            offer = affordableOffer();
        }
    }
    if (!offer) return state;
    try {
        const trade = await AfkTrade.buyFromShop(state.characterId, offer.store, itemId, 1,
            { expectedPrice: Number(offer.price), coldState: state });
        if (!trade.coldState) return state;
        const learned = await LifeState.learnCraftableRecipes(trade.coldState) || trade.coldState;
        if (!(learned.stats?.lastRecipeBookLearning?.learned || [])
            .some((entry) => Number(entry.recipeId) === Number(recipe.recipeId))) return learned;
        const acquired = await persist({ ...learned, stats: {
            ...(learned.stats || {}), shotRecipeDemand: null
        } }, 'shot_recipe_acquired') || learned;
        // The next governed slice may use the newly learned recipe immediately.
        scanAt.set(Number(state.characterId), now - SCAN_INTERVAL_MS + 1000);
        return acquired;
    } catch (_) {
        return state;
    }
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
            const offers = AfkTrade.offers(id, AfkTrade.SELL, { characterId: state.characterId });
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
        if (!Number.isFinite(cost) || cost <= 0 || cash > Number(state.adena || 0) * 0.15) continue;
        routes.push({ selfId: Number(recipe.productId), rank: template.etc.rank,
            source: 'craft', crystals: Number(template.etc.cristals), price: cost, cash,
            unitValue: cost / Number(template.etc.cristals), recipe, inputs });
    }
    return routes;
}

function crystalRoute(state, rank, crystalId, required, index) {
    const routes = (index.gear.get(rank) || []).filter(gear => gear.ownerId !== Number(state.characterId)
        && gear.price <= Number(state.adena || 0) * 0.15)
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
    for (const offer of AfkTrade.offers(crystalId, AfkTrade.SELL, { characterId: state.characterId })) {
        if (Number(offer.price) <= 0 || Number(offer.count) < required) continue;
        routes.push({ selfId: crystalId, source: 'crystals', ownerId: Number(offer.sourceId),
            price: Number(offer.price), unitValue: Number(offer.price), cash: Number(offer.price) * required,
            crystals: Number(offer.count) });
    }
    return routes.filter(route => route.cash <= Number(state.adena || 0) * 0.15)
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
    const staticPrice = StaticMerchantPricing.cheapestPurchase(recipe.productId);
    if (!Number.isFinite(staticPrice) || staticPrice <= 0) return null;
    const competingPrice = Number(index.shotMinPrice?.get(Number(recipe.productId)) || Infinity);
    const preferred = Math.max(1, Math.min(Math.floor(staticPrice * 0.9),
        Number.isFinite(competingPrice) ? Math.floor(competingPrice * 0.98) : Infinity));
    const salePrice = MarketListingPolicy.listingPrice({ selfId: recipe.productId,
        price: preferred, basePrice: Number(output.template?.price || 0) },
    { market: { supply: { minimumPrice: competingPrice } } });
    if (!salePrice || salePrice >= staticPrice) return null;
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
    const profit = salePrice * Number(recipe.productCount) - cost;
    if (profit < Math.max(1, Math.ceil(cost * 0.12))
        || Number(state.adena || 0) < (ownedCrystals >= requiredCrystals ? 0 : gear.cash)
            + orePrice * Number(ore.amount) + 10000) return null;
    return { recipe, output, rank, crystalId, requiredCrystals, ore, orePrice,
        gear: ownedCrystals >= requiredCrystals ? null : gear, salePrice, profit, cost, demand };
}

async function persist(state, reason) {
    const saved = await LifeState.upsertState(state, reason);
    if (!saved) throw new Error('economy_state_write_rejected');
    return saved;
}

async function acceptMutation(result, fallback, reason) {
    if (result?.coldLifeRow) return LifeState.acceptLifecycleRow(result.coldLifeRow);
    return persist(await LifeState.refreshInventory(fallback) || fallback, reason);
}

function debitAdena(state, amount) {
    const balance = Math.max(0, Number(state.adena || 0) - Number(amount || 0));
    return { ...state, adena: balance, inventory: { ...(state.inventory || {}), 57: {
        ...(state.inventory?.['57'] || {}), selfId: 57, amount: balance
    } } };
}

function consumeMaterials(state, materials) {
    const inventory = { ...(state.inventory || {}) };
    for (const material of materials || []) {
        const key = String(material.selfId);
        const previous = inventory[key] || { selfId: Number(material.selfId) };
        inventory[key] = { ...previous,
            amount: Math.max(0, Number(previous.amount || 0) - Number(material.amount || 0)) };
    }
    return { ...state, inventory };
}

async function buyMaterial(state, selfId, amount, npcPrice, index, maxPrice = npcPrice) {
    let missing = amount - availableMaterial(state, selfId);
    if (missing <= 0) return state;
    const offers = AfkTrade.offers(selfId, AfkTrade.SELL, { characterId: state.characterId })
        .filter((offer) => Number(offer.price) > 0 && Number(offer.price) <= maxPrice && Number(offer.count) > 0)
        .sort((a, b) => a.price - b.price).slice(0, 4);
    for (const offer of offers) {
        if (missing <= 0) break;
        const count = Math.min(missing, Number(offer.count));
        try {
            const trade = await AfkTrade.buyFromShop(state.characterId, offer.store, selfId, count,
                { expectedPrice: Number(offer.price), coldState: state });
            if (!trade.coldState) break;
            state = trade.coldState;
            missing -= count;
        } catch (_) { /* The NPC offer remains a bounded fallback. */ }
    }
    if (missing > 0) {
        if (!Number.isFinite(npcPrice) || npcPrice > maxPrice) return null;
        const template = index.itemTemplates.get(selfId);
        const purchase = await Database.purchaseNpcInventoryItem(state.characterId, {
            selfId, name: template?.template?.name || `Item ${selfId}`, amount: missing, unitPrice: npcPrice, coldState: state
        });
        if (!purchase.ok) return null;
        state = debitAdena(state, Number(purchase.spent || missing * npcPrice));
        state = await acceptMutation(purchase, state, 'shot_material_purchase');
    }
    return state;
}

async function obtainCrystals(state, candidate, batches) {
    const needed = candidate.requiredCrystals * batches;
    if (availableMaterial(state, candidate.crystalId) >= needed) return state;
    const gear = candidate.gear;
    if (!gear) return null;
    if (gear.source === 'crystals') {
        const offer = AfkTrade.offers(candidate.crystalId, AfkTrade.SELL, { characterId: state.characterId })
            .find(row => Number(row.sourceId) === gear.ownerId && Number(row.price) === gear.price
                && Number(row.count) >= needed - availableMaterial(state, candidate.crystalId));
        if (!offer) return null;
        const trade = await AfkTrade.buyFromShop(state.characterId, offer.store, candidate.crystalId,
            needed - availableMaterial(state, candidate.crystalId), { expectedPrice: gear.price, coldState: state, autoEquip: false });
        return trade.coldState || null;
    }
    const [skill] = await Database.fetchSkill(state.characterId, 248);
    if (Number(skill?.level || 0) < CRYSTAL_SKILL_LEVEL[candidate.rank]) return null;
    const ownedRows = await Database.fetchItems(state.characterId);
    const ownedRowIds = new Set(ownedRows.map(item => Number(item.id)));
    if (gear.source === 'craft') {
        for (const input of gear.inputs) {
            const next = await buyMaterial(state, input.selfId, input.amount, input.npcPrice, catalog(), input.maxPrice);
            if (!next) return null;
            state = next;
        }
        const materials = materialRows(await Database.fetchItems(state.characterId), gear.recipe);
        if (!materials || Number(state.vitals?.mp || 0) < Number(gear.recipe.mpCost)) return null;
        const mp = Number(state.vitals.mp) - Number(gear.recipe.mpCost);
        const template = catalog().itemTemplates.get(gear.selfId);
        const result = await Database.craftInventoryItems(state.characterId, { materials, coldState: state, mp,
            product: { selfId: gear.selfId, name: template.template.name, amount: 1, stackable: false, slot: template.etc.slot } });
        state = await acceptMutation(result, { ...consumeMaterials(state, gear.recipe.materials),
            vitals: { ...state.vitals, mp } }, 'shot_scrap_crafted');
    } else if (gear.source === 'afk') {
        const offer = AfkTrade.offers(gear.selfId, AfkTrade.SELL, { characterId: state.characterId })
            .find(row => Number(row.sourceId) === gear.ownerId && Number(row.price) === gear.price
                && Number(row.count) > 0 && !Number(row.storeItem?.enchant || 0));
        if (!offer) return null;
        const trade = await AfkTrade.buyFromShop(state.characterId, offer.store, gear.selfId, 1,
            { expectedPrice: gear.price, coldState: state, autoEquip: false });
        if (!trade.coldState) return null;
        state = trade.coldState;
    } else if (gear.source === 'npc') {
        const template = catalog().itemTemplates.get(gear.selfId);
        const purchase = await Database.purchaseNpcInventoryItem(state.characterId, {
            selfId: gear.selfId, name: template?.template?.name || `Item ${gear.selfId}`,
            amount: 1, unitPrice: gear.price, stackable: false, slot: Number(template?.etc?.slot || 0), coldState: state
        });
        if (!purchase.ok) return null;
        state = await acceptMutation(purchase, debitAdena(state, purchase.spent || gear.price), 'shot_scrap_purchase');
    }
    const row = (await Database.fetchItems(state.characterId)).find(item =>
        (gear.source === 'owned' || !ownedRowIds.has(Number(item.id))) && Number(item.selfId) === gear.selfId
            && Number(item.amount) === 1 && !item.equipped && !Number(item.enchant || 0));
    if (!row) return null;
    const crystal = catalog().itemTemplates.get(candidate.crystalId);
    const result = await Database.crystallizeInventoryItem(state.characterId, {
        sourceId: Number(row.id), sourceSelfId: gear.selfId, crystalId: candidate.crystalId,
        crystalName: crystal?.template?.name || '', crystalAmount: gear.crystals, coldState: state
    });
    state = consumeMaterials(state, [{ selfId: gear.selfId, amount: 1 }]);
    return acceptMutation(result, state, 'shot_crystallized');
}

function materialRows(items, recipe) {
    const selected = [];
    for (const material of recipe.materials || []) {
        let missing = Number(material.amount || 0);
        for (const item of items) {
            if (missing <= 0) break;
            if (Number(item.selfId) !== Number(material.selfId) || item.equipped) continue;
            const amount = Math.min(missing, Number(item.amount || 0));
            if (amount > 0) selected.push({ id: Number(item.id), selfId: Number(item.selfId), amount });
            missing -= amount;
        }
        if (missing > 0) return null;
    }
    return selected;
}

async function craft(state, candidate, index, now) {
    const productPerBatch = Number(candidate.recipe.productCount);
    const orePerBatch = Number(candidate.ore.amount);
    const mpPerBatch = Number(candidate.recipe.mpCost || 0);
    const route = candidate.gear;
    const availableCrystals = availableMaterial(state, candidate.crystalId);
    const potentialCrystals = availableCrystals + Number(route?.crystals || 0);
    const fixedCash = route && route.source !== 'crystals' ? Number(route.cash || 0) : 0;
    const crystalCashPerBatch = route?.source === 'crystals' ? route.price * candidate.requiredCrystals : 0;
    const batches = Math.min(64,
        Math.ceil(candidate.demand / productPerBatch),
        Math.floor(potentialCrystals / candidate.requiredCrystals),
        mpPerBatch > 0 ? Math.floor(Math.max(0, Number(state.vitals?.mp || 0) - Number(route?.recipe?.mpCost || 0)) / mpPerBatch) : 64,
        Math.floor(Math.max(0, Number(state.adena || 0) - fixedCash - 10000)
            / (candidate.orePrice * orePerBatch + crystalCashPerBatch)));
    if (batches <= 0) return state;
    state = await obtainCrystals(state, candidate, batches);
    if (!state) return null;
    state = await buyMaterial(state, Number(candidate.ore.selfId), orePerBatch * batches, candidate.orePrice, index);
    if (!state) return null;
    const batchRecipe = { ...candidate.recipe, materials: candidate.recipe.materials.map((material) => ({
        ...material, amount: Number(material.amount) * batches
    })) };
    const rows = materialRows(await Database.fetchItems(state.characterId), batchRecipe);
    if (!rows) return state;
    const remainingMp = Number(state.vitals.mp) - mpPerBatch * batches;
    const crafted = await Database.craftInventoryItems(state.characterId, {
        materials: rows,
        product: { selfId: Number(candidate.recipe.productId), name: candidate.output.template?.name || '',
            amount: productPerBatch * batches, stackable: true, slot: 0 },
        mp: remainingMp, coldState: state
    });
    state = consumeMaterials(state, batchRecipe.materials);
    state = await acceptMutation(crafted, { ...state, vitals: {
        ...(state.vitals || {}), mp: remainingMp
    } }, 'shot_craft_inventory');
    // Reserve produced units immediately without rebuilding the entire market.
    const productId = Number(candidate.recipe.productId);
    if (index.unlistedSupply) index.unlistedSupply.set(productId,
        Number(index.unlistedSupply.get(productId) || 0) + productPerBatch * batches);
    const saved = await persist({ ...state, stats: { ...(state.stats || {}),
        shotCraft: { recipeId: Number(candidate.recipe.recipeId), productId: Number(candidate.recipe.productId),
            amount: productPerBatch * batches, expectedProfit: candidate.profit * batches,
            unitPrice: candidate.salePrice, at: now }
    } }, 'shot_craft_completed') || state;
    await LifeEvents.record(saved.characterId, 'shot_craft', `${saved.name} crafted ${productPerBatch * batches} ${candidate.output.template?.name || 'shots'}`, {
        recipeId: Number(candidate.recipe.recipeId), productId: Number(candidate.recipe.productId),
        amount: productPerBatch * batches, expectedProfit: candidate.profit * batches
    }, 1);
    return saved;
}

async function review(state, now = Date.now()) {
    if (!state || state.phase !== 'cold' || !['hunting', 'resting', 'shopping', 'grouped'].includes(state.activity)) return { state };
    const id = Number(state.characterId);
    if (active.has(id) || now - Number(scanAt.get(id) || 0) < SCAN_INTERVAL_MS) return { state };
    active.add(id);
    scanAt.set(id, now);
    try {
        state = await reviewDemand(state, now);
        noteBuyer(state);
        if (!CraftShopService.isServiceCrafter(state) || state.party?.partyId || state.partyId
            || CraftShopService.craftLevelFor(state) < 2 || state.stats?.craftStationId
            || (state.stats?.equipmentPlan?.strategy === 'craft'
                && ['active', 'component_ready', 'ready_to_craft'].includes(state.stats.equipmentPlan.status))) return { state };
        if ([...SHOT_RECIPE_ITEM_IDS].some(itemId => Number(state.inventory?.[itemId]?.amount || 0) > 0)) {
            state = await LifeState.learnCraftableRecipes(state) || state;
        }
        const known = await Database.fetchCharacterRecipes(id);
        const shotRecipes = (known || []).map((row) => Recipes.resolveByRecipeId(row.recipeId))
            .filter((recipe) => recipe && SHOT_RECIPE_IDS.includes(Number(recipe.recipeId))
                && CraftShopService.canCraft(state, recipe));
        const knownRecipeIds = shotRecipes.map((recipe) => Number(recipe.recipeId));
        if (!shotRecipes.length) {
            const target = recipeTarget(state, await marketSnapshot(now), knownRecipeIds);
            return { state: target ? await obtainRecipe(state, target, now) : state };
        }
        if (shotRecipes.some((recipe) => Number(recipe.recipeItemId) === Number(state.stats?.shotRecipeDemand?.itemId))) {
            state = await persist({ ...state, stats: {
                ...(state.stats || {}), shotRecipeDemand: null
            } }, 'shot_recipe_demand_filled') || state;
        }
        const index = { ...await marketSnapshot(now) };
        index.scrapCraftRoutes = scrapCraftRoutes(state, known, index);
        const candidate = shotRecipes.map((recipe) => craftCandidate(state, recipe, index))
            .filter(Boolean).sort((a, b) => b.profit - a.profit)[0];
        if (!candidate) {
            const target = recipeTarget(state, index, knownRecipeIds);
            return { state: target ? await obtainRecipe(state, target, now) : state };
        }
        const craftedState = await craft(state, candidate, index, now);
        return { state: craftedState || LifeState.snapshot(id) || state,
            crafted: !!craftedState?.stats?.shotCraft && Number(craftedState.stats.shotCraft.at) === now };
    } catch (error) {
        utils.infoWarn('BotShots', 'shot economy failed for %s: %s', state.name, error?.message || String(error));
        return { state: LifeState.snapshot(id) || state, reason: 'error' };
    } finally {
        active.delete(id);
    }
}

module.exports = { review, candidates, marketSnapshot, craftCandidate, recipeTarget,
    fundedDemand, scrapCraftRoutes, hasShotSurplus, SHOT_RECIPE_IDS,
    _resetForTests() { marketCache = null; marketBuild = null; catalogCache = null; scanAt.clear(); active.clear(); }
};
