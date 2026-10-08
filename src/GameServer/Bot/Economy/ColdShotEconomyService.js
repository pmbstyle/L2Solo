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
const Commit = require('./EconomyCommit');
// The one purchase path (a trip to the seller's town), loaded on use.
const ColdMarket = () => invoke('GameServer/Bot/Economy/ColdMarketService');

const Policy = require('./ShotCraftPolicy');
const { SHOT_RECIPE_IDS, SHOT_PRODUCT_IDS, SHOT_RECIPE_ITEM_IDS, CRYSTAL_BY_RANK,
    availableMaterial, fundedDemand, recipeTarget, scrapCraftRoutes, craftCandidate } = Policy;
const CRYSTAL_SKILL_LEVEL = { d: 1, c: 2, b: 3, a: 4, s: 5 };
const active = new Set();
let catalogCache = null;

// Recheck only the published physical quantity, exit and crystal source. The
// shared immutable NPC adjacency is initialised once; dynamic reads touch at
// most five indexed raw rows for each selected ingredient.
function recheck(state, selected) {
    const recipe = Recipes.resolveByRecipeId(Number(selected?.recipeId)), batches = Number(selected?.batches);
    const packet = state.stats?.money;
    if (!recipe || !SHOT_RECIPE_IDS.includes(Number(recipe.recipeId)) || !CraftShopService.canCraft(state, recipe)
        || !Number.isSafeInteger(batches) || batches < 1 || batches > 64
        || !Array.isArray(packet) || !(packet[0] > 0) || !(packet[1] > 0)) return null;
    const Source = require('../Population/ColdOccupationSources'); Source.initialise();
    const board = AfkTrade.boardIndex(), Fields = require('../../AfkTrade/BoardIndex');
    const ItemIndex = require('../../Item/ItemTemplateIndex');
    const context = { hourAdena: Number(packet[0]), moneyPrice: Number(packet[1]), fixedBatches: batches,
        mpPerHour: Number(invoke('GameServer/Bot/Population/BackgroundResolver').coldRestRegenPerTick(state).mp) * 1200 };
    const trip = Profit.tripFor(state, context); context.trip = trip;
    const ownStock = new Map(), neededIds = new Set([Number(recipe.productId), Number(recipe.recipeItemId)]);
    for (const material of recipe.materials || []) neededIds.add(Number(material.selfId));
    const hint = selected.gear;
    const gearId = Number(hint?.[0] || 0), sourceCode = Number(hint?.[1] || 0), hintedTown = Policy.townForCode(hint?.[2]);
    const scrap = sourceCode > 0 ? Recipes.resolveByRecipeId(sourceCode) : null;
    if (scrap) for (const material of scrap.materials || []) neededIds.add(Number(material.selfId));
    if (sourceCode === -1) neededIds.add(gearId);
    for (const id of neededIds) {
        const row = state.inventory?.[id], template = ItemIndex.find(DataCache.items, id);
        let value = invoke('GameServer/Items/NpcSellRules').npcBuyPrice(Number(template?.template?.price || 0));
        const bids = board.list(id, AfkTrade.BUY);
        for (let at = 0; at < Math.min(5, bids.length); at++) if (bids[at].ownerId !== Number(state.characterId)) value = Math.max(value, Number(bids[at].price));
        const amount = row ? require('./WealthCraftDecision').freeAmount(state, row) : 0;
        ownStock.set(id, { count: id === Number(recipe.productId) ? Math.max(0, amount - Number(selected.ownReserve || 0)) : amount,
            unitValue: Number.isFinite(value) ? Math.max(0, value) : NaN });
    }
    context.independentPrice = id => ownStock.get(Number(id))?.unitValue ?? NaN;
    let exit = null;
    if (Array.isArray(selected.exit) && selected.exit.length === 4) {
        const [recordId, lineId, price, revision] = selected.exit.map(Number);
        const compact = selected.exit[0] == null && selected.exit[2] == null;
        if (recordId > 0 || compact) {
            const line = compact ? board.list(recipe.productId, AfkTrade.BUY).slice(0, 5)
                .find(row => Number(row.lineId) === lineId) : board.records.get(recordId)?.find(row => Number(row.lineId) === lineId);
            if (!line || line.storeType !== AfkTrade.BUY || line.revision !== revision || !compact && line.price !== price
                || line.selfId !== Number(recipe.productId) || line.ownerId === Number(state.characterId)) return null;
            exit = { type: 'afk', price: Number(line.price), count: Number(line.count), town: line.town, offer: Fields.offerFields(line) };
        } else if (recordId === -1 && Number.isSafeInteger(lineId) && lineId > 0 && price > 0 && revision >= 0) {
            exit = { type: 'use', price: 0, count: 0, ownUseUnits: lineId, ownUseUnitHours: price, residualUnitValue: 0 };
        }
    } else {
        const rows = board.list(recipe.productId, AfkTrade.BUY);
        for (let at = 0; at < Math.min(5, rows.length); at++) if (rows[at].ownerId !== Number(state.characterId)) {
            const line = rows[at]; exit = { type: 'afk', price: line.price, count: line.count, town: line.town, offer: Fields.offerFields(line) }; break;
        }
    }
    if (!exit) return null;
    if (exit.type === 'afk') {
        const asks = board.list(recipe.productId, AfkTrade.SELL);
        let cheaper = 0;
        for (let at = 0; at < Math.min(5, asks.length); at++) if (asks[at].ownerId !== Number(state.characterId)
            && !Number(asks[at].enchant || 0) && asks[at].price < exit.price) cheaper += Number(asks[at].count);
        if (asks.length > 5 && asks[5].price < exit.price && cheaper < exit.count) return null;
        exit.cheaperUnits = cheaper;
        exit.trip = trip(exit.town); exit.tripDetails = trip.details?.(exit.town);
        const output = ownStock.get(Number(recipe.productId));
        for (const line of board.ownerLines(Number(state.characterId))) {
            if (line.storeType !== AfkTrade.SELL || line.selfId !== Number(recipe.productId)) continue;
            if (line.price !== exit.price) return null;
            output.count += Number(line.count);
        }
    }
    const purchase = (id, amount, query = {}) => {
        const towns = new Map(), rows = board.list(id, AfkTrade.SELL);
        const onlyTown = id === gearId && sourceCode === -3 ? hintedTown : null;
        for (let at = 0; at < Math.min(5, rows.length); at++) {
            const line = rows[at];
            if (line.ownerId === Number(state.characterId) || Number(line.enchant || 0) || onlyTown && line.town !== onlyTown) continue;
            if (!towns.has(line.town)) towns.set(line.town, { lines: [], npcPrice: 0 });
            towns.get(line.town).lines.push(line);
        }
        if (query.npc === true) for (const row of Source.npcOffersFor(id)) {
            if (onlyTown && row.town !== onlyTown) continue;
            if (!towns.has(row.town)) towns.set(row.town, { lines: [], npcPrice: 0 });
            const held = towns.get(row.town); held.npcPrice = held.npcPrice ? Math.min(held.npcPrice, Number(row.price)) : Number(row.price);
        }
        let best = null;
        for (const [town, held] of towns) {
            const filled = require('./OfferQuery').fill(held.lines, amount, { excludeOwner: state.characterId, npcPrice: held.npcPrice });
            const landed = filled.cost + trip(town);
            if (filled.units < amount || !Number.isFinite(landed)) continue;
            if (!best || landed < best.landed) best = { ...filled, town, whole: true, landed, npcPrice: held.npcPrice,
                tripDetails: trip.details?.(town), selfId: Number(id) };
        }
        return best;
    };
    let gear = null;
    if (hint && gearId > 0) {
        const template = ItemIndex.find(DataCache.items, gearId), crystals = Number(template?.etc?.cristals || 0);
        if (sourceCode === 0) {
            const compact = hint[2] == null && hint[4] == null;
            const line = compact ? board.list(gearId, AfkTrade.SELL).slice(0, 5).find(row => Number(row.lineId) === Number(hint[3]))
                : board.records.get(Number(hint[2]))?.find(row => Number(row.lineId) === Number(hint[3]));
            if (!line || line.storeType !== AfkTrade.SELL || line.ownerId === Number(state.characterId) || line.selfId !== gearId
                || !compact && line.price !== Number(hint[4]) || line.revision !== Number(hint[5]) || Number(line.enchant || 0)) return null;
            gear = { ...Fields.offerFields(line), selfId: gearId, crystals, source: 'afk', ownerId: line.ownerId,
                offer: Fields.offerFields(line), sourcePlan: { selfId: gearId, town: line.town, count: 1,
                    cost: Number(line.price), landed: Number(line.price) + trip(line.town), npc: 0,
                    lines: [{ line, count: 1, price: Number(line.price) }] } };
        } else if (sourceCode === -2) {
            const quote = Source.npcOffersFor(gearId).find(row => row.town === hintedTown && Number(row.price) === Number(hint[4]));
            if (!quote) return null;
            gear = { ...quote, selfId: gearId, crystals, source: 'npc', ownerId: 0,
                sourcePlan: { selfId: gearId, town: quote.town, count: 1, cost: Number(quote.price),
                    landed: Number(quote.price) + trip(quote.town), npc: 1, npcPrice: Number(quote.price), lines: [] } };
        } else if (sourceCode === -1 && !(ownStock.get(gearId)?.count > 0)) return null;
        else if (sourceCode > 0 && (!scrap || Number(scrap.productId) !== gearId)) return null;
        else if (sourceCode === -3 && !hintedTown) return null;
    }
    const options = { ownStock, knownRecipes: scrap ? [{ recipeId: scrap.recipeId }] : [],
        itemTemplate: id => ItemIndex.find(DataCache.items, Number(id)), gearRowsFor: () => gear ? [gear] : [],
        prepareTrip: function* (town) { yield 'trip'; return trip.details?.(town) || { known: false }; },
        preparePurchase: function* (owner, id, amount, query) { yield 'quote'; return purchase(id, amount, query); },
        prepareExits: function* () { yield 'exit'; return [exit]; } };
    const candidate = require('./WealthCraftPolicy').drain(Policy.recipeShotSearch(state, recipe, context, options));
    if (!candidate || Number(candidate.gear?.selfId || 0) !== gearId && gearId > 0) return null;
    return candidate;
}

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

