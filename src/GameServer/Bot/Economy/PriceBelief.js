// A fresh price estimate from the indexed board, with a stable personal
// error for (bot, item). There is no saved per-item price book: observations
// belong to the author's open board line, and own experience to a counter.
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const TendencyRoll = require('../AI/TendencyRoll');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const DataCache = invoke('GameServer/DataCache');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceLearning = invoke('GameServer/Bot/Economy/PriceLearning');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');

const S0 = 0.6;
const K_MAX = 60;
const PASSED_MAX = 10;
const DEALS_WEIGHT_MAX = 10;
const errorOf = PriceLearning.errorOf;

function sigma(belief) {
    return S0 / Math.sqrt(1 + belief.K);
}

function counterIndex(selfId, timestamp) {
    return MarketCounters.counter(MarketCounters.counterOf(selfId), timestamp).index;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function template(selfId) {
    return ItemTemplateIndex.find(DataCache.items, Number(selfId)) || null;
}

// What a crafter could pay: for a material, the most one unit is worth in a
// recipe that uses it (the margin with the other materials at their supply
// cost, per unit of it); for a recipe, the margin of one craft. The author's
// margin form (WealthCraftPolicy.craftMargin); kept an hour like the first
// price. null when no recipe pays.
let recipesByMaterial = null;
const demandCache = new Map();
const DEMAND_CACHE_MS = 60 * 60 * 1000;
function demandValue(selfId, timestamp = Date.now()) {
    const id = Number(selfId);
    const kept = demandCache.get(id);
    if (kept && timestamp - kept.at < DEMAND_CACHE_MS && timestamp >= kept.at) return kept.value;
    const WealthCraftPolicy = invoke('GameServer/Bot/Economy/WealthCraftPolicy');
    if (!recipesByMaterial) {
        recipesByMaterial = new Map();
        for (const recipe of Object.values(C4RecipeItems.loadRecipeItems())) {
            if (recipe.type !== 'dwarven') continue;
            for (const material of recipe.materials || []) {
                const key = Number(material.selfId);
                if (!recipesByMaterial.has(key)) recipesByMaterial.set(key, []);
                recipesByMaterial.get(key).push(recipe);
            }
        }
    }
    const basketWithout = (recipe, skip) => {
        let cost = 0;
        for (const material of recipe.materials || []) {
            if (Number(material.selfId) === skip) continue;
            const unit = supplyCost(material.selfId, timestamp);
            if (!(unit > 0)) return null;
            cost += unit * Number(material.amount || 0);
        }
        return cost;
    };
    let value = null;
    const ownRecipe = C4RecipeItems.resolve(id);
    if (ownRecipe && ownRecipe.type === 'dwarven' && String(template(id)?.template?.kind || '').startsWith('Other.Recipe')) {
        const product = productValue(ownRecipe.productId, timestamp);
        const basket = basketWithout(ownRecipe, 0);
        if (product > 0 && basket !== null) value = WealthCraftPolicy.craftMargin(ownRecipe, product, basket);
    }
    for (const recipe of recipesByMaterial.get(id) || []) {
        const product = productValue(recipe.productId, timestamp);
        const others = basketWithout(recipe, id);
        const amount = (recipe.materials.find((material) => Number(material.selfId) === id)?.amount) || 0;
        if (!(product > 0) || others === null || !(amount > 0)) continue;
        const unit = WealthCraftPolicy.craftMargin(recipe, product, others) / amount;
        if (value === null || unit > value) value = unit;
    }
    value = value > 0 ? value : null;
    demandCache.set(id, { at: timestamp, value });
    return value;
}

function npcPrice(selfId) {
    const price = invoke('GameServer/Bot/Economy/BotMarketPricing').npcPrice({ selfId });
    return Number.isFinite(price) ? price : null;
}

// What an input costs a crafter: the NPC price, else its first price.
function supplyCost(selfId, timestamp) {
    return npcPrice(selfId) ?? MarketCounters.firstPrice(selfId, timestamp);
}

// What a product fetches: its deals, else the NPC price, else its first
// price x its counter's index.
function productValue(selfId, timestamp) {
    const deals = MarketCounters.itemDeals(selfId).prices;
    if (deals.length) return median(deals);
    const npc = npcPrice(selfId);
    if (npc !== null) return npc;
    const first = MarketCounters.firstPrice(selfId, timestamp);
    const index = counterIndex(selfId, timestamp);
    return first > 0 ? first * Math.exp(index ?? 0) : null;
}

// Public source weights stay unchanged; every choice reads them again.
// bias is a signed fractional error, so the log centre gains log(1 + bias).
function prior(selfId, ctx) {
    const id = Number(selfId);
    const observations = [];
    const deals = MarketCounters.itemDeals(id);
    if (deals.prices.length) observations.push([Math.log(median(deals.prices)), Math.min(DEALS_WEIGHT_MAX, deals.deals)]);
    const ask = ctx.board?.first(id, SELL, { excludeOwner: ctx.characterId, enchant: 0 });
    if (ask?.price > 0) observations.push([Math.log(ask.price), 1]);
    const bid = ctx.board?.first(id, BUY, { excludeOwner: ctx.characterId, enchant: 0 });
    if (bid?.price > 0) observations.push([Math.log(bid.price), 1]);
    const first = MarketCounters.firstPrice(id, ctx.timestamp);
    const index = counterIndex(id, ctx.timestamp);
    if (first > 0 && index !== null) observations.push([Math.log(first) + index, 0.5]);
    const demand = demandValue(id, ctx.timestamp);
    if (demand > 0) observations.push([Math.log(demand), 0.3]);
    if (first > 0) observations.push([Math.log(first), 0.3]);
    if (!observations.length) return null;
    let weight = 0;
    let sum = 0;
    for (const [value, w] of observations) {
        weight += w;
        sum += value * w;
    }
    const counter = MarketCounters.counterOf(id);
    const enabled = ctx.knowledgeEnabled ?? PriceLearning.knowledgeEnabled();
    const experience = Math.max(0, Number(ctx.marketTrades?.[counter]) || 0);
    const bias = enabled
        ? (2 * TendencyRoll.roll('n45e', ctx.characterId, id) - 1) * errorOf(ctx.understanding, experience, counter)
        : 0;
    return { selfId: id, mu: sum / weight + Math.log1p(bias), K: weight, bias };
}

// Current line observations add weight to the fresh estimate, never to a
// persistent centre. Closing the line discards all its observation state.
function learn(belief, observations) {
    let weight = 0;
    let sum = 0;
    for (const [value, w] of observations) {
        if (!(w > 0) || !Number.isFinite(value)) continue;
        weight += w;
        sum += value * w;
    }
    if (!(weight > 0)) return false;
    belief.mu = (belief.K * belief.mu + sum) / (belief.K + weight);
    belief.K = Math.min(K_MAX, belief.K + weight);
    return true;
}

// Exact own fills belong to this line, not the bounded item-deal tail.
// Other item deals and the current rival already enter the fresh prior.
// Every other deal of its counter passed this line; competing listings do
// not divide that evidence.
function lineObservations(line, belief, ctx) {
    const previous = line.pricing;
    const counter = MarketCounters.counter(MarketCounters.counterOf(line.selfId), ctx.timestamp);
    const fills = Math.max(0, Number(line.fills || 0) - Number(previous.seenFills || 0));
    // A bid nobody took, seen on a town look, passed once even with no deal on
    // the board (nobody sells), like a deal that went to someone else.
    const unanswered = ctx.visit && line.storeType === BUY && fills === 0 ? 1 : 0;
    const passed = Math.min(PASSED_MAX, Math.max(unanswered,
        counter.deals - previous.seenCounter - fills));
    const price = Number(previous.price);
    const observations = [];
    if (price > 0) {
        const direction = line.storeType === BUY ? -1 : 1;
        const width = sigma(belief);
        if (fills > 0) observations.push([Math.log(price) + direction * 0.5 * width, fills]);
        if (passed > 0) observations.push([Math.log(price) - direction * 0.5 * width, passed]);
    }
    return observations;
}

function resetCaches() {
    demandCache.clear();
    recipesByMaterial = null;
}

module.exports = { S0, K_MAX, sigma, errorOf, prior, learn, lineObservations, demandValue, resetCaches };
