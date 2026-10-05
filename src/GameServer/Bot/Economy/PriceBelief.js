// A bot's belief of what an item fetches (group E, N45, N50; market-sim step
// 3.3, tools/market-sim/n0/step33/groupE: e10 belief, e15 rival, e4b memory):
// a log-normal of what a buyer pays, its centre mu (log Adena) and its weight
// K, the evidence behind it; its width is S0 / sqrt(1 + K). One module for the
// main thread and the cold worker: it reads the board index, the market
// counters and the first prices the caller's thread has.
//
// Prior, when the bot first weighs an item: the board's evidence, each with
// its weight: the item's last deals (their median, weight up to 10), the best
// competing ask (1), the best buy ad (1), the market index of its counter x
// its first price (0.5), what a crafter could pay for it (0.3) and its first
// price (0.3); read once with the bot's understanding error, which halves
// every 3 own deals of the item.
// Learning at the bot's own look (MarketPricing.look): its sales say buyers pay at
// least its ask, the buyers of its counter that passed say less, new deals of
// the item are prices, and the rival's current ask counts by the bot's
// understanding when it changed.
// Memory without a size: a belief fades with the bot's own touches of other
// items and with its counter's index drifting since it learned; read lazily,
// it is dropped when it falls to the public prior. 48 at most, a bound only.
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const TendencyRoll = require('../AI/TendencyRoll');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const DataCache = invoke('GameServer/DataCache');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');

const S0 = 0.6;
const K_MAX = 60;
const FADE = 0.02;
const DRIFT = 0.1;
const DROP = 0.25;
const BOUND = 48;
const RIVAL_CHANGE = 0.005;
const PASSED_MAX = 10;
const DEALS_WEIGHT_MAX = 10;
const HALVING_DEALS = 3;

// Stored compactly in stats.priceBeliefs: { t: own touches, at: last look,
// n: looks, b: [[selfId, mu, K, confidence, tick, index, bias, own deals,
// ask, rival, item deals seen, counter deals seen]] }.
function readBook(stats) {
    const stored = stats?.priceBeliefs;
    const beliefs = new Map();
    for (const row of stored?.b || []) {
        beliefs.set(Number(row[0]), {
            selfId: Number(row[0]), mu: row[1], K: row[2], c: row[3], tick: row[4], index: row[5], bias: row[6],
            deals: row[7], ask: row[8], rival: row[9], seenItem: row[10], seenCounter: row[11]
        });
    }
    return { tick: Number(stored?.t || 0), lookAt: Number(stored?.at || 0), looks: Number(stored?.n || 0), beliefs };
}

const round = (value, places) => Math.round(Number(value) * places) / places;
function writeBook(book) {
    if (!book.beliefs.size && !book.lookAt) return null;
    return { t: book.tick, at: book.lookAt, n: book.looks, b: [...book.beliefs.values()].map((belief) => [
        belief.selfId, round(belief.mu, 1e4), round(belief.K, 100), round(belief.c, 1e3), belief.tick,
        belief.index === null ? null : round(belief.index, 1e4), round(belief.bias, 1e4), belief.deals, Math.round(belief.ask || 0),
        Math.round(belief.rival || 0), belief.seenItem, belief.seenCounter]) };
}

function sigma(belief) {
    return S0 / Math.sqrt(1 + belief.K);
}

// The error of the bot's price guess: 3% for an analyst, 20% for a novice,
// halved every 3 own deals of the item.
function errorOf(understanding, deals = 0) {
    return (0.03 + 0.17 * (1 - Math.max(0, Math.min(1, Number(understanding) || 0)))) * 0.5 ** (deals / HALVING_DEALS);
}

function counterIndex(selfId, timestamp) {
    return MarketCounters.counter(MarketCounters.counterOf(selfId), timestamp).index;
}

// What is left of a belief's confidence now: it fades by (1 - f) per own
// touch of another item since its last touch (f = 0.02 x (1 - 0.6 x
// understanding)) and by its counter's index drift since then.
function confidence(book, belief, ctx) {
    const fade = FADE * (1 - 0.6 * Math.max(0, Math.min(1, Number(ctx.understanding) || 0)));
    const index = counterIndex(belief.selfId, ctx.timestamp);
    const drift = index === null || belief.index === null ? 0 : Math.abs(index - belief.index);
    return belief.c * (1 - fade) ** Math.max(0, book.tick - belief.tick) * Math.exp(-drift / DRIFT);
}

