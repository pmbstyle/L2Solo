const FailureLog = require('../../../FailureLog');
const Packet = require('./StatsPacket');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
invoke('GameServer/World/Generics/NpcShopBuyLists');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Profit = require('./CraftProfitPolicy');
const Workshops = require('./CraftWorkshopService');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const WealthCraft = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Commit = require('./EconomyCommit');
const Price = require('./PriceDecision');
const OfferQuery = require('./OfferQuery');
const Basket = require('./WealthCraftPolicy');
const ShotFunding = require('./ShotProductionFunding');
const Production = require('./ProductionPolicy');
const { personalOfferAllowed } = require('../Population/PartyAdmission');
// The one purchase path (a trip to the seller's town), loaded on use.
const ColdMarket = () => invoke('GameServer/Bot/Economy/ColdMarketService');

const Policy = require('./ShotCraftPolicy');
const ShotMarketIndex = require('./ShotMarketIndex');
const { SHOT_RECIPE_IDS, SHOT_PRODUCT_IDS, SHOT_RECIPE_ITEM_IDS, CRYSTAL_BY_RANK,
    fundedDemand, recipeTarget, scrapCraftRoutes, craftCandidate } = Policy;
const Wealth = require('./WealthCraftDecision');
const { CRYSTAL_SKILL_LEVEL } = require('./CraftEligibility');
const active = new Set();

