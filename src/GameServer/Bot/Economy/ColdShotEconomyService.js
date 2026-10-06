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
const Profit = require('./CraftProfitPolicy');
const Workshops = require('./CraftWorkshopService');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
// The one purchase path (a trip to the seller's town), loaded on use.
const ColdMarket = () => invoke('GameServer/Bot/Economy/ColdMarketService');

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
const scanAt = new Map();
const active = new Set();
let marketCache = null;
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
    const { itemTemplates, npcPrice } = catalog();
    const gear = new Map();
    const addGear = (selfId, price, source, count = 1, ownerId = 0, enchant = 0) => {
        const template = itemTemplates.get(Number(selfId));
        const rank = String(template?.etc?.rank || '').toLowerCase();
        const crystals = Number(template?.etc?.cristals || 0);
        if (!CRYSTAL_BY_RANK[rank] || crystals <= 0 || !(price > 0) || !Number.isFinite(price)
            || Number(enchant) > 0 || !/^(Weapon|Armor)\./.test(String(template?.template?.kind || ''))) return;
        if (!gear.has(rank)) gear.set(rank, []);
        gear.get(rank).push({ selfId: Number(selfId), price, crystals, source, count, ownerId });
    };
    const shotSupply = new Map(), shotMinPrice = new Map(), recipeStock = new Map();
    const recipeHolders = new Map(), shotDemand = new Map(), unlistedSupply = new Map();
    const keptOf = new Map(); // a crafter's shot keep amounts, once per snapshot
    // Static catalog keys and item-side queries; never a population or shop roster scan.
    for (const [id, template] of itemTemplates) {
        if (!CRYSTAL_BY_RANK[template?.etc?.rank] || !(Number(template?.etc?.cristals) > 0)) continue;
        addGear(id, Number(npcPrice.get(id)), 'npc');
        for (const offer of AfkTrade.offers(id, AfkTrade.SELL)) {
            addGear(id, offer.price, 'afk', offer.count, offer.sourceId, offer.enchant);
        }
    }
    for (const id of SHOT_PRODUCT_IDS) {
        const offers = AfkTrade.offers(id, AfkTrade.SELL);
        shotSupply.set(id, offers.reduce((sum, offer) => sum + Number(offer.count), 0));
        shotMinPrice.set(id, offers.reduce((price, offer) => Math.min(price, Number(offer.price)), Infinity));
        const sources = Workshops.inputSources(id);
        const signals = sources.map(state => MarketDemandIndex.demandSignal(state, id, now))
            .filter(signal => signal?.source === 'shots' && signal.budget > 0);
        const owners = new Set(signals.map(signal => signal.characterId));
        for (const offer of AfkTrade.offers(id, AfkTrade.BUY)) if (!owners.has(Number(offer.sourceId))) {
            signals.push({ characterId: Number(offer.sourceId), amount: Number(offer.count),
                budget: Number(offer.count) * Number(offer.price), maxPrice: Number(offer.price) });
        }
        shotDemand.set(id, signals);
        unlistedSupply.set(id, sources.reduce((sum, state) => {
            if (!state.stats?.shotCraft) return sum;
            if (!keptOf.has(state)) keptOf.set(state, ShotStock.keptAmounts(state));
            return sum + Math.max(0, Number(state.inventory?.[id]?.amount || 0) - Number(keptOf.get(state)[id] || 0));
        }, 0));
    }
    for (const id of SHOT_RECIPE_ITEM_IDS) {
        const offers = AfkTrade.offers(id, AfkTrade.SELL);
        const sources = Workshops.inputSources(id).filter(state => state.activity !== 'merchant');
        recipeStock.set(id, offers.reduce((sum, offer) => sum + Number(offer.count), 0)
            + sources.reduce((sum, state) => sum + Number(state.inventory?.[id]?.amount || 0), 0));
        recipeHolders.set(id, sources.filter(state => Number(state.level || 0) >= 10).map(state => ({
            characterId: Number(state.characterId), price: ItemDisposition.priceFor(state, state.inventory[id], itemTemplates.get(id))
        })).sort((a, b) => a.price - b.price));
    }
    for (const rows of gear.values()) rows.sort((a, b) => a.price / a.crystals - b.price / b.crystals || a.price - b.price);
    marketCache = { at: now, itemTemplates, npcPrice, gear, shotSupply, shotMinPrice,
        shotDemand, recipeStock, recipeHolders, unlistedSupply };
    return marketCache;
}

