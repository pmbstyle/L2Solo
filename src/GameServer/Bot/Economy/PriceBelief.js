// A fresh price estimate from the indexed board, with a stable personal
// error for (bot, item). There is no saved per-item price book: observations
// belong to the author's open board line, and own experience to a counter.
const TendencyRoll = require('../AI/TendencyRoll');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceLearning = invoke('GameServer/Bot/Economy/PriceLearning');
const Diagnostics = require('./EconomyDiagnostics');
// One scalar mixture per item: no owner, state, wallet or offer references.
const MIXTURE_LIMIT = 1024;
const mixtures = new Map();

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

// ARCH-NOTE: the previous one-hour, item-only cache inferred willingness
// from every recipe with NPC/first-price inputs and no owner, finite exit,
// labour, funding or source identity. A completed prepared owner calculation
// may supply its scalar ceiling; absent preparation is unknown, not a second
// recipe search or speculative prior. Derived usefulness is not a trade.
function demandValue(selfId, context = {}) {
    const source = context?.derivedDemandValue;
    const prepared = typeof source === 'function' ? source(Number(selfId))
        : source instanceof Map ? source.get(Number(selfId)) : source;
    const declared = prepared && typeof prepared === 'object'
        ? prepared.known === true && prepared.supported !== false
        : context?.derivedDemandSupported === true;
    const value = Number(prepared && typeof prepared === 'object' ? prepared.value : prepared);
    if (!declared || !(value > 0) || !Number.isFinite(value)) return null;
    if (prepared && typeof prepared === 'object' && prepared.ownerId !== undefined
        && Number(prepared.ownerId) !== Number(context.characterId)) return null;
    return value;
}

// Public source weights stay unchanged; every choice reads them again.
// bias is a signed fractional error, so the log centre gains log(1 + bias).
function prior(selfId, ctx) {
    const id = Number(selfId);
    const deals = MarketCounters.itemPriceEvidence(id);
    // Always re-read permitted sources and the owner's excluded offers. Only
    // their pure numeric combination is reusable, never a spending decision.
    const ask = ctx.board?.first(id, SELL, { excludeOwner: ctx.characterId, enchant: 0 });
    const bid = ctx.board?.first(id, BUY, { excludeOwner: ctx.characterId, enchant: 0 });
    const first = MarketCounters.firstPrice(id, ctx.timestamp);
    const index = counterIndex(id, ctx.timestamp);
    const demand = demandValue(id, ctx);
    const inputs = [deals.logMedian, Math.min(DEALS_WEIGHT_MAX, deals.deals),
        ask?.price > 0 ? Number(ask.price) : 0, bid?.price > 0 ? Number(bid.price) : 0,
        first, index, demand];
    let mixture = mixtures.get(id);
    if (!mixture || !inputs.every((value, at) => Object.is(value, mixture.inputs[at]))) {
        const observations = [];
        if (deals.logMedian !== null) observations.push([deals.logMedian, inputs[1]]);
        if (inputs[2] > 0) observations.push([Math.log(inputs[2]), 1]);
        if (inputs[3] > 0) observations.push([Math.log(inputs[3]), 1]);
        if (first > 0 && index !== null) observations.push([Math.log(first) + index, 0.5]);
        if (demand > 0) observations.push([Math.log(demand), 0.3]);
        if (first > 0) observations.push([Math.log(first), 0.3]);
        let weight = 0, sum = 0;
        for (const [value, w] of observations) { weight += w; sum += value * w; }
        mixture = { inputs, mu: sum / weight, K: weight, known: observations.length > 0 };
        mixtures.delete(id); mixtures.set(id, mixture);
        if (mixtures.size > MIXTURE_LIMIT) mixtures.delete(mixtures.keys().next().value);
        if (Diagnostics.active()) Diagnostics.count('price_mixture', 'build', 'sources_changed');
    } else {
        mixtures.delete(id); mixtures.set(id, mixture);
        if (Diagnostics.active()) Diagnostics.count('price_mixture', 'hit', 'same_sources');
    }
    if (!mixture.known) return null;
    const counter = MarketCounters.counterOf(id);
    const enabled = ctx.knowledgeEnabled ?? PriceLearning.knowledgeEnabled();
    const experience = Math.max(0, Number(ctx.marketTrades?.[counter]) || 0);
    const bias = enabled
        ? (2 * TendencyRoll.roll('n45e', ctx.characterId, id) - 1) * errorOf(ctx.understanding, experience, counter)
        : 0;
    return { selfId: id, mu: mixture.mu + Math.log1p(bias), K: mixture.K, bias };
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
    mixtures.clear();
}

module.exports = { S0, K_MAX, sigma, errorOf, prior, learn, lineObservations, demandValue, resetCaches };
