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
const Profit = require('./CraftProfitPolicy');
const Workshops = require('./CraftWorkshopService');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
// The one purchase path (a trip to the seller's town), loaded on use.
const ColdMarket = () => invoke('GameServer/Bot/Economy/ColdMarketService');

const Policy = require('./ShotCraftPolicy');
const { SHOT_RECIPE_IDS, SHOT_PRODUCT_IDS, SHOT_RECIPE_ITEM_IDS, CRYSTAL_BY_RANK,
    availableMaterial, fundedDemand, recipeTarget, scrapCraftRoutes, craftCandidate } = Policy;
const CRYSTAL_SKILL_LEVEL = { d: 1, c: 2, b: 3, a: 4, s: 5 };
const active = new Set();
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

function marketSnapshot(now = Date.now()) {
    Workshops.init();
    const index = require('./ShotMarketIndex').native();
    return { ...index.marketSnapshot(now), offersFor: (...args) => index.offersFor(...args) };
}

function noteBuyer(state) { require('./ShotMarketIndex').native().update(state); }

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
    const context = require('../Population/ColdEconomyDecision').economyFor(state, { timestamp: now });
    const worth = context.worth(stock.itemId);
    const maxSpend = Math.min(require('./PurchaseFunding').spendable(state, 0,
        { itemId: stock.itemId, survivalCost: basics.kitCost(stock.itemId) }), missing * (worth ?? price));
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
        return acquired;
    } catch (_) {
        return state;
    }
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
    const batches = Math.min(Policy.batchCount(state, candidate), Number(candidate.maxBatches ?? 64));
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
    if (active.has(id)) return { state };
    active.add(id);
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

async function execute(state, step, now = Date.now()) {
    if (!Policy.eligible(state, now)) return state;
    const known = await Database.fetchCharacterRecipes(state.characterId);
    const index = { ...marketSnapshot(now) };
    index.scrapCraftRoutes = scrapCraftRoutes(state, known, index);
    if (step?.recipeTarget) {
        if (known.some(row => Number(row.recipeId) === Number(step.recipeTarget))) return state;
        const recipe = Recipes.resolveByRecipeId(step.recipeTarget);
        if (!recipe || !CraftShopService.canCraft(state, recipe)) return state;
        const route = craftCandidate(state, recipe, index);
        return route ? obtainRecipe(state, { recipe, route }, now) : state;
    }
    if (step?.craft) {
        if (!known.some(row => Number(row.recipeId) === Number(step.craft.recipeId))) return state;
        const recipe = Recipes.resolveByRecipeId(step.craft.recipeId);
        if (!recipe || !CraftShopService.canCraft(state, recipe)) return state;
        const candidate = craftCandidate(state, recipe, index);
        return candidate ? craft(state, { ...candidate, maxBatches: Number(step.craft.batches) }, index, now) : state;
    }
    return state;
}

module.exports = { review, reviewDemand, marketSnapshot, craftCandidate, recipeTarget,
    fundedDemand, scrapCraftRoutes, hasShotSurplus, SHOT_RECIPE_IDS, craft, obtainRecipe, execute,
    _resetForTests() { catalogCache = null; active.clear(); }
};