function marketSnapshot(now = Date.now(), ownState = null) {
    Workshops.init();
    const index = require('./ShotMarketIndex').native();
    return { ...index.marketSnapshot(now, ownState), offersFor: (...args) => index.offersFor(...args) };
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
        purpose: 'shots', timestamp: now
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
    const valueHours = Number(selected.recipeDecision?.best?.valueHours ?? route.valueHours ?? route.profit / hourAdena);
    const maxSpend = PurchaseFunding.spendable(state, 0, { valueHours });
    const wanted = state.stats?.shotRecipeDemand;
    if (!wanted || Number(wanted.itemId) !== itemId
        || maxSpend > Number(wanted.maxSpend || 0) * 1.25
        || Number(wanted.at || 0) + 15 * 60 * 1000 <= now) {
        state = await persist({ ...state, stats: { ...(state.stats || {}),
            shotRecipeDemand: { itemId, amount: 1, maxSpend, at: now }
        } }, 'shot_recipe_demand') || state;
    }
    const affordableOffer = () => {
        if (selected.scrollQuote) return Number(selected.scrollQuote.price) <= maxSpend ? selected.scrollQuote : null;
        const rows = AfkTrade.boardIndex().list(itemId, AfkTrade.SELL);
        for (let at = 0; at < Math.min(5, rows.length); at++) if (rows[at].ownerId !== Number(state.characterId)
            && rows[at].price > 0 && rows[at].price <= maxSpend && rows[at].count > 0) return rows[at];
        return null;
    };
    if (Number(state.inventory?.[itemId]?.amount || 0) > 0) {
        return await LifeState.learnCraftableRecipes(state, { recipeIds: [Number(recipe.recipeId)] }) || state;
    }
    const offer = affordableOffer();
    if (!offer) return state;
    try {
        // The recipe is bought in its seller's town: a trip, or here (one purchase path).
        const bought = await ColdMarket().acquire(state, itemId, 1, { money: maxSpend, maxPrice: maxSpend,
            valueHours, npc: false, purpose: 'recipe', timestamp: now, quoteDepth: 5, towns: [offer.town],
            sourcePlan: { selfId: itemId, town: offer.town, cost: Number(offer.price),
                landed: Number(offer.price) + Number(route.context.trip?.(offer.town) || 0),
                npc: 0, lines: [{ line: offer, count: 1, price: Number(offer.price) }] } });
        if (!bought.bought || bought.hot) return bought.state;
        const learned = await LifeState.learnCraftableRecipes(bought.state, { recipeIds: [Number(recipe.recipeId)] }) || bought.state;
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
    if (result?.coldLifeRow) return Commit.acceptRow(result.coldLifeRow);
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
const hotState = state => LifeState.hotRow(state.characterId) || (state.phase === 'hot' ? state : null);

async function buyMaterial(state, selfId, amount, maxPrice = Infinity, npc = true, r = 0, sourcePlan = null) {
    const hot = hotState(state);
    if (hot) return { state: hot, ready: false, hot: true };
    const missing = amount - availableMaterial(state, selfId);
    if (missing <= 0) return { state, ready: true };
    const bought = await ColdMarket().acquire(state, selfId, missing, { maxPrice, npc, purpose: 'craft_input',
        r, money: PurchaseFunding.spendable(state, 0, { r }), quoteDepth: 5,
        ...(sourcePlan ? { sourcePlan, towns: [sourcePlan.town] } : {}) });
    return { state: bought.state, ready: bought.bought && !bought.hot && availableMaterial(bought.state, selfId) >= amount };
}

// The crystals of a shot craft: the bot's own, else bought on the board, or a
// piece of gear bought (or crafted from bought inputs) and crystallized; each
// purchase on the one purchase path. Returns { state, ready }.
async function obtainCrystals(state, candidate, batches) {
    const hot = hotState(state);
    if (hot) return { state: hot, ready: false, hot: true };
    const needed = candidate.requiredCrystals * batches;
    if (availableMaterial(state, candidate.crystalId) >= needed) return { state, ready: true };
    const gear = candidate.gear;
    if (!gear) return { state, ready: false };
    if (gear.source === 'crystals') return buyMaterial(state, candidate.crystalId, needed, gear.price, false, candidate.r,
        candidate.basket.purchases.find(row => row.selfId === candidate.crystalId));
    const [skill] = await Database.fetchSkill(state.characterId, 248);
    if (Number(skill?.level || 0) < CRYSTAL_SKILL_LEVEL[candidate.rank]) return { state, ready: false };
    const ownedRows = await Database.fetchItems(state.characterId);
    const ownedRowIds = new Set(ownedRows.map(item => Number(item.id)));
    if (gear.source === 'craft') {
        const requirements = gear.inputs.map(input => {
            const sourcePlan = gear.purchases?.find(row => row.selfId === Number(input.selfId));
            return { selfId: input.selfId, amount: input.amount, options: { maxPrice: input.maxPrice,
                npc: true, purpose: 'craft_input', r: candidate.r,
                money: PurchaseFunding.spendable(state, 0, { r: candidate.r }), quoteDepth: 5,
                ...(sourcePlan ? { sourcePlan, towns: [sourcePlan.town] } : {}) } };
        });
        const oreId = Number(candidate.ore.selfId);
        const oreSource = candidate.basket.purchases.find(row => row.selfId === oreId);
        const existing = requirements.find(row => Number(row.selfId) === oreId);
        if (existing) existing.amount += Number(candidate.ore.amount) * batches;
        else requirements.push({ selfId: oreId, amount: Number(candidate.ore.amount) * batches,
            options: { maxPrice: candidate.orePrice, npc: true, purpose: 'craft_input', r: candidate.r,
                money: PurchaseFunding.spendable(state, 0, { r: candidate.r }), quoteDepth: 5,
                ...(oreSource ? { sourcePlan: oreSource, towns: [oreSource.town] } : {}) } });
        const next = await ColdMarket().acquireMaterials(state, requirements);
        const activated = hotState(next.state);
        if (next.hot || activated) return { ...next, state: activated || next.state, ready: false, hot: true };
        if (!next.ready) return next;
        state = next.state;
        const materials = materialRows(await Database.fetchItems(state.characterId), gear.recipe);
        if (hotState(state)) return { state: hotState(state), ready: false, hot: true };
        if (!materials || Number(state.vitals?.mp || 0) < Number(gear.recipe.mpCost)) return { state, ready: false };
        const template = require('../../Item/ItemTemplateIndex').find(DataCache.items, gear.selfId);
        let admitted = null, result;
        try {
            admitted = await Commit.admit(state, Commit.KINDS.craft);
            state = admitted.state;
            result = await Database.craftInventoryItems(state.characterId, { materials, coldState: state,
                recipeId: Number(gear.recipe.recipeId), batches: 1, economyCommand: admitted.command,
                product: { selfId: gear.selfId, name: template.template.name, amount: 1, stackable: false, slot: template.etc.slot } });
            state = await acceptMutation(result, { ...consumeMaterials(state, gear.recipe.materials),
                vitals: { ...state.vitals, mp: Number(result.mp) } }, 'shot_scrap_crafted');
        } finally { if (admitted) Commit.finish(state.characterId, admitted.command); }
        if (result.success !== true) return { state, ready: false };
    } else if (gear.source === 'afk' || gear.source === 'npc') {
        const bought = await ColdMarket().acquire(state, gear.selfId, 1, { maxPrice: gear.price, npc: gear.source === 'npc',
            purpose: 'craft_input', r: candidate.r, money: PurchaseFunding.spendable(state, 0, { r: candidate.r }),
            quoteDepth: 5, ...(gear.sourcePlan ? { sourcePlan: gear.sourcePlan, towns: [gear.sourcePlan.town] } : {}) });
        if (!bought.bought || bought.hot) return { state: bought.state, ready: false };
        state = bought.state;
    }
    const row = (await Database.fetchItems(state.characterId)).find(item =>
        (gear.source === 'owned' || !ownedRowIds.has(Number(item.id))) && Number(item.selfId) === gear.selfId
            && Number(item.amount) === 1 && !item.equipped && !Number(item.enchant || 0));
    if (!row) return { state, ready: false };
    const crystal = require('../../Item/ItemTemplateIndex').find(DataCache.items, candidate.crystalId);
    const result = await Database.crystallizeInventoryItem(state.characterId, {
        sourceId: Number(row.id), sourceSelfId: gear.selfId, crystalId: candidate.crystalId,
        crystalName: crystal?.template?.name || '', crystalAmount: gear.crystals, coldState: state
    });
    state = consumeMaterials(state, [{ selfId: gear.selfId, amount: 1 }]);
    return { state: await acceptMutation(result, state, 'shot_crystallized'), ready: true };
}

function materialRows(items, recipe) { return Profit.materials(items, recipe); }

async function craft(state, candidate, index, now) {
    if (hotState(state)) return hotState(state);
    const productPerBatch = Number(candidate.recipe.productCount);
    const orePerBatch = Number(candidate.ore.amount);
    const mpPerBatch = Number(candidate.recipe.mpCost || 0);
    const batches = Math.min(Policy.batchCount(state, candidate), Number(candidate.maxBatches ?? 64));
    if (batches <= 0) return state;
    const crystals = await obtainCrystals(state, candidate, batches);
    if (!crystals.ready || crystals.hot || hotState(crystals.state)) return hotState(crystals.state) || crystals.state;
    const ore = await buyMaterial(crystals.state, Number(candidate.ore.selfId), orePerBatch * batches, candidate.orePrice, true, candidate.r,
        candidate.basket.purchases.find(row => row.selfId === Number(candidate.ore.selfId)));
    if (!ore.ready || ore.hot || hotState(ore.state)) return hotState(ore.state) || ore.state;
    state = ore.state;
    const batchRecipe = { ...candidate.recipe, materials: candidate.recipe.materials.map((material) => ({
        ...material, amount: Number(material.amount) * batches
    })) };
    const rows = materialRows(await Database.fetchItems(state.characterId), batchRecipe);
    if (hotState(state)) return hotState(state);
    if (!rows) return state;
    let admitted = null, crafted;
    try {
        admitted = await Commit.admit(state, Commit.KINDS.craft);
        state = admitted.state;
        crafted = await Database.craftInventoryItems(state.characterId, {
            materials: rows,
            product: { selfId: Number(candidate.recipe.productId), name: candidate.output.template?.name || '',
                amount: productPerBatch * batches, stackable: true, slot: 0 },
            recipeId: Number(candidate.recipe.recipeId), batches, economyCommand: admitted.command, coldState: state
        });
        state = await acceptMutation(crafted, { ...consumeMaterials(state, batchRecipe.materials), vitals: {
            ...(state.vitals || {}), mp: Number(crafted.mp)
        } }, 'shot_craft_inventory');
    } finally { if (admitted) Commit.finish(state.characterId, admitted.command); }
    if (crafted.success !== true) return state;
    const craftedUnits = Number(crafted.units || 0);
    const saved = await persist({ ...state, stats: { ...(state.stats || {}),
        shotCraft: { recipeId: Number(candidate.recipe.recipeId), productId: Number(candidate.recipe.productId),
            amount: craftedUnits, expectedProfit: candidate.profit,
            unitPrice: candidate.salePrice, at: now }
    } }, 'shot_craft_completed') || state;
    await LifeEvents.record(saved.characterId, 'shot_craft', `${saved.name} crafted ${craftedUnits} ${candidate.output.template?.name || 'shots'}`, {
        recipeId: Number(candidate.recipe.recipeId), productId: Number(candidate.recipe.productId),
        amount: craftedUnits, expectedProfit: candidate.profit
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
        const decision = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.decided(state);
        const step = Policy.unpackStep(decision?.shot);
        if (!step || step.wealth) return { state, reason: 'planning_pending' };
        const craftedState = await execute(state, step, now);
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
    const recipeId = Number(step?.craft?.recipeId || step?.recipeTarget);
    const recipe = Recipes.resolveByRecipeId(recipeId);
    if (!recipe || !CraftShopService.canCraft(state, recipe)) return state;
    const known = (await Database.execute(['SELECT recipeId FROM character_recipes WHERE characterId=? AND recipeId=? LIMIT 1',
        [Number(state.characterId), recipeId]])).length > 0;
    if (known && Number(recipe.recipeItemId) === Number(state.stats?.shotRecipeDemand?.itemId)) {
        state = await persist({ ...state, stats: { ...(state.stats || {}), shotRecipeDemand: null } }, 'shot_recipe_demand_filled') || state;
    }
    const selected = step.craft || step.recipeRoute;
    if (!selected) return state;
    if (Array.isArray(selected.gear) && Number(selected.gear[1]) > 0
        && !(await Database.execute(['SELECT recipeId FROM character_recipes WHERE characterId=? AND recipeId=? LIMIT 1',
            [Number(state.characterId), Number(selected.gear[1])]])).length) return state;
    const candidate = recheck(state, selected);
    if (!candidate) return state;
    if (step?.recipeTarget) {
        if (known) return state;
        const board = AfkTrade.boardIndex(), scrollId = Number(recipe.recipeItemId);
        const asks = board.list(scrollId, AfkTrade.SELL), bids = board.list(scrollId, AfkTrade.BUY);
        let ask = null, sale = null;
        for (let at = 0; at < Math.min(5, asks.length); at++) {
            const line = asks[at];
            if (line.ownerId !== Number(state.characterId) && !Number(line.enchant || 0) && (!ask || line.price < ask.price)) ask = line;
        }
        for (let at = 0; at < Math.min(5, bids.length); at++) if (bids[at].ownerId !== Number(state.characterId)
            && (!sale || bids[at].price > sale.price)) sale = bids[at];
        const decision = require('./WealthCraftDecision').recipePaths(state, recipe, { route: candidate, sale,
            acquisition: ask ? { available: true, price: Number(ask.price),
                hours: Number(candidate.context.trip.details?.(ask.town)?.hours || 0) } : null, context: candidate.context });
        if (!['learn', 'acquire'].includes(decision.best.kind)) return state;
        return obtainRecipe(state, { recipe, route: candidate, recipeDecision: decision,
            owned: Number(state.inventory?.[scrollId]?.amount || 0) > 0, scrollQuote: ask }, now);
    }
    if (step?.craft) {
        return known ? craft(state, { ...candidate, maxBatches: Number(step.craft.batches) }, null, now) : state;
    }
    return state;
}

module.exports = { review, reviewDemand, marketSnapshot, craftCandidate, recipeTarget,
    fundedDemand, scrapCraftRoutes, hasShotSurplus, SHOT_RECIPE_IDS, craft, obtainRecipe, execute, recheck,
    _resetForTests() { catalogCache = null; active.clear(); }
};
