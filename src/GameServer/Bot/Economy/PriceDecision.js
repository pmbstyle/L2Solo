// One pricing decision for selling and buying (group E, user 2026-10-05;
// market-sim step 3.3, tools/market-sim/n0/step33/groupE: e10 belief, e12
// loss, e13 competition): the best expected outcome over a grid of prices on
// the bot's belief (PriceBelief), one roll among the near-best ones. One
// module for the main thread and the cold worker.
//
// Selling at p: a buyer comes at the item's arrival rate, wants it at p with
// the chance the belief gives (S), and takes it if p plus his trip looks best
// to him among the offers he sees (the cheapest rivals of the board, the NPC
// shop at its price plus his trip), through the buyers' perception width;
// units of rivals cheaper than p sell first. The value of p is its utility
// discounted by the expected wait at the value of money. The NPC buy-back now
// is the outside option. Traits are parameters only: assertiveness is the
// optimism of the centre, caution the loss aversion against the bot's own
// value (a sale below it is a loss weighted 1 + caution; waiting is no loss,
// only a delay), commitment the patience on the discount. Buying mirrors it.
const TendencyRoll = require('../AI/TendencyRoll');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const { SELL } = require('../../AfkTrade/BoardIndex');
const DataCache = invoke('GameServer/DataCache');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');

// 19 prices from 2 widths under the centre to 2.5 over it.
const GRID = Object.freeze(Array.from({ length: 19 }, (_, at) => -2 + at * 0.25));
const NEAR_BEST = 0.02;
// How differently buyers see the same offers (e13: their understanding error).
const PERCEPTION = 0.08;
const RIVALS_SEEN = 20;
const MONEY_BASE_PER_HOUR = 0.02;
const MONEY_NEED_PER_HOUR = 0.05;

// The value of money per hour until step 3.5 prices money: a base rate plus
// the bot's need (its hour against its Adena).
function valueOfMoney(hour, adena) {
    const earning = Math.max(0, Number(hour) || 0);
    const held = Math.max(0, Number(adena) || 0);
    if (!(earning + held > 0)) return MONEY_BASE_PER_HOUR + MONEY_NEED_PER_HOUR;
    return MONEY_BASE_PER_HOUR + MONEY_NEED_PER_HOUR * earning / (held + earning);
}

// The trader's parameters from its persona and its state.
function traderOf(persona, { hour, adena }) {
    const traits = persona?.traits || {};
    const commitment = Number(traits.commitment ?? 0.5);
    return {
        wait: valueOfMoney(hour, adena) * (1.5 - commitment),
        assertiveness: Number(traits.assertiveness ?? 0.5),
        caution: Number(traits.caution ?? 0.5),
        understanding: Number(persona?.understanding ?? 0.3)
    };
}

// Standard normal distribution function (Abramowitz and Stegun 7.1.26).
function phi(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const tail = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
        * t * Math.exp(-z * z / 2);
    return z >= 0 ? 1 - tail / 2 : tail / 2;
}

// A sale below the bot's own value is a loss weighted 1 + caution.
function saleUtility(price, reference, caution) {
    return price >= reference ? price : reference + (1 + caution) * (price - reference);
}
// A purchase above it is a loss the same way.
function purchaseCost(price, reference, caution) {
    return price <= reference ? price : reference + (1 + caution) * (price - reference);
}

function buyback(selfId) {
    const item = ItemTemplateIndex.find(DataCache.items, Number(selfId));
    return NpcSellRules.npcBuyPrice(Number(item?.template?.price || 0));
}

// Buyers per open line of a counter with no deals yet: half the lowest of
// its kind that has some (a later grade of the world, e8).
function priorPerLine(key, board, timestamp) {
    const kind = key.split(' ')[0];
    let lowest = Infinity;
    for (const other of MarketCounters.COUNTER_KEYS) {
        if (!other.startsWith(`${kind} `) || other === key) continue;
        const perHour = MarketCounters.counter(other, timestamp).perHour;
        if (perHour > 0) lowest = Math.min(lowest, perHour / Math.max(1, board?.linesIn(other) || 0));
    }
    return Number.isFinite(lowest) ? lowest / 2 : 0;
}