// Recheck only the published physical quantity, exit and crystal source. The
// shared immutable NPC adjacency is initialised once; dynamic reads touch at
// most five indexed raw rows for each selected ingredient.
function recheck(state, selected, { physicalOnly = false } = {}) {
    const recipe = Recipes.resolveByRecipeId(Number(selected?.recipeId)), batches = Number(selected?.batches);
    const packet = state.stats?.money;
    if (!recipe || !SHOT_RECIPE_IDS.includes(Number(recipe.recipeId)) || !CraftShopService.canCraft(state, recipe)
        || !Number.isSafeInteger(batches) || batches < 1 || batches > 64
        || !Array.isArray(packet) || !(Packet.hourAdena(packet) > 0) || !(Packet.moneyPrice(packet) > 0)) return null;
    const Source = require('../Population/ColdOccupationSources'); Source.initialise();
    const board = AfkTrade.boardIndex(), Fields = require('../../AfkTrade/BoardIndex');
    const ownLines = board.ownerLines(Number(state.characterId));
    const ItemIndex = require('../../Item/ItemTemplateIndex');
    const context = { hourAdena: Number(Packet.hourAdena(packet)), moneyPrice: Number(Packet.moneyPrice(packet)), fixedBatches: batches,
        ...Source.craftLabour(state) };
    const trip = Profit.tripFor(state, context); context.trip = trip;
    const ownStock = new Map(), neededIds = new Set([Number(recipe.productId), Number(recipe.recipeItemId)]);
    for (const material of recipe.materials || []) neededIds.add(Number(material.selfId));
    const hint = selected.gear;
    const gearId = Number(hint?.[0] || 0), sourceCode = Number(hint?.[1] || 0), hintedTown = Policy.townForCode(hint?.[2]);
    const scrap = sourceCode > 0 ? Recipes.resolveByRecipeId(sourceCode) : null;
    if (scrap) for (const material of scrap.materials || []) neededIds.add(Number(material.selfId));
    if (sourceCode === -1) neededIds.add(gearId);
    const reserved = ItemDisposition.reservedEquipmentAmounts(state);
    for (const id of neededIds) {
        const row = state.inventory?.[id];
        // The worker values own stock at the same exit value (ColdOccupationSources).
        const value = Basket.drain(Source.exitValue(state, id, board));
        const amount = row ? require('./WealthCraftDecision').freeAmount(state, row, reserved) : 0;
        // Accepted incoming goods are the seller's own output too; the reserve
        // for its own use comes off their sum.
        const incoming = id === Number(recipe.productId) ? Number(state.acceptedIncoming?.[id] || 0) : 0;
        ownStock.set(id, { count: id === Number(recipe.productId) ? Math.max(0, amount + incoming - Number(selected.ownReserve || 0)) : amount,
            unitValue: value });
    }
    context.independentPrice = id => ownStock.get(Number(id))?.unitValue ?? NaN;
    let exit = null;
    if (Array.isArray(selected.exit) && selected.exit.length === 4) {
        const [recordId, lineId, price, revision] = selected.exit.map(Number);
        const compact = selected.exit[0] == null && selected.exit[2] == null;
        if (recordId > 0 || compact) {
            const line = compact ? Price.productionBids(board, recipe.productId)
                .find(row => Number(row.lineId) === lineId) : board.records.get(recordId)?.find(row => Number(row.lineId) === lineId);
            if (!line || line.storeType !== AfkTrade.BUY || line.revision !== revision || !compact && line.price !== price
                || line.selfId !== Number(recipe.productId) || line.ownerId === Number(state.characterId)) return null;
            exit = { type: 'afk', conditional: line.custodyPolicy === 1, price: Number(line.price), count: Number(line.count), town: line.town, offer: Fields.offerFields(line) };
        } else if (recordId === -1 && Number.isSafeInteger(lineId) && lineId > 0 && price > 0 && revision >= 0) {
            exit = { type: 'use', price: 0, count: 0, ownUseUnits: lineId, ownUseUnitHours: price, residualUnitValue: 0 };
        } else if ((recordId === -2 || recordId === -3) && Number.isSafeInteger(lineId) && price > 0 && revision > 0) {
            exit = require('./ProductionSalePolicy').exit(state, Number(recipe.productId), { board,
                town: Policy.townForCode(lineId), trip, current: price, lot: Number(recipe.productCount),
                origin: recordId === -3 ? 'public_buy_interest' : 'public_item_trades',
                productionUnits: batches * Number(recipe.productCount),
                reserve: Math.max(0, Number(selected.ownReserve || 0) - Number(state.inventory?.[recipe.productId]?.amount || 0)
                    - Number(state.acceptedIncoming?.[recipe.productId] || 0)),
                npcOffers: Source.npcOffersFor(Number(recipe.productId)),
                units: Number(recipe.productCount) + Number(ownStock.get(Number(recipe.productId))?.count || 0)
                    + ownLines.filter(line => line.storeType === AfkTrade.SELL && line.custodyPolicy !== 1
                        && line.selfId === Number(recipe.productId)).reduce((sum, line) => sum + Number(line.count), 0) });
            // A forecast has no accepted price authority. Reprice it against
            // current evidence and revalue the selected physical quantity;
            // public bids above still require their exact line and revision.
            // Public interest is a forecast, not an accepted order. Other
            // buyers may change while the worker runs: the fresh curve and
            // fixed-quantity valuation below decide whether this lot pays.
            if (!exit || recordId === -2 && exit.forecast.authority.revision < revision) return null;
        }
    } else {
        const rows = Price.productionBids(board, recipe.productId);
        for (let at = 0; at < rows.length; at++) if (rows[at].ownerId !== Number(state.characterId)) {
            const line = rows[at]; exit = { type: 'afk', conditional: line.custodyPolicy === 1, price: line.price, count: line.count, town: line.town, offer: Fields.offerFields(line) }; break;
        }
    }
    if (!exit) return null;
    if (exit.type === 'afk') {
        const { cheaperUnits, limit } = Price.exitCompetition(board.list(recipe.productId, AfkTrade.SELL),
            { ownerId: state.characterId, price: exit.price, count: exit.count });
        if (limit) return null;
        exit.cheaperUnits = cheaperUnits;
        exit.trip = trip(exit.town); exit.tripDetails = trip.details?.(exit.town);
        exit = Price.prospectiveExit(state, exit, { board });
        const output = ownStock.get(Number(recipe.productId));
        for (const line of ownLines) {
            if (line.storeType !== AfkTrade.SELL || line.custodyPolicy === 1 || line.selfId !== Number(recipe.productId)) continue;
            if (line.price !== exit.price) return null;
        }
    }
    // The worker's purchase rule (ColdOccupationSources.preparePurchase): the
    // inspected board lines and the NPC shop of the town the bot stands in, one
    // call; none in the field (a crafter buys only where it stands, ColdMarketService.acquire).
    const here = state.activity === 'shopping' ? state.currentRegion : null;
    const purchase = (id, amount, query = {}) => {
        if (!here || id === gearId && sourceCode === -3 && hintedTown !== here) return null;
        const npcOffers = query.npc === true && Production.allowsNpcShot(id) ? Source.npcOffersFor(id) : [];
        const best = OfferQuery.cheapestTown(board, id, { amount, cost: trip, excludeOwner: state.characterId,
            quoteDepth: Price.QUOTE_DEPTH, towns: [here], npcOffers,
            accept: line => !Number(line.enchant || 0) && personalOfferAllowed(line, state) });
        return best?.whole ? { ...best, tripDetails: trip.details?.(best.town), selfId: Number(id) } : null;
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
    const personal = Number(selected.ownReserve) > 0
        ? invoke('GameServer/Bot/Economy/EconomyContext').keptKit(state).stock('shots') : null;
    const stock = personal && Number(personal.itemId) === Number(recipe.productId)
        ? { ...personal, target: Math.max(Number(personal.target || 0), Number(selected.ownReserve)) } : null;
    if (stock) ownStock.get(Number(recipe.productId)).count = Math.max(0,
        Number(state.inventory?.[recipe.productId]?.amount || 0) + Number(state.acceptedIncoming?.[recipe.productId] || 0) - stock.target);
    const options = { ownStock, ownLines, stock, physicalOnly, ownIncludesIncoming: true, knownRecipes: scrap ? [{ recipeId: scrap.recipeId }] : [],
        itemTemplate: id => ItemIndex.find(DataCache.items, Number(id)), gearRowsFor: () => gear ? [gear] : [],
        prepareTrip: function* (town) { yield 'trip'; return trip.details?.(town) || { known: false }; },
        preparePurchase: function* (owner, id, amount, query) { yield 'quote'; return purchase(id, amount, query); },
        prepareExits: function* () { yield 'exit'; return [exit]; } };
    const candidate = require('./WealthCraftPolicy').drain(Policy.recipeShotSearch(state, recipe, context, options));
    if (!candidate || Number(candidate.gear?.selfId || 0) !== gearId && gearId > 0) return null;
    return candidate;
}

function marketSnapshot(now = Date.now(), ownState = null) {
    Workshops.init();
    const index = ShotMarketIndex.native();
    return { ...index.marketSnapshot(now, ownState), offersFor: (...args) => index.offersFor(...args) };
}

function recheckSeries(state, first, selected) {
    const count = selected.horizonBatches;
    if (count === undefined) return first;
    if (!Number.isSafeInteger(count) || count < Number(selected.batches) || count > 64) return null;
    if (count === Number(selected.batches)) return first;
    const Horizon = require('./ShotProductionHorizon');
    const projected = Horizon.projectState(state, first.recipe, first.context);
    if (!projected) return null;
    const series = recheck(projected, { ...selected, batches: count, horizonBatches: undefined });
    if (!series || !Horizon.sameSource(first.gear, series.gear)) return null;
    for (const purchase of first.basket.purchases) {
        if (series.basket.purchases.some(row => row.selfId === purchase.selfId && row.town !== purchase.town)) return null;
    }
    const valued = Horizon.value(series, state, first, first.context);
    return valued && require('./ShotProductionFunding').canFund(state, valued, first.context) ? valued : null;
}

function noteBuyer(state) { ShotMarketIndex.native().update(state); }

function hasShotSurplus(state) {
    if (!(Number(state?.stats?.shotCraft?.productId) > 0)) return false;
    const kept = ShotStock.keptAmounts(state);
    // This is only a cheap admission check. The listing policy still applies
    // reservations, funded demand and competing supply before publishing.
    return [...SHOT_PRODUCT_IDS].some(id => Number(state.inventory?.[id]?.amount || 0) > Number(kept[id] || 0));
}

// The recipe want is the bot's own preparation: no situation of its own (own outputs
// are not inputs); the wish graph and the board read it at the bot's next decision.
const recipeDemandStats = (state, wanted) => ({ ...(state.stats || {}), shotRecipeDemand: wanted });

async function obtainRecipe(state, selected, now) {
    const { recipe, route } = selected;
    const hourAdena = invoke('GameServer/Bot/AI/BotHuntEfficiency').hourValue(state, now).perHour;
    if (!((selected.production || route)?.profit > 0)) return state;
    const itemId = Number(recipe.recipeItemId);
    const valueHours = Number(selected.recipeDecision?.best?.valueHours ?? route.valueHours ?? route.profit / hourAdena);
    const funding = selected.recipeDecision?.best?.funding || { valueHours };
    const maxSpend = Math.floor(Math.min(PurchaseFunding.spendable(state, 0, funding),
        Number(selected.recipeDecision?.best?.purchaseCap ?? Infinity)));
    const wanted = state.stats?.shotRecipeDemand;
    const plannedBatches = Number(selected.production?.batches || route.batches);
    const inputCash = Number((selected.production || route).valuation?.cashNow);
    if (!Number.isFinite(inputCash) || inputCash < 0) return state;
    if (!wanted || Number(wanted.itemId) !== itemId
        || Number(wanted.recipeId) !== Number(recipe.recipeId) || Number(wanted.batches) !== plannedBatches
        || Number(wanted.inputCash) !== inputCash
        || maxSpend > Number(wanted.maxSpend || 0) * 1.25 || maxSpend < Number(wanted.maxSpend || 0)) {
        state = await persist({ ...state, stats: recipeDemandStats(state,
            { itemId, recipeId: Number(recipe.recipeId), batches: plannedBatches, amount: 1, maxSpend, inputCash, at: now })
        }, 'shot_recipe_demand') || state;
    }
    const affordableOffer = () => {
        if (selected.scrollQuote) return Number(selected.scrollQuote.price) <= maxSpend ? selected.scrollQuote : null;
        return AfkTrade.boardIndex().list(itemId, AfkTrade.SELL).find(row => row.ownerId !== Number(state.characterId)
            && row.price > 0 && row.price <= maxSpend && row.count > 0) || null;
    };
    if (Number(state.inventory?.[itemId]?.amount || 0) > 0) {
        return await LifeState.learnCraftableRecipes(state, { recipeIds: [Number(recipe.recipeId)] }) || state;
    }
    const offer = affordableOffer();
    if (!offer) return state;
    try {
        // The recipe is bought here or not at all (one purchase path: no crafter errand).
        const bought = await ColdMarket().acquire(state, itemId, 1, { money: maxSpend, maxPrice: maxSpend,
            ...funding, npc: false, purpose: 'recipe', timestamp: now, quoteDepth: 5, towns: [offer.town],
            sourcePlan: { selfId: itemId, town: offer.town, cost: Number(offer.price),
                landed: Number(offer.price) + Number(route.context.trip?.(offer.town) || 0),
                npc: 0, lines: [{ line: offer, count: 1, price: Number(offer.price) }] } });
        if (!bought.bought || bought.hot) return bought.state;
        const learned = await LifeState.learnCraftableRecipes(bought.state, { recipeIds: [Number(recipe.recipeId)] }) || bought.state;
        if (!(learned.stats?.lastRecipeBookLearning?.learned || [])
            .some((entry) => Number(entry.recipeId) === Number(recipe.recipeId))) return learned;
        const acquired = await persist({ ...learned, stats: recipeDemandStats(learned, null) }, 'shot_recipe_acquired') || learned;
        return acquired;
    } catch (error) {
        // After a paid buy the cache's adena and recipe disagree with the row until the next read.
        if (!FailureLog.refusal(error)) FailureLog.note('economy.recipe_buy', error);
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
// (ColdMarketService.acquire): in the town the bot stands in, never on an
// errand. Returns { state, ready }: ready once the bot holds the amount.
const hotState = state => LifeState.hotRow(state.characterId) || (state.phase === 'hot' ? state : null);

// A held plan is bought up to its dearest unit, whatever cap came with it.
const planCap = (plan, price) => plan ? OfferQuery.topPrice(plan) || price : price;

async function buyMaterial(state, selfId, amount, maxPrice = Infinity, npc = true, r = 0, sourcePlan = null) {
    const hot = hotState(state);
    if (hot) return { state: hot, ready: false, hot: true };
    const missing = amount - Wealth.freeOf(state, selfId);
    if (missing <= 0) return { state, ready: true };
    const bought = await ColdMarket().acquire(state, selfId, missing, { maxPrice: planCap(sourcePlan, maxPrice), npc, purpose: 'craft_input',
        r, money: PurchaseFunding.spendable(state, 0, { r }), quoteDepth: 5, refreshSource: true,
        ...(sourcePlan ? { sourcePlan, towns: [sourcePlan.town] } : {}) });
    return { state: bought.state, ready: bought.bought && !bought.hot && Wealth.freeOf(bought.state, selfId) >= amount };
}

// The crystals of a shot craft: the bot's own, else bought on the board, or a
// piece of gear bought (or crafted from bought inputs) and crystallized; each
// purchase on the one purchase path. Returns { state, ready }.
async function obtainCrystals(state, candidate, batches) {
    const hot = hotState(state);
    if (hot) return { state: hot, ready: false, hot: true };
    const needed = candidate.requiredCrystals * batches;
    if (Wealth.freeOf(state, candidate.crystalId) >= needed) return { state, ready: true };
    const gear = candidate.gear;
    if (!gear) return { state, ready: false };
    if (gear.source === 'crystals') return buyMaterial(state, candidate.crystalId, needed, gear.price, false, candidate.r,
        candidate.basket.purchases.find(row => row.selfId === candidate.crystalId));
    const [skill] = await Database.fetchSkill(state.characterId, 248);
    if (Number(skill?.level || 0) < CRYSTAL_SKILL_LEVEL[candidate.rank]) return { state, ready: false };
    const ownedRows = await Database.fetchItems(state.characterId, 'cold_shot_crystals_owned');
    const ownedRowIds = new Set(ownedRows.map(item => Number(item.id)));
    if (gear.source === 'craft') {
        const requirements = gear.inputs.map(input => {
            const sourcePlan = gear.purchases?.find(row => row.selfId === Number(input.selfId));
            return { selfId: input.selfId, amount: input.amount, options: { maxPrice: planCap(sourcePlan, input.maxPrice),
                npc: true, purpose: 'craft_input', r: candidate.r,
                money: PurchaseFunding.spendable(state, 0, { r: candidate.r }), quoteDepth: 5, refreshSource: true,
                ...(sourcePlan ? { sourcePlan, towns: [sourcePlan.town] } : {}) } };
        });
        const oreId = Number(candidate.ore.selfId);
        const oreSource = candidate.basket.purchases.find(row => row.selfId === oreId);
        const existing = requirements.find(row => Number(row.selfId) === oreId);
        if (existing) existing.amount += Number(candidate.ore.amount) * batches;
        else requirements.push({ selfId: oreId, amount: Number(candidate.ore.amount) * batches,
            options: { maxPrice: planCap(oreSource, candidate.orePrice), npc: true, purpose: 'craft_input', r: candidate.r,
                money: PurchaseFunding.spendable(state, 0, { r: candidate.r }), quoteDepth: 5, refreshSource: true,
                ...(oreSource ? { sourcePlan: oreSource, towns: [oreSource.town] } : {}) } });
        const next = await ColdMarket().acquireMaterials(state, requirements);
        const activated = hotState(next.state);
        if (next.hot || activated) return { ...next, state: activated || next.state, ready: false, hot: true };
        if (!next.ready) return next;
        state = next.state;
        const materials = materialRows(await Database.fetchItems(state.characterId, 'cold_shot_crystals_gear'), gear.recipe);
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
        } catch (error) {
            if (!WealthCraft.craftRefused(error)) throw error;
            return { state: await refusedCraft(state, candidate), ready: false };
        } finally { if (admitted) Commit.finish(state.characterId, admitted.command); }
        if (result.success !== true) return { state, ready: false };
    } else if (gear.source === 'afk' || gear.source === 'npc') {
        const bought = await ColdMarket().acquire(state, gear.selfId, 1, { maxPrice: gear.price, npc: gear.source === 'npc',
            purpose: 'craft_input', r: candidate.r, money: PurchaseFunding.spendable(state, 0, { r: candidate.r }),
            quoteDepth: 5, refreshSource: true,
            ...(gear.sourcePlan ? { sourcePlan: gear.sourcePlan, towns: [gear.sourcePlan.town] } : {}) });
        if (!bought.bought || bought.hot) return { state: bought.state, ready: false };
        state = bought.state;
    }
    const row = (await Database.fetchItems(state.characterId, 'cold_shot_crystals_row')).find(item =>
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

// A shot craft (or the gear craft feeding its crystals) the native commit refused is
// a wealth craft's refusal: counted, the shot recipe marked until the next town look.
const refusedCraft = (state, candidate) => WealthCraft.rejectAccepted(state, state,
    { kind: 'shot', reason: 'craft_failed', recipeId: Number(candidate.recipe.recipeId) });

async function craft(state, candidate, index, now) {
    if (hotState(state)) return hotState(state);
    const productPerBatch = Number(candidate.recipe.productCount);
    const orePerBatch = Number(candidate.ore.amount);
    const mpPerBatch = Number(candidate.recipe.mpCost || 0);
    const batches = Math.min(Policy.batchCount(state, candidate), Number(candidate.maxBatches ?? 64));
    if (batches <= 0) return state;
    const series = candidate.series || null;
    const held = state.stats?.shotCraft?.preparing;
    const gearTarget = Number(state.stats?.equipmentPlan?.target?.selfId || 0);
    // The piece of gear the crystals come from (bought, crafted or owned) is the kit's
    // too: held from sale until it is crystallized (ItemDisposition.productionInputAmounts).
    const crystalGear = candidate.gear && candidate.gear.source !== 'crystals' ? Number(candidate.gear.selfId) : 0;
    if (Number(held?.recipeId) !== Number(candidate.recipe.recipeId)
        || Number(held?.batches) !== batches || Number(held?.gearTarget) !== gearTarget
        || Number(held?.crystalGear || 0) !== crystalGear
        || !held?.gearInputs || Number(held?.at) + 30 * 60 * 1000 <= now
        || JSON.stringify(state.stats?.shotCraft?.series || null) !== JSON.stringify(series)) {
        const gearInputs = Number(held?.gearTarget) === gearTarget && held?.gearInputs
            && Number(held.at) + 30 * 60 * 1000 > now ? held.gearInputs : ItemDisposition.collectedEquipmentInputs(state);
        // Its own preparation: no situation of its own (own outputs are not inputs).
        state = await persist({ ...state, stats: { ...state.stats, shotCraft: { ...state.stats?.shotCraft, series,
            preparing: { recipeId: Number(candidate.recipe.recipeId), productId: Number(candidate.recipe.productId),
                batches, gearTarget, gearInputs, ...(crystalGear ? { crystalGear } : {}), at: now } } } }, 'shot_craft_preparing');
    }
    const crystals = await obtainCrystals(state, candidate, batches);
    if (!crystals.ready || crystals.hot || hotState(crystals.state)) return hotState(crystals.state) || crystals.state;
    const ore = await buyMaterial(crystals.state, Number(candidate.ore.selfId), orePerBatch * batches, candidate.orePrice, true, candidate.r,
        candidate.basket.purchases.find(row => row.selfId === Number(candidate.ore.selfId)));
    if (!ore.ready || ore.hot || hotState(ore.state)) return hotState(ore.state) || ore.state;
    state = ore.state;
    const batchRecipe = { ...candidate.recipe, materials: candidate.recipe.materials.map((material) => ({
        ...material, amount: Number(material.amount) * batches
    })) };
    const rows = materialRows(await Database.fetchItems(state.characterId, 'cold_shot_craft'), batchRecipe);
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
    } catch (error) {
        if (!WealthCraft.craftRefused(error)) throw error;
        return refusedCraft(state, candidate);
    } finally { if (admitted) Commit.finish(state.characterId, admitted.command); }
    if (crafted.success !== true) return state;
    const craftedUnits = Number(crafted.units || 0);
    const saved = await persist({ ...state, stats: { ...(state.stats || {}),
        shotCraft: { recipeId: Number(candidate.recipe.recipeId), productId: Number(candidate.recipe.productId),
            amount: craftedUnits, expectedProfit: candidate.profit,
            unitPrice: candidate.salePrice, town: candidate.exit.town,
            saleKind: candidate.exit.type, at: now,
            ...(series?.batches > batches ? { series: { ...series,batches:series.batches-batches } } : {}) }
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
        Workshops.register(state);
        noteBuyer(state);
        // Gone for its restock, or another errand waits: no craft now.
        if (state.activity === 'traveling' || ColdMarket().pendingErrand(state, now)) return { state };
        const decision = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.decided(state);
        const step = Policy.unpackStep(decision?.shot);
        if (state.stats?.shotCraft?.series && (!craftsShots(state) || step?.wealth
            || !require('./ShotProductionHorizon').retainedBatches(state,AfkTrade.boardIndex(),now)))
            state = await dropSeries(state);
        // No shot step this round (a purchase or sale took it, or a wealth craft)
        // keeps a recipe want; a bot that no longer crafts shots drops it.
        if (!step || step.wealth) return { state: craftsShots(state) ? state : await dropRecipeDemand(state),
            reason: 'planning_pending' };
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

// The bot's shot recipe want (stats.shotRecipeDemand) ends when the plan
// drops it: the bot can no longer craft shots, the step names another recipe
// or a craft, or the recipe no longer pays its learning (MarketDemandIndex: no clock).
// A crafter that can learn a shot recipe at all (not a pause: a party, an errand, a gear craft).
const craftsShots = state => CraftShopService.isServiceCrafter(state) && CraftShopService.craftLevelFor(state) >= 2
    && !state.stats?.craftStationId;
async function dropSeries(state, keepRecipeId = 0) {
    const series = state.stats?.shotCraft?.series;
    const preparing = state.stats?.shotCraft?.preparing;
    const clearSeries = series && Number(series.recipeId) !== Number(keepRecipeId);
    const clearGear = preparing?.crystalGear && Number(preparing.recipeId) !== Number(keepRecipeId);
    if (!clearSeries && !clearGear) return state;
    const kept = { ...preparing };
    delete kept.crystalGear;
    return persist({ ...state, stats: { ...state.stats,
        shotCraft: { ...state.stats.shotCraft, ...(clearSeries ? { series: null } : {}),
            ...(clearGear ? { preparing: kept } : {}) } } }, 'shot_series_dropped');
}
async function dropRecipeDemand(state, keepItemId = 0) {
    const wanted = state.stats?.shotRecipeDemand;
    if (!wanted || Number(wanted.itemId) === Number(keepItemId)) return state;
    return await persist({ ...state, stats: recipeDemandStats(state, null) }, 'shot_recipe_demand_dropped') || state;
}

async function execute(state, step, now = Date.now()) {
    if (!Policy.eligible(state, now)) return craftsShots(state) ? state : dropRecipeDemand(await dropSeries(state));
    const recipeId = Number(step?.craft?.recipeId || step?.recipeTarget);
    state = await dropSeries(state,recipeId);
    const recipe = Recipes.resolveByRecipeId(recipeId);
    state = await dropRecipeDemand(state, step?.recipeTarget ? recipe?.recipeItemId : 0);
    if (!recipe || !CraftShopService.canCraft(state, recipe)) return dropRecipeDemand(state);
    const known = (await Database.execute(['SELECT recipeId FROM character_recipes WHERE characterId=? AND recipeId=? LIMIT 1',
        [Number(state.characterId), recipeId]])).length > 0;
    if (known && Number(recipe.recipeItemId) === Number(state.stats?.shotRecipeDemand?.itemId)) {
        state = await persist({ ...state, stats: recipeDemandStats(state, null) }, 'shot_recipe_demand_filled') || state;
    }
    const selected = step.craft || step.recipeRoute;
    if (!selected) return state;
    if (Array.isArray(selected.gear) && Number(selected.gear[1]) > 0
        && !(await Database.execute(['SELECT recipeId FROM character_recipes WHERE characterId=? AND recipeId=? LIMIT 1',
            [Number(state.characterId), Number(selected.gear[1])]])).length) return state;
    const hasSeries = Number.isSafeInteger(selected.horizonBatches) && selected.horizonBatches > selected.batches
        && selected.horizonBatches <= 64;
    const candidate = recheck(state, selected, { physicalOnly: hasSeries });
    // In the field a crafter crafts from its bag only (recheck buys nothing there): a craft
    // that needs a purchase (an input, crystals, gear to crystallize, the recipe) waits for
    // its town visit, where it buys; as a C4 crafter shops in town.
    const inTown = state.activity === 'shopping';
    // What the act refuses in town is heard, its recipe marked as a wealth craft's: the
    // search does not pick it again until the next town look.
    if (!candidate) {
        if (!inTown) return state;
        state = await dropSeries(state);
        const dropped = step?.recipeTarget ? await dropRecipeDemand(state) : state;
        return WealthCraft.rejectAccepted(dropped, dropped, { kind: 'shot', reason: 'no_basket', recipeId });
    }
    const production = recheckSeries(state, candidate, selected);
    if (!production) {
        if (!inTown) return state;
        state = await dropSeries(state);
        return step?.recipeTarget ? dropRecipeDemand(state) : state;
    }
    if (step?.recipeTarget) {
        if (known || !inTown && !(Number(state.inventory?.[recipe.recipeItemId]?.amount || 0) > 0)) return state;
        const board = AfkTrade.boardIndex(), scrollId = Number(recipe.recipeItemId);
        const asks = board.list(scrollId, AfkTrade.SELL), bids = board.list(scrollId, AfkTrade.BUY);
        let sale = null;
        const ask = asks.find(line => line.ownerId !== Number(state.characterId) && !Number(line.enchant || 0)) || null;
        for (let at = 0; at < Math.min(5, bids.length); at++) if (bids[at].ownerId !== Number(state.characterId)
            && (!sale || bids[at].price > sale.price)) sale = bids[at];
        const decision = ShotFunding.recipePaths(state, recipe, { route: production, sale, allowSeeking: true,
            acquisition: ask ? { available: true, price: Number(ask.price),
                hours: Number(candidate.context.trip.details?.(ask.town)?.hours || 0),
                fees: Number(candidate.context.trip.details?.(ask.town)?.fees || 0) } : null, context: candidate.context });
        if (!['learn', 'acquire', 'seek'].includes(decision.best.kind)) return dropRecipeDemand(state);
        return obtainRecipe(state, { recipe, route: candidate, production, recipeDecision: decision,
            owned: Number(state.inventory?.[scrollId]?.amount || 0) > 0, scrollQuote: ask }, now);
    }
    if (step?.craft) {
        if (!inTown && candidate.basket.cashCost + candidate.basket.actualCashFees > 0) return state;
        const funding = ShotFunding.investment(production, candidate.context);
        const certificate = Policy.selectionFor(production);
        return known && funding ? craft(state, { ...candidate, r: funding.terms.r,
            ...(production.batches > candidate.batches ? { series: { recipeId,batches:production.batches,at:now,
                exit:certificate.exit,ownReserve:Number(certificate.ownReserve || 0) } } : {}),
            maxBatches: Number(step.craft.batches) }, null, now) : state;
    }
    return state;
}

module.exports = { review, marketSnapshot, craftCandidate, recipeTarget,
    fundedDemand, scrapCraftRoutes, hasShotSurplus, SHOT_RECIPE_IDS, craft, obtainRecipe, execute, recheck, recheckSeries,
    _resetForTests() { active.clear(); }
};
