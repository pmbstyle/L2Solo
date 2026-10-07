// Wealth craft choice is shared; all monetary/physical writes stay on main.
const Policy = require('./WealthCraftPolicy');
const Profit = require('./CraftProfitPolicy');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const StaticMerchantPricing = require('./StaticMerchantPricing');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const PurchaseFunding = require('./PurchaseFunding');
const Karma = require('../../Karma');
function staticExits(recipe, template) {
    if (require('./ProductionPolicy').buyersDisabled()
        || !String(template?.template?.kind || '').startsWith('Other.Material')) return [];
    return Object.entries(MerchantStoreConfigs).flatMap(([name, store]) => {
        if (Number(store?.storeType) !== 3 || !store.town) return [];
        const line = (store.items || []).find(item => Number(item.selfId) === Number(recipe.productId));
        const price = line ? StaticMerchantPricing.botPriceFor(store, line) : 0;
        return Number.isFinite(price) && price > 0
            ? [{ type: 'static', price, count: Number(recipe.productCount), town: store.town, buyerName: name }] : [];
    });
}
function exitsFor(state, recipe, template, trip, options) {
    const dynamic = options.offersFor(recipe.productId, 3, state.characterId)
        .map(offer => ({ type: 'afk', price: Number(offer.price), count: Number(offer.count), offer, trip: trip(offer.town) }));
    return [...dynamic, ...(options.staticExits || staticExits)(recipe, template)].sort((a, b) => b.price - a.price);
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
function chooseOpportunity(state, knownRecipes, context = Profit.contextFor(state), options = {}) {
    let best = null;
    // An active market gear plan keeps what its purchase needs (price and
    // reserve): inputs are bought only with the rest of the wallet. A bot
    // with its own buy order does not craft at all (eligible), so no escrow.
    const budgetState = { ...state, adena: PurchaseFunding.spendable(state, 0, { upperBound: true }) };
    // Each input is one purchase in the town where it costs the least with
    // the trip (the one purchase path): its landed price is the input's cost.
    const trip = Profit.tripFor(state, context);
    const planCache = new Map();
    const stock = context.insideContext ? Object.values(state.inventory || {}).map(item => {
        const reserve = Math.max(Number(state.stats?.clanMaterialDemand?.[item.selfId] || 0),
            state.stats?.equipmentPlan?.status === 'active' && Number(state.stats.equipmentPlan.target?.selfId) === Number(item.selfId) ? 1 : 0);
        return { ...item, count: Math.max(0, Number(item.amount || 0) - Number(item.equippedCount || (item.equipped ? 1 : 0)) - reserve),
            price: Number(context.worth?.(Number(item.selfId)) || 0) };
    }) : ItemDisposition.saleCandidates(state, { unlimited: true });
    const ownStock = new Map(stock.map(item => [Number(item.selfId), item]));
    const ownValueCache = new Map();
    const planFor = (selfId, missing) => {
        const key = `${selfId}:${missing}`;
        if (!planCache.has(key)) planCache.set(key, options.planPurchase(state, selfId, missing, { npc: false, cost: trip }));
        return planCache.get(key);
    };
    const ownedFor = (selfId) => {
        const stock = ownStock.get(Number(selfId));
        if (!stock || Number(stock.count || 0) <= 0) return null;
        if (!ownValueCache.has(selfId)) {
            const fixedBids = (options.staticExits || staticExits)({ productId: selfId, productCount: 1 },
                ItemTemplateIndex.find(DataCache.items, selfId));
            // A buy ad is worth its price less the trip to answer it.
            const dynamicBids = options.offersFor(selfId, 3, state.characterId);
            ownValueCache.set(selfId, Math.max(Number(stock.price || 0),
                ...fixedBids.map((bid) => Number(bid.price || 0)),
                ...dynamicBids.map((bid) => Number(bid.price || 0)
                    - trip(bid.town) / Math.max(1, Math.min(Number(stock.count), Number(bid.count) || 1)))));
        }
        return { count: Number(stock.count), unitValue: ownValueCache.get(selfId) };
    };
    for (const known of knownRecipes || []) {
        const recipe = Recipes.resolveByRecipeId(known.recipeId);
        if (!recipe || recipe.type !== 'dwarven' || !CraftShopService.canCraft(state, recipe)) continue;
        const template = ItemTemplateIndex.find(DataCache.items, recipe.productId);
        if (!template || !recipe.materials?.length) continue;
        const exits = exitsFor(state, recipe, template, trip, options);
        if (!exits.length) continue;
        const candidate = Policy.opportunityFor(budgetState, recipe, planFor, exits, ownedFor, context);
        const cash = candidate?.basket?.cashCost || 0;
        const r = cash > 0 ? candidate.expectedProfit / context.hourAdena / cash : Infinity;
        if (candidate && cash <= PurchaseFunding.spendable(state, 0, { r })
            && (!best || candidate.expectedProfit > best.expectedProfit)) {
            best = { ...candidate, template, r };
        }
    }
    return best;
}

module.exports = { staticExits, exitsFor, eligible, chooseOpportunity };