// The belief the bot still holds, or null (a faded one is dropped).
function lookup(book, selfId, ctx) {
    const belief = book.beliefs.get(Number(selfId));
    if (!belief) return null;
    if (confidence(book, belief, ctx) >= DROP) return belief;
    book.beliefs.delete(Number(selfId));
    return null;
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

// The board's evidence on an item, read once with the bot's error: { mu, K,
// bias } (log Adena), null when nothing prices it.
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
    const bias = (2 * TendencyRoll.roll('n45e', ctx.characterId, id) - 1) * errorOf(ctx.understanding, 0);
    return { mu: sum / weight + bias, K: weight, bias };
}

// A touch of the bot's own (a listing, a sale): every other belief fades by one.
function touch(book, belief, ctx, count = 1) {
    belief.c = confidence(book, belief, ctx) + count;
    book.tick += count;
    belief.tick = book.tick;
    belief.index = counterIndex(belief.selfId, ctx.timestamp);
}

// A new belief from the prior, not yet kept: null when nothing prices it.
function fresh(book, selfId, ctx) {
    const id = Number(selfId);
    const start = prior(id, ctx);
    if (!start) return null;
    const counter = MarketCounters.counter(MarketCounters.counterOf(id), ctx.timestamp);
    return { selfId: id, mu: start.mu, K: start.K, c: 0, tick: book.tick, index: null, bias: start.bias,
        deals: 0, ask: 0, rival: 0, seenItem: MarketCounters.itemDeals(id).deals, seenCounter: counter.deals };
}

// The bot's belief of an item: the one it holds, else a new one from the
// prior, kept.
function ensure(book, selfId, ctx) {
    const held = lookup(book, selfId, ctx);
    if (held) return held;
    const belief = fresh(book, selfId, ctx);
    return belief ? keep(book, belief, ctx) : null;
}

// Keeps a new belief (a touch of the bot's own); the bound drops the
// faintest other one.
function keep(book, belief, ctx) {
    book.beliefs.set(belief.selfId, belief);
    touch(book, belief, ctx);
    if (book.beliefs.size > BOUND) {
        let faintest = null;
        let lowest = Infinity;
        for (const other of book.beliefs.values()) {
            if (other === belief) continue;
            const value = confidence(book, other, ctx);
            if (value < lowest) { lowest = value; faintest = other; }
        }
        if (faintest) book.beliefs.delete(faintest.selfId);
    }
    return belief;
}

// observations: [[log price, weight]]: the centre moves to the weighted mean.
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

// Own deals of the item: the error read into the prior halves every 3.
function ownDeals(belief, count) {
    if (!(count > 0)) return;
    const keep = 0.5 ** (count / HALVING_DEALS);
    belief.mu -= belief.bias * (1 - keep);
    belief.bias *= keep;
    belief.deals += count;
}

// What the bot learns at a look at its line of the item (asking `ask`):
// returns { observations, sales } and marks what it has now seen.
// lines: the open sell lines of the item's counter on the board.
function lookObservations(book, belief, ctx, { ask, lines }) {
    const id = belief.selfId;
    const observations = [];
    const item = MarketCounters.itemDeals(id);
    const fresh = Math.min(item.prices.length, Math.max(0, item.deals - belief.seenItem));
    let sales = 0;
    for (let at = item.prices.length - fresh; at < item.prices.length; at++) {
        if (Number(item.sellers[at]) === Number(ctx.characterId)) sales += 1;
        else observations.push([Math.log(item.prices[at]), 1]);
    }
    const counter = MarketCounters.counter(MarketCounters.counterOf(id), ctx.timestamp);
    const width = sigma(belief);
    if (ask > 0 && sales) observations.push([Math.log(ask) + 0.5 * width, sales]);
    const passed = Math.min(PASSED_MAX, Math.max(0, counter.deals - belief.seenCounter) / Math.max(1, lines) - sales);
    if (ask > 0 && passed > 0) observations.push([Math.log(ask) - 0.5 * width, passed]);
    const rival = ctx.board?.first(id, SELL, { excludeOwner: ctx.characterId, enchant: 0 })?.price || 0;
    if (rival > 0 && !(belief.rival > 0 && Math.abs(rival / belief.rival - 1) <= RIVAL_CHANGE)) {
        observations.push([Math.log(rival), 0.5 * Math.max(0.05, Number(ctx.understanding) || 0)]);
    }
    belief.rival = rival;
    belief.seenItem = item.deals;
    belief.seenCounter = counter.deals;
    return { observations, sales };
}

function resetCaches() {
    demandCache.clear();
    recipesByMaterial = null;
}

module.exports = { S0, K_MAX, DROP, BOUND, FADE, readBook, writeBook, sigma, errorOf, confidence, lookup, prior, fresh,
    ensure, keep, touch, learn, ownDeals, lookObservations, demandValue, resetCaches };