function fundedDemand(index, productId, price, characterId) {
    const signals = index.shotDemand.get(Number(productId)) || [];
    return signals.reduce((sum, signal) => sum + (Number(signal.characterId) === Number(characterId) ? 0
        : (Number(signal.maxPrice ?? Infinity) < price ? 0 : Math.min(Number(signal.amount), Math.floor(Number(signal.budget) / price)))), 0);
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
    Workshops.init();
    return Workshops.crafterCandidates(Math.max(1, Number(limit) || 16)).filter(state =>
        ['hunting', 'resting', 'shopping', 'grouped'].includes(state.activity)
        && now - Number(scanAt.get(Number(state.characterId)) || 0) >= SCAN_INTERVAL_MS);
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
    // The stock rule and prices need no wish network; only the worth of a
    // missing stack does (L25).
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const basics = Economy.basics(state, { timestamp: now });
    const stock = basics.stock('shots');
    const missing = stock.survivalMissing + stock.missing;
    if (!stock.needed || !missing) {
        if (!state.stats?.shotDemand) return state;
        return await persist({ ...state, stats: { ...state.stats, shotDemand: null } }, 'shot_market_demand_filled') || state;
    }
    const price = basics.price(stock.itemId);
    if (!(price > 0)) return state;
    const context = Economy.forState(state, { timestamp: now });
    const worth = context.worth(stock.itemId);
    const maxSpend = Math.min(context.purchaseBudget(stock.itemId), missing * (worth ?? price));
    const wanted = state.stats?.shotDemand;
    if (!wanted || wanted.itemId !== stock.itemId || wanted.amount !== missing || wanted.maxSpend !== maxSpend) {
        state = await persist({ ...state, stats: { ...state.stats,
            shotDemand: { itemId: stock.itemId, amount: missing, maxSpend, at: now } } }, 'shot_market_demand') || state;
    }
    if (require('../Population/CombinedErrandPolicy').pending(state, now)
        .some(errand => errand.purpose === 'shots')) return state;
    const bought = await ColdMarket().acquire(state, stock.itemId, missing, {
        money: maxSpend, purpose: 'shots', timestamp: now
    });
    if (bought.hot) return bought.state;
    if (!bought.bought) {
        // A standing funded order is the real demand producer when fixed
        // shots are disabled; no NPC-derived 5% purchasing purse.
        const ad = await invoke('GameServer/Bot/Economy/BotAfkMarketService').openBuyAd(bought.state, {
            type: 'buy_craft_material', target: { itemId: stock.itemId, amount: missing },
            plan: { expectedBenefit: 'market_buy_craft_material', purpose: 'shots', estimatedCost: price }
        });
        return ad.state || bought.state;
    }
    return await persist({ ...bought.state, stats: { ...bought.state.stats, shotDemand: null } }, 'shot_market_purchase') || bought.state;
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

async function obtainRecipe(state, selected, now) {
    const { recipe, route } = selected;
    const hourAdena = invoke('GameServer/Bot/AI/BotHuntEfficiency').hourValue(state, now).perHour;
    if (!(route?.profit > 0)) return state;
    const itemId = Number(recipe.recipeItemId);
    const maxSpend = PurchaseFunding.spendable(state, 0, { valueHours: route.profit / hourAdena });
    const wanted = state.stats?.shotRecipeDemand;
    if (!wanted || Number(wanted.itemId) !== itemId
        || maxSpend > Number(wanted.maxSpend || 0) * 1.25
        || Number(wanted.at || 0) + 15 * 60 * 1000 <= now) {
        state = await persist({ ...state, stats: { ...(state.stats || {}),
            shotRecipeDemand: { itemId, amount: 1, maxSpend, at: now }
        } }, 'shot_recipe_demand') || state;
    }
    const affordableOffer = () => AfkTrade.offers(itemId, AfkTrade.SELL, { characterId: state.characterId })
        .find((entry) => Number(entry.price) > 0 && Number(entry.price) <= maxSpend && Number(entry.count) > 0);
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
        // The recipe is bought in its seller's town: a trip, or here (one purchase path).
        const bought = await ColdMarket().acquire(state, itemId, 1, { maxPrice: maxSpend, npc: false, purpose: 'recipe',
            timestamp: now });
        if (!bought.bought || bought.hot) return bought.state;
        const learned = await LifeState.learnCraftableRecipes(bought.state) || bought.state;
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
    for (const offer of AfkTrade.offers(crystalId, AfkTrade.SELL, { characterId: state.characterId })) {
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
    const context = Profit.contextFor(state, index.at);
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

async function persist(state, reason) {
    const saved = await LifeState.upsertState(state, reason);
    if (!saved) throw new Error('economy_state_write_rejected');
    return saved;
}

async function acceptMutation(result, fallback, reason) {
    if (result?.coldLifeRow) return LifeState.acceptLifecycleRow(result.coldLifeRow);
    return persist(await LifeState.refreshInventory(fallback) || fallback, reason);
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

// Buys what is missing of a craft input on the one purchase path
// (ColdMarketService.acquire): here when this town is the cheapest with the
// trip, else an errand and a trip, and the craft waits. Returns { state,
// ready }: ready once the bot holds the amount.
async function buyMaterial(state, selfId, amount, maxPrice = Infinity, npc = true, r = 0) {
    const missing = amount - availableMaterial(state, selfId);
    if (missing <= 0) return { state, ready: true };
    const bought = await ColdMarket().acquire(state, selfId, missing, { maxPrice, npc, purpose: 'craft_input',
        money: PurchaseFunding.spendable(state, 0, { r }) });
    return { state: bought.state, ready: bought.bought && !bought.hot && availableMaterial(bought.state, selfId) >= amount };
}

// The crystals of a shot craft: the bot's own, else bought on the board, or a
// piece of gear bought (or crafted from bought inputs) and crystallized; each
// purchase on the one purchase path. Returns { state, ready }.
async function obtainCrystals(state, candidate, batches) {
    const needed = candidate.requiredCrystals * batches;
    if (availableMaterial(state, candidate.crystalId) >= needed) return { state, ready: true };
    const gear = candidate.gear;
    if (!gear) return { state, ready: false };
    if (gear.source === 'crystals') return buyMaterial(state, candidate.crystalId, needed, gear.price, false, candidate.r);
    const [skill] = await Database.fetchSkill(state.characterId, 248);
    if (Number(skill?.level || 0) < CRYSTAL_SKILL_LEVEL[candidate.rank]) return { state, ready: false };
    const ownedRows = await Database.fetchItems(state.characterId);
    const ownedRowIds = new Set(ownedRows.map(item => Number(item.id)));
    if (gear.source === 'craft') {
        for (const input of gear.inputs) {
            const next = await buyMaterial(state, input.selfId, input.amount, input.maxPrice, true, candidate.r);
            if (!next.ready) return next;
            state = next.state;
        }
        const materials = materialRows(await Database.fetchItems(state.characterId), gear.recipe);
        if (!materials || Number(state.vitals?.mp || 0) < Number(gear.recipe.mpCost)) return { state, ready: false };
        const mp = Number(state.vitals.mp) - Number(gear.recipe.mpCost);
        const template = catalog().itemTemplates.get(gear.selfId);
        const result = await Database.craftInventoryItems(state.characterId, { materials, coldState: state, mp,
            product: Profit.succeeds(gear.recipe) ? { selfId: gear.selfId, name: template.template.name, amount: 1, stackable: false, slot: template.etc.slot } : null });
        state = await acceptMutation(result, { ...consumeMaterials(state, gear.recipe.materials),
            vitals: { ...state.vitals, mp } }, 'shot_scrap_crafted');
    } else if (gear.source === 'afk' || gear.source === 'npc') {
        const bought = await ColdMarket().acquire(state, gear.selfId, 1, { maxPrice: gear.price, npc: gear.source === 'npc',
            purpose: 'craft_input', money: PurchaseFunding.spendable(state, 0, { r: candidate.r }) });
        if (!bought.bought || bought.hot) return { state: bought.state, ready: false };
        state = bought.state;
    }
    const row = (await Database.fetchItems(state.characterId)).find(item =>
        (gear.source === 'owned' || !ownedRowIds.has(Number(item.id))) && Number(item.selfId) === gear.selfId
            && Number(item.amount) === 1 && !item.equipped && !Number(item.enchant || 0));
    if (!row) return { state, ready: false };
    const crystal = catalog().itemTemplates.get(candidate.crystalId);
    const result = await Database.crystallizeInventoryItem(state.characterId, {
        sourceId: Number(row.id), sourceSelfId: gear.selfId, crystalId: candidate.crystalId,
        crystalName: crystal?.template?.name || '', crystalAmount: gear.crystals, coldState: state
    });
    state = consumeMaterials(state, [{ selfId: gear.selfId, amount: 1 }]);
    return { state: await acceptMutation(result, state, 'shot_crystallized'), ready: true };
}

function materialRows(items, recipe) { return Profit.materials(items, recipe); }

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
        Math.floor(Math.max(0, PurchaseFunding.spendable(state, 0, { r: candidate.r }) - fixedCash)
            / (candidate.orePrice * orePerBatch + crystalCashPerBatch)));
    if (batches <= 0) return state;
    const crystals = await obtainCrystals(state, candidate, batches);
    if (!crystals.ready) return crystals.state;
    const ore = await buyMaterial(crystals.state, Number(candidate.ore.selfId), orePerBatch * batches, candidate.orePrice, true, candidate.r);
    if (!ore.ready) return ore.state;
    state = ore.state;
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

async function review(state, now = Date.now(), options = {}) {
    if (!state || state.phase !== 'cold' || !['hunting', 'resting', 'shopping', 'grouped'].includes(state.activity)) return { state };
    const id = Number(state.characterId);
    if (active.has(id) || (!options.edge && now - Number(scanAt.get(id) || 0) < SCAN_INTERVAL_MS)) return { state };
    active.add(id);
    scanAt.set(id, now);
    try {
        state = await reviewDemand(state, now);
        Workshops.register(state);
        noteBuyer(state);
        // Gone for its restock, or another errand waits: no craft now.
        if (state.activity === 'traveling' || ColdMarket().pendingErrand(state, now)) return { state };
        if (!CraftShopService.isServiceCrafter(state) || state.party?.partyId || state.partyId
            || CraftShopService.craftLevelFor(state) < 2 || state.stats?.craftStationId
            || (state.stats?.equipmentPlan?.strategy === 'craft'
                && ['active', 'component_ready', 'ready_to_craft'].includes(state.stats.equipmentPlan.status))) return { state };
        if ([...SHOT_RECIPE_ITEM_IDS].some(itemId => Number(state.inventory?.[itemId]?.amount || 0) > 0)) {
            state = await LifeState.learnCraftableRecipes(state) || state;
        }
        state = await Workshops.review(state);
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
    fundedDemand, scrapCraftRoutes, hasShotSurplus, SHOT_RECIPE_IDS, craft,
    _resetForTests() { marketCache = null; catalogCache = null; scanAt.clear(); active.clear(); }
};