// What the seller of `units` of an item in `town` competes with: { buyback,
// buyersPerHour, lot, rivals [{ landed, units }], npcLanded, ownTrip }.
// tripCost(town): a buyer's trip there in Adena (OfferOrder.tripCost of the
// trader); npcOffers: the NPC shops selling the item ({ price, town }).
function marketFor(selfId, { board = null, ownerId = 0, town = null, units = 1, tripCost = null,
    npcOffers = [], timestamp = Date.now() } = {}) {
    const id = Number(selfId);
    const trip = (where) => (tripCost ? Math.min(Number(tripCost(where)) || 0, Number.MAX_SAFE_INTEGER) : 0);
    const key = MarketCounters.counterOf(id);
    const counter = MarketCounters.counter(key, timestamp);
    let perLine = counter.perHour / Math.max(1, board?.linesIn(key) || 0);
    if (!(perLine > 0)) perLine = priorPerLine(key, board, timestamp);
    const rivals = [];
    let others = 0;
    for (const line of board ? board.list(id, SELL) : []) {
        if (line.ownerId === Number(ownerId) || line.enchant) continue;
        others += 1;
        if (rivals.length < RIVALS_SEEN) rivals.push({ landed: line.price + trip(line.town), units: line.count });
    }
    let npcLanded = Infinity;
    for (const offer of npcOffers || []) {
        if (offer?.price > 0) npcLanded = Math.min(npcLanded, Number(offer.price) + trip(offer.town));
    }
    return {
        buyback: buyback(id),
        buyersPerHour: perLine * (others + 1),
        lot: Math.max(1, MarketCounters.itemDeals(id).units || 1),
        units: Math.max(1, Number(units) || 1),
        rivals,
        npcLanded,
        ownTrip: trip(town)
    };
}

// The near-best roll: options within 2% of the best value share one roll by
// how far above that line they are.
function nearBest(candidates, rollKey) {
    let best = -Infinity;
    for (const candidate of candidates) best = Math.max(best, candidate.value);
    const floor = best - NEAR_BEST * Math.abs(best);
    const near = candidates.filter((candidate) => candidate.value >= floor);
    let total = 0;
    for (const candidate of near) total += candidate.value - floor + 1e-9;
    let left = TendencyRoll.roll(...rollKey) * total;
    for (const candidate of near) {
        left -= candidate.value - floor + 1e-9;
        if (left <= 0) return candidate;
    }
    return near[near.length - 1];
}

// The ask: { price, value, money, npc } with npc true when the NPC buy-back
// now is worth more than any ask (price is then the buy-back). value is the
// bot's utility per unit, money the Adena per unit discounted by the wait.
function chooseAsk(belief, market, trader, rollKey) {
    const width = PriceBelief.sigma(belief);
    const reference = Math.exp(belief.mu);
    const centre = belief.mu + (trader.assertiveness - 0.5) * width;
    let alternative = market.npcLanded;
    for (const rival of market.rivals) alternative = Math.min(alternative, rival.landed);
    const deals = Math.ceil(market.units / market.lot);
    const candidates = [];
    for (const z of GRID) {
        const price = Math.max(1, Math.round(Math.exp(belief.mu + z * width)));
        if (price <= market.buyback || candidates.some((candidate) => candidate.price === price)) continue;
        const wants = 1 - phi((Math.log(price) - centre) / width);
        const landed = price + market.ownTrip;
        const chosen = Number.isFinite(alternative) ? 1 - phi(Math.log(landed / alternative) / PERCEPTION) : 1;
        const rate = market.buyersPerHour * wants * Math.max(0.01, chosen);
        if (!(rate > 0)) continue;
        let ahead = 0;
        for (const rival of market.rivals) if (rival.landed < landed) ahead += rival.units;
        const wait = (deals + 1) / 2 / rate + ahead / (market.lot * market.buyersPerHour);
        const discount = Math.exp(-trader.wait * wait);
        candidates.push({ price, value: saleUtility(price, reference, trader.caution) * discount, money: price * discount });
    }
    const npcValue = saleUtility(market.buyback, reference, trader.caution);
    const best = candidates.length ? nearBest(candidates, rollKey) : null;
    if (!best || Math.max(...candidates.map((candidate) => candidate.value)) <= npcValue) {
        return { price: market.buyback, value: npcValue, money: market.buyback, npc: true, npcValue };
    }
    return { price: best.price, value: best.value, money: best.money, npc: false, npcValue };
}

