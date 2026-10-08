'use strict';
// Pure worker decisions. Monetary/physical settlement remains on main.
const Policy = require('./WealthCraftPolicy');
const Profit = require('./CraftProfitPolicy');
const Valuation = require('./EconomicValuation');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const StaticMerchantPricing = require('./StaticMerchantPricing');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const PurchaseFunding = require('./PurchaseFunding');
const Karma = require('../../Karma');
let staticIndex = null;
function staticExits(recipe, template) {
    if (require('./ProductionPolicy').buyersDisabled()
        || !String(template?.template?.kind || '').startsWith('Other.Material')) return [];
    if (!staticIndex) {
        staticIndex = new Map();
        for (const [buyerName, store] of Object.entries(MerchantStoreConfigs)) {
            if (Number(store?.storeType) !== 3 || !store.town) continue;
            for (const line of store.items || []) {
                const id = Number(line.selfId);
                if (!staticIndex.has(id)) staticIndex.set(id, []);
                staticIndex.get(id).push({ buyerName, store, line });
            }
        }
    }
    const result = [];
    for (const { buyerName, store, line } of staticIndex.get(Number(recipe.productId)) || []) {
        const price = StaticMerchantPricing.botPriceFor(store, line);
        if (Number.isFinite(price) && price > 0) result.push({ type: 'static', price,
            count: Math.max(0, Number(line.count || 0)), town: store.town, buyerName, repeatable: true });
    }
    return result;
}
function exitsFor(state, recipe, template, trip, options) {
    const result = [];
    for (const offer of options.offersFor?.(recipe.productId, 3, state.characterId) || []) {
        result.push({ type: 'afk', price: Number(offer.price), count: Number(offer.count), offer,
            town: offer.town, trip: trip(offer.town), tripDetails: trip.details?.(offer.town), repeatable: false });
    }
    for (const exit of (options.staticExits || staticExits)(recipe, template)) result.push({ ...exit,
        trip: Number(exit.trip ?? trip(exit.town)), tripDetails: exit.tripDetails || trip.details?.(exit.town) });
    return result;
}
function eligible(state, { buyOrderEscrow = 0, ownLines = [], now = Date.now() } = {}) {
    if (!state || state.phase !== 'cold' || !['hunting', 'resting', 'shopping'].includes(state.activity)
        || require('../Population/CombinedErrandPolicy').pending(state, now).length
        || state.party?.partyId || state.partyId || Karma.closesTowns(state.stats?.karma)
        || state.stats?.craftStationId || /^bot_craft_\d+$/i.test(String(state.accountName || ''))) return false;
    if (!CraftShopService.isServiceCrafter(state) || CraftShopService.craftLevelFor(state) <= 0) return false;
    if (state.stats?.equipmentPlan?.strategy === 'craft'
        && ['active', 'component_ready', 'ready_to_craft'].includes(state.stats.equipmentPlan.status)) return false;
    if (Number(buyOrderEscrow) > 0) return false;
    const previous = state.stats?.wealthCraft;
    if (previous?.outcome === 'waiting_for_buyer') {
        const id = Number(previous.productId);
        if (Number(state.inventory?.[id]?.amount || 0) > 0
            || ownLines.some(line => Number(line.storeType) === 1 && Number(line.selfId) === id && Number(line.count) > 0)) return false;
    }
    return true;
}
function freeAmount(state, item, reserved = {}) {
    if (item.protected || item.acceptedCustomer || item.assignedClan || item.available === false) return 0;
    return Math.max(0, Math.floor(Number(item.amount ?? item.count ?? 0))
        - Math.max(Number(item.equippedCount || (item.equipped ? item.amount ?? 1 : 0)),
            Number(reserved[item.selfId] || 0), Number(state.stats?.clanMaterialDemand?.[item.selfId] || 0),
            Number(item.protectedAmount || 0), Number(item.starterMobLootAmount || 0), Number(item.reservedAmount || 0)));
}
function* decisionSearch(state, knownRecipes, context, options, mode) {
    const budgetState = { ...state, adena: PurchaseFunding.spendable(state, 0, { upperBound: true }) };
    const trip = context.trip || Profit.tripFor(state, context);
    const evaluationContext = { ...context, trip, ...(options.preparePurchase ? {
        preparePurchase: (id, missing) => options.preparePurchase(state, id, missing, { npc: true, cost: trip }) } : {}) };
    const reserved = options.reserved || ItemDisposition.reservedEquipmentAmounts(state);
    const ownStock = options.ownStock || new Map(), seenPhysical = new Set();
    if (!options.ownStock) for (const key in state.inventory || {}) {
        const item = state.inventory[key];
        const id = Number(item.selfId), physicalKey = item.physicalId || `bag:${id}`;
        if (seenPhysical.has(physicalKey)) { yield 'stock'; continue; }
        seenPhysical.add(physicalKey);
        const count = freeAmount(state, item, reserved);
        if (count) ownStock.set(id, { count: (ownStock.get(id)?.count || 0) + count,
            unitValue: Number(context.independentPrice?.(id) ?? context.price?.(id) ?? context.worth?.(id)
                ?? ItemDisposition.priceFor(state, item, ItemTemplateIndex.find(DataCache.items, id))) });
        yield 'stock';
    }
    // Bag is the spendable physical index. Board/warehouse goods are included
    // once in the output without-case, but cannot be consumed from this bag.
    const outputStock = new Map(), outputPrices = new Map();
    for (const source of [options.ownLines || [], options.warehouseRows || []]) for (const item of source) {
        const boardRow = source === options.ownLines;
        const id = Number(item.selfId), key = item.physicalId || item.authorityId
            || (boardRow && item.recordId && item.lineId ? `board:${item.recordId}:${item.lineId}` : null);
        if (boardRow && Number(item.storeType ?? item.side ?? 1) !== 1) { yield 'stock'; continue; }
        if (!key || seenPhysical.has(key) || item.protected || item.acceptedCustomer || item.assignedClan) { yield 'stock'; continue; }
        seenPhysical.add(key);
        outputStock.set(id, Number(outputStock.get(id) || 0) + Math.max(0, Number(item.count ?? item.amount ?? 0)));
        if (boardRow) {
            if (!outputPrices.has(id)) outputPrices.set(id, new Set());
            outputPrices.get(id).add(Number(item.price));
        }
        yield 'stock';
    }
    const ownedFor = id => ownStock.get(Number(id)) || null;
    let best = null;
    const learned = new Set((knownRecipes || []).map(row => Number(row.recipeId ?? row)));
    const seen = new Set();
    function* candidates() {
        yield* knownRecipes || [];
        for (const key in state.inventory || {}) {
            const recipe = Recipes.resolve(Number(state.inventory[key].selfId || key));
            if (recipe && freeAmount(state, state.inventory[key], reserved) > 0) yield recipe;
        }
        yield* options.unknownRecipes?.() || [];
    }
    for (const known of candidates()) {
        const id = Number(known.recipeId ?? known);
        if (seen.has(id)) { yield 'recipe'; continue; }
        seen.add(id);
        const recipe = Recipes.resolveByRecipeId(id);
        yield 'recipe';
        if (!recipe || recipe.type !== 'dwarven' || !CraftShopService.canCraft(state, recipe)) continue;
        const template = ItemTemplateIndex.find(DataCache.items, recipe.productId);
        if (!template || !recipe.materials?.length) continue;
        const exits = options.prepareExits ? yield* options.prepareExits(state, recipe, template, trip)
            : exitsFor(state, recipe, template, trip, options);
        if (!options.prepareExits) yield 'exits';
        for (const exit of exits) {
            for (const price of outputPrices.get(Number(recipe.productId)) || []) {
                if (price !== Number(exit.price)) exit.unknownJoint = true;
                yield 'quote';
            }
        }
        const learning = !learned.has(id);
        // Unknown shot acquisition already belongs to the shared shot route;
        // retain that executor and its existing compact recipeTarget command.
        if (learning && String(template.template?.kind || '').startsWith('Other.Shot')) continue;
        if (learning && !ItemDisposition.canLearnRecipe(state, { selfId: Number(recipe.recipeItemId) })) continue;
        const recipeContext = { ...evaluationContext,
            ...(learning ? { recipeInput: Number(recipe.recipeItemId),
                recipeStock: ownStock.get(Number(recipe.recipeItemId)),
                ...(options.preparePurchase ? { preparePurchase: (itemId, missing) => options.preparePurchase(state, itemId, missing,
                    { npc: Number(itemId) !== Number(recipe.recipeItemId), cost: trip }) } : {}) } : {}),
            existingOutput: Number(ownStock.get(Number(recipe.productId))?.count || 0) + Number(outputStock.get(Number(recipe.productId)) || 0) };
        const candidate = yield* Policy.searchQuantity({ state: budgetState, recipe,
            planFor: (id, missing) => options.planPurchase?.(state, id, missing, { npc: true, cost: trip }),
            exits, ownedFor, context: recipeContext, mode });
        if (!candidate) continue;
        const cash = candidate.basket.cashCost + candidate.basket.actualCashFees;
        const r = cash > 0 ? candidate.valueHours / cash : Infinity;
        const score = mode === 'occupation' ? candidate.incomePerHour : candidate.valueHours;
        if (cash <= PurchaseFunding.spendable(state, 0, { r }) && score > 0
            && (!best || score > (mode === 'occupation' ? best.incomePerHour : best.valueHours))) best = { ...candidate, template, r, learning };
        yield 'funding';
    }
    return best;
}
function chooseOpportunity(state, knownRecipes, context = Profit.contextFor(state), options = {}) {
    return Policy.drain(decisionSearch(state, knownRecipes, context, options, 'action'));
}
function occupationResult(row) {
    return row && row.incomePerHour > 0 && row.hours > 0 ? { known: true, recipeId: Number(row.recipe.recipeId),
        productId: Number(row.recipe.productId), incomePerHour: row.incomePerHour, cycleHours: row.hours }
        : { known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0 };
}
function createOccupation(state, knownRecipes, context, options = {}) {
    return { iterator: decisionSearch(state, knownRecipes, context, options, 'occupation'), done: false, value: null,
        stage: 0, units: 0 };
}
function createAction(state, knownRecipes, context, options = {}) {
    return { iterator: decisionSearch(state, knownRecipes, context, options, 'action'), done: false,
        value: null, stage: 0, units: 0, mode: 'action' };
}
function stepOccupation(cursor) {
    if (cursor.done) return true;
    const next = cursor.iterator.next(); cursor.units++;
    cursor.stage = typeof next.value === 'object' ? Number(next.value?.stage || 0)
        : ['stock', 'recipe', 'ingredient', 'owned', 'quote', 'trip', 'exit', 'without', 'success',
            'utility', 'candidate', 'funding', 'exits'].indexOf(next.value) + 1;
    if (next.done) { cursor.done = true; cursor.value = cursor.mode === 'action' ? next.value : occupationResult(next.value);
        if (next.value?.valueHours !== undefined) cursor.selectedValueHours = next.value.valueHours;
        cursor.iterator = null; }
    return cursor.done;
}
function resultOccupation(cursor) { return cursor.done ? cursor.value : { known: false, recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN }; }
function resultAction(cursor) { return cursor.done ? cursor.value : null; }
function chooseOccupation(state, knownRecipes, context, options = {}) {
    const cursor = createOccupation(state, knownRecipes, context, options);
    while (!stepOccupation(cursor)) { /* worker synchronous test adapter */ }
    return resultOccupation(cursor);
}
// The same finite route value also decides whether consuming/acquiring the
// physical scroll beats sale/holding/clan alternatives. No lifetime multiplier.
function recipePaths(state, recipe, { known = false, route = null, acquisition = null,
    sale = null, clan = null, commission = null, ownUse = null, context = {} } = {}) {
    const moneyPrice = Number(context.moneyPrice ?? (context.hourAdena > 0 ? 1 / context.hourAdena : NaN));
    const rows = [{ kind: 'hold', valueHours: 0, cashNow: 0, available: true }];
    const owned = Number(state.inventory?.[recipe.recipeItemId]?.amount || 0) > 0;
    const evaluate = (kind, outcome, extras = {}) => {
        const value = Valuation.opportunity({ ...context, moneyPrice }, [{ probability: 1, ...outcome }]);
        if (value.known) rows.push({ kind, valueHours: value.valueHours, cashNow: value.cashNow, available: true, ...extras });
    };
    if (owned && sale?.available !== false && Number(sale?.price) > 0) evaluate('sale', {
        receipts: Number(sale.price), ownInputOpportunityValue: Number(sale.price),
        foregoneBenefitHours: Number(sale.hours || 0), actualCashFees: Number(sale.fees || 0) });
    if (owned && clan?.available === true && Number(clan.valueHours) > 0) evaluate('clan', {
        ownBenefitHours: Number(clan.valueHours), ownInputOpportunityValue: Number(sale?.price
            || context.independentPrice?.(recipe.recipeItemId) || 0),
        foregoneBenefitHours: Number(clan.hours || 0) }, { target: clan.target });
    const value = Number(route?.valueHours ?? ownUse?.valueHours);
    if (Number.isFinite(value) && value > 0 && CraftShopService.canCraft(state, recipe)) {
        const acquireCash = known || owned ? 0 : Number(acquisition?.cashNow ?? acquisition?.price);
        const acquisitionHours = known || owned ? 0 : Number(acquisition?.hours || 0);
        const cash = Number(route?.basket?.cashCost || 0) + acquireCash;
        const scrollValue = !known && owned ? Number(sale?.price || context.independentPrice?.(recipe.recipeItemId) || 0) : 0;
        if ((known || owned || acquisition?.available === true) && Number.isFinite(acquireCash) && acquireCash >= 0
            && cash <= PurchaseFunding.spendable(state, 0, { valueHours: value })) {
            evaluate(known ? 'use' : owned ? 'learn' : 'acquire', { ownBenefitHours: value,
                cashNow: acquireCash, ownInputOpportunityValue: scrollValue,
                foregoneBenefitHours: acquisitionHours + Number(context.learningHours || 0) }, { recipeId: recipe.recipeId, route });
        }
    }
    if (commission?.available === true && commission.contract) evaluate('commission', commission.outcome || {}, { contract: commission.contract });
    let best = rows[0];
    for (const row of rows) if (row.valueHours > best.valueHours
        || row.kind === 'sale' && row.valueHours === best.valueHours) best = row;
    return { known: Number.isFinite(moneyPrice), rows, best, recipeId: Number(recipe.recipeId) };
}
module.exports = { staticExits, exitsFor, eligible, chooseOpportunity, chooseOccupation,
    createOccupation, stepOccupation, resultOccupation, createAction, stepAction: stepOccupation,
    resultAction, recipePaths, freeAmount };
