// One pricing decision for selling and buying (group E, user 2026-10-05;
// market-sim step 3.3, tools/market-sim/n0/step33/groupE: e10 belief, e12
// loss, e13 competition): the best expected outcome over a grid of prices on
// the bot's belief (PriceBelief), one roll among the near-best ones. One
// module for the main thread and the cold worker.
//
// Selling at p uses a declared finite demand segment. The belief gives its
// willingness at p; finite cheaper stock is deducted once before clipping
// the physical owned stock. The NPC alternative retains perception width.
// Receipts are discounted by the segment's known delay; unsold goods retain
// their physical exit value. Missing demand evidence stays unknown. Traits
// are parameters only: assertiveness is the
// optimism of the centre, caution the loss aversion against the bot's own
// value (a sale below it is a loss weighted 1 + caution; waiting is no loss,
// only a delay), commitment the patience on the discount. Buying mirrors it.
const TendencyRoll = require('../AI/TendencyRoll');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
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
// Waiting costs the gap's urgency spread over that wish's own horizon (1/hour).
// 76797 adena/hour * 3.235e-5 hours/adena / 59.1 hours = .042/hour.
function waitRate({ hourAdena, moneyPrice, gapHorizonHours } = {}) {
    return gapHorizonHours > 0 ? Math.max(0, Number(hourAdena) || 0)
        * Math.max(0, Number(moneyPrice) || 0) / gapHorizonHours : 0;
}
function traderOf(persona, economy) {
    const traits = persona?.traits || {};
    return { wait: waitRate(economy) * (1.5 - Number(traits.commitment ?? 0.5)),
        assertiveness: Number(traits.assertiveness ?? 0.5), caution: Number(traits.caution ?? 0.5),
        understanding: Number(persona?.understanding ?? 0.3) };
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

function saleOutcome({ units, applicableUnits, willingUnits, cheaperUnits, price,
    residualUnitValue = 0, delayHours = 0, discountRate = 0 } = {}) {
    if (!Number.isSafeInteger(units) || units < 0 || !Number.isSafeInteger(cheaperUnits) || cheaperUnits < 0
        || ![applicableUnits, willingUnits, price, residualUnitValue, delayHours, discountRate]
            .every(value => Number.isFinite(value) && value >= 0)) {
        return { known: false, sold: NaN, residual: NaN, receipts: NaN, residualValue: NaN };
    }
    const demand = Math.max(0, Math.min(applicableUnits, willingUnits) - cheaperUnits);
    const sold = Math.min(units, demand), residual = units - sold;
    const receipts = sold * price * Math.exp(-discountRate * delayHours);
    const residualValue = residual * residualUnitValue;
    return Number.isFinite(receipts) && Number.isFinite(residualValue)
        ? { known: true, sold, residual, receipts, residualValue }
        : { known: false, sold: NaN, residual: NaN, receipts: NaN, residualValue: NaN };
}

// The same finite willingness model serves an ask and a first production trial.
function willingUnitsAt(belief, trader, { price, applicableUnits, landed = price, npcLanded = Infinity }) {
    const width = PriceBelief.sigma(belief);
    const centre = belief.mu + (trader.assertiveness - 0.5) * width;
    const wants = 1 - phi((Math.log(price) - centre) / width);
    const chosen = Number.isFinite(npcLanded) ? 1 - phi(Math.log(landed / npcLanded) / PERCEPTION) : 1;
    return applicableUnits * wants * chosen;
}

// A public bid describes interest, never reserved money. Re-read its exact
// native record so a withdrawn/edited bid cannot support a stale trial.
function prospectiveExit(state, exit, { board, persona, timestamp = Date.now(), belief = null } = {}) {
    const unsupported = () => {
        const rest = { ...exit };
        delete rest.prospective;
        return rest;
    };
    const offer = exit?.offer;
    const ownerId = Number(offer?.ownerId ?? offer?.sourceId);
    const id = Number(offer?.selfId);
    const revision = offer?.revision ?? offer?.expectedRevision;
    if (!(exit?.conditional || offer?.conditional || offer?.custodyPolicy === 1)
        || !board?.records || !Number.isSafeInteger(id) || id <= 0
        || !Number.isSafeInteger(ownerId) || ownerId <= 0 || ownerId === Number(state?.characterId)
        || Number(offer?.enchant || 0) || !Number.isSafeInteger(Number(offer?.count)) || Number(offer.count) <= 0
        || !(Number(offer?.price) > 0) || !Number.isFinite(Number(offer.price))
        || Number(exit.price) !== Number(offer.price) || Number(exit.count) !== Number(offer.count)) return unsupported();
    const line = board.records.get(Number(offer.recordId))?.find(row => Number(row.lineId) === Number(offer.lineId));
    if (!line || line.storeType !== BUY || line.custodyPolicy !== 1 || line.ownerId !== ownerId
        || line.selfId !== id || Number(line.enchant || 0) || line.price !== Number(offer.price)
        || line.count !== Number(offer.count) || line.revision !== revision) return unsupported();
    persona ||= invoke('GameServer/Bot/AI/BotPersona').of(state);
    if (!persona) return unsupported();
    // The caller's own belief of this item, when it already holds one.
    belief ||= PriceBelief.prior(id, { board, characterId: Number(state.characterId), timestamp,
        understanding: Number(persona.understanding ?? 0.3), marketTrades: state.marketTrades || {} });
    if (!belief || !Number.isFinite(belief.mu) || !(PriceBelief.sigma(belief) > 0)) return unsupported();
    const willingUnits = willingUnitsAt(belief, traderOf(persona), { price: line.price, applicableUnits: line.count });
    if (!Number.isFinite(willingUnits) || willingUnits < 0) return unsupported();
    return { ...exit, trial: true, repeatable: false, residualUnitValue: buyback(id), prospective: {
        known: true, origin: 'public_bid', authority: { recordId: line.recordId, lineId: line.lineId, revision: line.revision },
        applicableUnits: line.count, willingUnits, observedAt: timestamp } };
}

// The asks of one board list a trader inspects.
const QUOTE_DEPTH = 5;

// The cheaper competition a seller meets at a bid price: the first
// QUOTE_DEPTH asks of the board list that are foreign, of the same enchant
// and below it. `tail`: the sixth ask is cheaper too, so the competition
// behind the inspected ones is unknown.
function cheaperAsks(asks, { ownerId, price, enchant = 0 }) {
    let cheaperUnits = 0;
    for (let at = 0; at < asks.length && at < QUOTE_DEPTH; at++) {
        const line = asks[at];
        if (Number(line.ownerId) !== Number(ownerId) && Number(line.enchant || 0) === Number(enchant)
            && line.price < price) cheaperUnits += Number(line.count);
    }
    return { cheaperUnits, tail: asks.length > QUOTE_DEPTH && asks[QUOTE_DEPTH].price < price };
}

// The competition of one exit of `count` units, one reader for the planner,
// its recheck and bidSale: `limit` when the uninspected cheaper tail may
// cover the bid, so its demand is unknown.
function exitCompetition(asks, { ownerId, price, enchant = 0, count }) {
    const { cheaperUnits, tail } = cheaperAsks(asks, { ownerId, price, enchant });
    return { cheaperUnits, limit: tail && cheaperUnits < count };
}

// One finite sale of `units` more goods into one bid (MVP-5). A backed bid
// buys its count; a conditional one only what its buyer is willing to pay
// for, read from the seller's price belief (prospectiveExit). Cheaper
// foreign asks serve the buyer first and the seller's own unsold goods
// (`oldUnits`) are counted once, so `gross` is only the gain of the new
// units. `limit`: an uninspected cheaper tail may cover the bid.
function bidSale(state, offer, { board, persona, timestamp = Date.now(), asks = [], oldUnits = 0, units,
    residualUnitValue, fixed = false, belief = null } = {}) {
    let exit = { conditional: offer.custodyPolicy === 1, price: offer.price, count: offer.count, offer };
    if (!fixed) exit = prospectiveExit(state, exit, { board, persona, timestamp, belief });
    const forecast = exit.prospective
        || (!exit.conditional ? { known: true, applicableUnits: offer.count, willingUnits: offer.count } : null);
    if (!forecast?.known) return { status: 'unknown', exit };
    const { cheaperUnits, limit } = fixed ? { cheaperUnits: 0, limit: false }
        : exitCompetition(asks, { ownerId: state?.characterId, price: offer.price, enchant: Number(offer.enchant || 0),
            count: forecast.applicableUnits });
    if (limit) return { status: 'limit', exit, forecast, cheaperUnits };
    const input = { applicableUnits: forecast.applicableUnits, willingUnits: forecast.willingUnits, cheaperUnits, price: offer.price,
        residualUnitValue: Number(residualUnitValue ?? exit.residualUnitValue ?? 0) };
    const before = saleOutcome({ ...input, units: oldUnits });
    const after = saleOutcome({ ...input, units: oldUnits + units });
    if (!before.known || !after.known) return { status: 'unknown', exit, forecast, cheaperUnits };
    return { status: 'ready', exit, forecast, cheaperUnits, before, after,
        gross: after.receipts + after.residualValue - before.receipts - before.residualValue };
}

// What the seller of `units` of an item in `town` competes with: { buyback,
// buyersPerHour, lot, rivals [{ landed, units }], npcLanded, ownTrip }.
// tripCost(town): a buyer's trip there in Adena (OfferOrder.tripCost of the
// trader); npcOffers: the NPC shops selling the item ({ price, town }).
function marketFor(selfId, { board = null, ownerId = 0, town = null, units = 1, tripCost = null,
    npcOffers = [], timestamp = Date.now(), enchant = 0, demand = null, ownUnits = null,
    jointKnown = true } = {}) {
    const id = Number(selfId);
    const trip = (where) => (tripCost ? Math.min(Number(tripCost(where)) || 0, Number.MAX_SAFE_INTEGER) : 0);
    const rivals = [];
    let truncated = false;
    // Bound attention as well as retained rivals. Uninspected mixed enchants
    // or own rows make the forecast unknown, never invented free liquidity.
    const source = board ? board.list(id, SELL) : [];
    const observed = source.slice(0, 2 * RIVALS_SEEN);
    truncated = source.length > observed.length;
    for (const line of observed) {
        if (line.ownerId === Number(ownerId) || Number(line.enchant || 0) !== Number(enchant)) continue;
        if (rivals.length < RIVALS_SEEN) rivals.push({ landed: line.price + trip(line.town), units: line.count,
            origin: 'public_ask', authority: { recordId: line.recordId, lineId: line.lineId, revision: line.revision },
            selfId: id, enchant: Number(enchant), observedAt: timestamp, scope: 'board',
            availability: { from: timestamp, until: timestamp } });
        else truncated = true;
    }
    let npcLanded = Infinity;
    for (const offer of enchant > 0 ? [] : npcOffers || []) {
        if (offer?.price > 0) npcLanded = Math.min(npcLanded, Number(offer.price) + trip(offer.town));
    }
    // ARCH-NOTE: the delivered counter tracks kind-level deals, not permitted
    // item arrivals/exposure/lifetime. Dividing by listing count manufactured
    // demand and made split own listings create buyers. No supported producer
    // currently supplies those three item facts, so the external tail is unknown.
    const supported = Boolean(jointKnown && demand && demand.known !== false && demand.origin && demand.authority
        && Number(demand.selfId ?? id) === id && Number(demand.enchant ?? enchant) === Number(enchant)
        && Number.isFinite(demand.applicableUnits) && demand.applicableUnits >= 0
        && Number.isFinite(demand.availability?.from) && Number.isFinite(demand.availability?.until)
        && demand.availability.from <= timestamp && demand.availability.until >= timestamp);
    return {
        buyback: buyback(id),
        known: supported && !truncated,
        applicableUnits: supported ? demand.applicableUnits : NaN,
        delayHours: supported ? Number(demand.delayHours ?? 0) : NaN,
        buyersPerHour: supported && Number.isFinite(demand.arrivalsPerHour) ? demand.arrivalsPerHour : NaN,
        lot: Math.max(1, MarketCounters.itemDeals(id).units || 1),
        units: Math.max(1, Number(ownUnits ?? units) || 1),
        rivals,
        npcLanded,
        ownTrip: trip(town),
        sourceRevision: board?.itemRevision(id) ?? null,
        demand: supported ? demand : null,
        truncated
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
// `current`: the line's ask now; it stands while it is still among the
// near-best ones (the roll is for a new ask, not for a jitter of the old).
function chooseAsk(belief, market, trader, rollKey, current = 0) {
    const width = PriceBelief.sigma(belief);
    const reference = Math.exp(belief.mu);
    const known = market.known !== false && Number.isFinite(market.applicableUnits)
        && Number.isSafeInteger(market.units) && market.units >= 0 && Number.isFinite(market.delayHours)
        && market.delayHours >= 0 && !market.truncated;
    const npcValue = saleUtility(market.buyback, reference, trader.caution);
    if (!known) {
        // An unavailable forecast does not invalidate an already accepted line.
        return current > market.buyback ? { price: current, value: NaN, money: NaN, npc: false, npcValue, known: false }
            : { price: market.buyback, value: npcValue, money: market.buyback, npc: true, npcValue, known: false };
    }
    const valueAt = (price) => {
        const landed = price + market.ownTrip;
        let ahead = 0;
        for (const rival of market.rivals) if (rival.landed < landed) ahead += rival.units;
        // Finite rival stock occurs only in A. The infinite NPC alternative
        // keeps the existing perception assessment, never a second rival share.
        const outcome = saleOutcome({ units: market.units, applicableUnits: market.applicableUnits,
            willingUnits: willingUnitsAt(belief, trader, { price, applicableUnits: market.applicableUnits,
                landed, npcLanded: market.npcLanded }), cheaperUnits: ahead, price,
            residualUnitValue: market.buyback, delayHours: market.delayHours, discountRate: trader.wait });
        if (!outcome.known) return null;
        const discount = Math.exp(-trader.wait * market.delayHours);
        return { price, value: market.units > 0 ? (outcome.sold * saleUtility(price, reference, trader.caution) * discount
            + outcome.residual * npcValue) / market.units : 0,
        money: market.units > 0 ? (outcome.receipts + outcome.residualValue) / market.units : 0,
        sold: outcome.sold, residual: outcome.residual, known: true };
    };
    const candidates = [];
    for (const z of GRID) {
        const price = Math.max(1, Math.round(Math.exp(belief.mu + z * width)));
        if (price <= market.buyback || candidates.some((candidate) => candidate.price === price)) continue;
        const candidate = valueAt(price);
        if (candidate) candidates.push(candidate);
    }
    let bestValue = -Infinity;
    for (const candidate of candidates) bestValue = Math.max(bestValue, candidate.value);
    if (!candidates.length || bestValue <= npcValue) {
        return { price: market.buyback, value: npcValue, money: market.buyback, npc: true, npcValue, known: true };
    }
    const standing = current > market.buyback ? valueAt(current) : null;
    if (standing && standing.value >= bestValue - NEAR_BEST * Math.abs(bestValue)) return { ...standing, npc: false, npcValue };
    const best = nearBest(candidates, rollKey);
    return { ...best, npc: false, npcValue };
}

// The bid of a buy ad: { price, value } or null when no bid gains anything.
// worth: what the item is worth to the buyer (its plan's price); cap: the
// most it may pay a unit. Sellers come at the same rate as buyers; a seller
// takes q with the chance the belief gives that he asks no more. Before the
// board shows any seller of the kind, the wait is unknown: a bid is worth its
// gain by that chance alone. `current`: the ad's bid now; it stands while
// it is still among the near-best ones, as an ask does.
function chooseBid(belief, market, trader, { worth, cap }, rollKey, current = 0) {
    const width = PriceBelief.sigma(belief);
    const reference = Math.exp(belief.mu);
    const centre = belief.mu - (trader.assertiveness - 0.5) * width;
    const deals = Math.ceil(market.units / market.lot);
    const valueAt = (price) => {
        const accepts = phi((Math.log(price) - centre) / width);
        const gain = Number(worth) - purchaseCost(price, reference, trader.caution);
        if (!(gain > 0) || !(accepts > 0)) return null;
        const rate = market.buyersPerHour * accepts;
        return { price, value: rate > 0 ? gain * Math.exp(-trader.wait * (deals + 1) / 2 / rate) : gain * accepts };
    };
    const candidates = [];
    for (const z of GRID) {
        const price = Math.max(1, Math.round(Math.exp(belief.mu + z * width)));
        if (price > cap || candidates.some((candidate) => candidate.price === price)) continue;
        const candidate = valueAt(price);
        if (candidate) candidates.push(candidate);
    }
    if (!candidates.length) return null;
    let bestValue = -Infinity;
    for (const candidate of candidates) bestValue = Math.max(bestValue, candidate.value);
    const standing = current > 0 && current <= cap ? valueAt(current) : null;
    if (standing && standing.value >= bestValue - NEAR_BEST * Math.abs(bestValue)) return standing;
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

// One roll among options [{ action, value }] in proportion to their values
// (a weighted roll, Q6: variety over the best one): a value at or below 0
// weighs nothing but every option keeps a floor, together TendencyRoll.MIN
// of the whole weight, so none is impossible. When no value is above 0 (all
// are losses), the weights are how much less each loses than the worst.
// null without a finite option.
function chooseByWeight(options, rollKey) {
    const valid = options.filter((option) => Number.isFinite(option.value));
    if (!valid.length) return null;
    let positive = 0;
    let worst = Infinity;
    for (const option of valid) {
        positive += Math.max(0, option.value);
        worst = Math.min(worst, option.value);
    }
    const weightOf = (option) => (positive > 0 ? Math.max(0, option.value) : option.value - worst);
    let total = 0;
    for (const option of valid) total += weightOf(option);
    const floor = total > 0 ? TendencyRoll.MIN * total / valid.length : 1;
    let left = TendencyRoll.roll(...rollKey) * (total + floor * valid.length);
    for (const option of valid) {
        left -= weightOf(option) + floor;
        if (left <= 0) return option;
    }
    return valid[valid.length - 1];
}

// Which candidates take `slots` board slots: existing income gain, or an
// explicit attention weight for a free conditional quote. Quote attention
// is not forecast income. One draw sequence without repeated candidates.
function chooseSlots(candidates, slots, seed) {
    const weight = candidate => candidate.slotWeight ?? candidate.gain;
    const pool = candidates.filter((candidate) => weight(candidate) > 0);
    const chosen = [];
    const random = TendencyRoll.seeded(String(seed));
    while (chosen.length < slots && pool.length) {
        let total = 0;
        for (const candidate of pool) total += weight(candidate);
        let left = random() * total;
        let at = 0;
        for (; at < pool.length - 1; at++) {
            left -= weight(pool[at]);
            if (left <= 0) break;
        }
        chosen.push(pool[at]);
        pool.splice(at, 1);
    }
    return chosen;
}

module.exports = { GRID, NEAR_BEST, PERCEPTION, waitRate, traderOf, phi, saleUtility, purchaseCost, marketFor, saleOutcome, willingUnitsAt, prospectiveExit, QUOTE_DEPTH, cheaperAsks, exitCompetition, bidSale,
    chooseAsk, chooseBid, chooseByValue, chooseByWeight, chooseSlots };