// The bid of a buy ad: { price, value } or null when no bid gains anything.
// worth: what the item is worth to the buyer (its plan's price); cap: the
// most it may pay a unit. Sellers come at the same rate as buyers; a seller
// takes q with the chance the belief gives that he asks no more. Before the
// board shows any seller of the kind, the wait is unknown: a bid is worth its
// gain by that chance alone.
function chooseBid(belief, market, trader, { worth, cap }, rollKey) {
    const width = PriceBelief.sigma(belief);
    const reference = Math.exp(belief.mu);
    const centre = belief.mu - (trader.assertiveness - 0.5) * width;
    const deals = Math.ceil(market.units / market.lot);
    const candidates = [];
    for (const z of GRID) {
        const price = Math.max(1, Math.round(Math.exp(belief.mu + z * width)));
        if (price > cap || candidates.some((candidate) => candidate.price === price)) continue;
        const accepts = phi((Math.log(price) - centre) / width);
        const gain = Number(worth) - purchaseCost(price, reference, trader.caution);
        if (!(gain > 0) || !(accepts > 0)) continue;
        const rate = market.buyersPerHour * accepts;
        const value = rate > 0 ? gain * Math.exp(-trader.wait * (deals + 1) / 2 / rate) : gain * accepts;
        candidates.push({ price, value });
    }
    if (!candidates.length) return null;
    return nearBest(candidates, rollKey);
}

// One roll among options [{ action, value }]: the near-best ones by how far
// above the 2% line they are; every other one keeps a small chance of its
// own (TendencyRoll.MIN of the near-best weight), never none.
function chooseByValue(options, rollKey) {
    const valid = options.filter((option) => Number.isFinite(option.value));
    if (!valid.length) return null;
    let best = -Infinity;
    for (const option of valid) best = Math.max(best, option.value);
    const floor = best - NEAR_BEST * Math.abs(best);
    let near = 0;
    for (const option of valid) if (option.value >= floor) near += option.value - floor + 1e-9;
    const weights = valid.map((option) => (option.value >= floor ? option.value - floor + 1e-9 : TendencyRoll.MIN * near));
    let left = TendencyRoll.roll(...rollKey) * weights.reduce((sum, weight) => sum + weight, 0);
    for (let at = 0; at < valid.length; at++) {
        left -= weights[at];
        if (left <= 0) return valid[at];
    }
    return valid[valid.length - 1];
}

// Which candidates take `slots` board slots: a weighted roll by their gain
// over the NPC, one after another without repeats. candidates: [{ gain }].
function chooseSlots(candidates, slots, seed) {
    const pool = candidates.filter((candidate) => candidate.gain > 0);
    const chosen = [];
    const random = TendencyRoll.seeded(String(seed));
    while (chosen.length < slots && pool.length) {
        let total = 0;
        for (const candidate of pool) total += candidate.gain;
        let left = random() * total;
        let at = 0;
        for (; at < pool.length - 1; at++) {
            left -= pool[at].gain;
            if (left <= 0) break;
        }
        chosen.push(pool[at]);
        pool.splice(at, 1);
    }
    return chosen;
}

module.exports = { GRID, NEAR_BEST, PERCEPTION, valueOfMoney, traderOf, phi, saleUtility, purchaseCost, marketFor,
    chooseAsk, chooseBid, chooseByValue, chooseSlots };
