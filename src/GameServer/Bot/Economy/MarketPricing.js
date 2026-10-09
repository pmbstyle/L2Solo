// One stateless board estimate and the unchanged expected-value decision
// for hot/cold trading. Only an author's open line keeps review cursors;
// own experience is counted by the actual trade transaction, not here.
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const OfferOrder = require('./OfferOrder');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceLearning = invoke('GameServer/Bot/Economy/PriceLearning');
const Valuation = require('./EconomicValuation');
const Profit = require('./CraftProfitPolicy');

// A bot as a trader: its persona's parameters, its hour and its money, its
// trips, and what its thread knows of the board. deps: { board, persona,
// npcOffersFor(selfId), findSpot(spotId), timestamp }.
function traderContext(state, deps = {}) {
    const timestamp = Number(deps.timestamp || Date.now());
    const economy = deps.economy || require('../Population/ColdEconomyDecision').economyFor(state, { ...deps, timestamp });
    const hour = economy.hourAdena;
    const adena = Math.max(0, Number(state?.adena ?? state?.inventory?.[57]?.amount ?? 0));
    const origin = deps.findSpot ? OfferOrder.farmingOrigin(state, deps.findSpot) : null;
    const economicTrip = deps.tripCost?.details ? deps.tripCost : economy.trip?.details ? economy.trip
        : Profit.tripFor(state, { ...economy, origin });
    const trip = economicTrip;
    const trader = PriceDecision.traderOf(deps.persona || economy.persona, { hourAdena: hour, moneyPrice: economy.moneyPrice, gapHorizonHours: economy.gapHorizonHours });
    // The bot's own trip to a town: none to the town it is shopping in.
    const here = state?.activity === 'shopping' ? state.currentRegion || null : null;
    return {
        characterId: Number(state?.characterId || 0),
        understanding: trader.understanding,
        marketTrades: state?.marketTrades || {},
        knowledgeEnabled: deps.knowledgeEnabled ?? PriceLearning.knowledgeEnabled(),
        trader,
        economy,
        moneyPrice: economy.moneyPrice,
        hour,
        adena,
        timestamp,
        board: deps.board || economy.board,
        npcOffersFor: deps.npcOffersFor || (() => []),
        demandFor: deps.demandFor || economy.demandFor || null,
        ownStock: deps.ownStock || economy.ownStock || null,
        canSell: deps.canSell || null,
        derivedDemandValue: deps.derivedDemandValue ?? economy.derivedDemandValue,
        derivedDemandSupported: deps.derivedDemandSupported ?? economy.derivedDemandSupported,
        tripCost: trip || null,
        travelDetails: (town) => town && town === here ? { known: true, hours: 0, fees: 0 }
            : economicTrip.details(town),
        travel: (town) => (town && town === here ? 0 : trip ? trip(town) : 0)
    };
}

// The best executable finite buy ad for this whole physical stock. The side
// that acts travels (E45); known economic inputs rank the same hours as the
// final action. `net` remains the legacy monetary trip comparison for callers.
function bestAnswer(selfId, ctx, { units = 1, enchant = 0, residualUnitValue = 0,
    reference = 0, caution = 0 } = {}) {
    let best = null;
    for (const line of ctx.board?.list(selfId, BUY) || []) {
        if (line.ownerId === Number(ctx.characterId) || line.enchant !== Number(enchant || 0)) continue;
        const outcome = PriceDecision.saleOutcome({ units, applicableUnits: line.count, willingUnits: line.count,
            cheaperUnits: 0, price: line.price, residualUnitValue });
        if (!outcome.known || !(outcome.sold > 0)) continue;
        const trip = ctx.travelDetails?.(line.town);
        const travel = ctx.travel ? ctx.travel(line.town) : 0;
        const net = outcome.receipts + outcome.residualValue - travel;
        if (trip && !trip.known || !Number.isFinite(net)) continue;
        const moneyPrice = Number(ctx.moneyPrice ?? ctx.economy?.moneyPrice);
        const valued = Valuation.opportunity({ moneyPrice }, [{ probability: 1,
            receipts: outcome.receipts, monetaryResidual: outcome.residualValue,
            actualCashFees: trip ? trip.fees : Math.max(0, travel),
            foregoneBenefitHours: trip ? trip.hours : 0, cycleHours: trip ? trip.hours : 0,
            riskHours: Math.max(0, reference - line.price) * outcome.sold * caution * moneyPrice }]);
        const score = valued.known ? valued.valueHours : net;
        if (!best || score > best.score) best = { line, count: outcome.sold, net, outcome, trip,
            valueHours: valued.valueHours, score };
    }
    return best;
}

function beliefFor(selfId, ctx, enchant = 0) {
    const belief = PriceBelief.prior(selfId, ctx);
    if (!belief || !(enchant > 0)) return belief;
    if (typeof ctx.economy?.price !== 'function') return null;
    const item = { selfId:Number(selfId), amount:1, enchant:Number(enchant) };
    const cost = invoke('GameServer/Bot/Economy/BotImprovementPolicy').enchantedPrice(item,enchant,ctx.economy);
    if (!(cost > 0) || !Number.isFinite(cost)) return null;
    // The full replacement/scroll chain prices this actual enchant; ordinary
    // NPC stock and +0 rivals are not interchangeable with it.
    const quotes = [ctx.board?.first(selfId,SELL,{excludeOwner:ctx.characterId,enchant}),
        ctx.board?.first(selfId,BUY,{excludeOwner:ctx.characterId,enchant})].filter(row => row?.price > 0);
    return { ...belief, mu:(Math.log(cost) * belief.K + quotes.reduce((n,row) => n + Math.log(row.price),0))
        / (belief.K + quotes.length), K:belief.K + quotes.length };
}
// A fresh ask for this choice; nothing is read from saved item memory.
function priceForSale(selfId, ctx, { town = null, units = 1, enchant = 0, rollKey }) {
    const belief = beliefFor(selfId, ctx, enchant);
    if (!belief) return null;
    const market = marketFor(selfId, ctx, { town, units, enchant });
    return { belief, market, ask: PriceDecision.chooseAsk(belief, market, ctx.trader, rollKey) };
}

function marketFor(selfId, ctx, { town = null, units = 1, enchant = 0 } = {}) {
    const stock = ctx.ownStock?.groups?.get(`${Number(selfId)}:${Number(enchant)}`);
    return PriceDecision.marketFor(selfId, {
        board: ctx.board, ownerId: ctx.characterId, town, units, enchant, tripCost: ctx.tripCost,
        npcOffers: ctx.npcOffersFor(selfId), timestamp: ctx.timestamp,
        demand: ctx.demandFor?.(Number(selfId), Number(enchant)) || null,
        ownUnits: stock?.units ?? units,
        // Different accepted own asks have no declared common exposure. A
        // failed physical preparation cannot become a smaller profitable lot.
        jointKnown: ctx.ownStock?.known !== false && !(stock?.prices?.size > 1)
    });
}

// A conditional stock quote declares a price, never guaranteed income.
// Creation and review use the same evidence when finite demand is unknown.
function stockQuotePrice(belief, market, allowed) {
    const price = Math.round(Math.exp(belief.mu));
    return allowed && !market.known && !market.truncated && !market.demand
        && Number.isSafeInteger(price) && price > market.buyback ? price : null;
}

// Publication and every completed review checkpoint exactly this line's
// state, even when its standing price remains among the near-best choices.
function lineState(selfId, ctx, { price, storeType = SELL, worth = 0, fills = 0, enchant = 0,
    count = 0, sigma = 0 }) {
    const counter = MarketCounters.counter(MarketCounters.counterOf(selfId), ctx.timestamp);
    const belief = sigma > 0 ? null : beliefFor(selfId, ctx, enchant);
    return {
        price: Math.round(price),
        seenCounter: counter.deals,
        seenAt: ctx.timestamp,
        seenItem: MarketCounters.itemDeals(selfId).deals,
        rival: ctx.board?.first(selfId, storeType, { excludeOwner: ctx.characterId, enchant })?.price || 0,
        worth: storeType === BUY ? Number(worth) || 0 : 0,
        seenFills: Math.max(0, Number(fills) || 0),
        seenCount: Math.max(0, Number(count) || 0),
        sigma: Number.isFinite(sigma) && sigma > 0 ? sigma : belief ? PriceBelief.sigma(belief) : 0
    };
}

// One action on the whole owned stock: NPC receipts, keeping goods, a known
// finite listing forecast, or answering one executable public bid. All share
// monetary value, physical residual and actual trip time/fees before one
// tendency roll. `gain` is the board's Adena over the NPC for slot selection;
// answering a bid returns its physical line/count, including partial demand.
// smallLot: a lot too small for the board (MarketLotPolicy) that the author
// keeps for a bulk lot: keeping it or a buy ad only.
function disposition(item, ctx, { town = null, room = 1, smallLot = false, stockQuote = false, rollKey }) {
    const units = Math.max(1, Number(item.count) || 1);
    const priced = priceForSale(item.selfId, ctx, { town, units, enchant: item.enchant || 0, rollKey: [...rollKey, 'ask'] });
    if (!priced) return { action: 'keep', priced: null, gain: 0 };
    let { ask } = priced;
    const { market, belief } = priced;
    // A free conditional offer retains these same physical goods. It is not
    // a forecast: neither income nor a buyer/arrival/lifetime is invented.
    // Only the field advert owner enables this option; shops and production
    // continue to require the ordinary supported outcome.
    const quotePrice = stockQuotePrice(belief, market,
        stockQuote && !smallLot && room > 0 && ctx.ownStock?.known !== false);
    const quote = quotePrice !== null;
    if (quote) {
        ask = { ...ask, price: quotePrice, npc: false, money: NaN, value: NaN, stockQuote: true };
        priced.ask = ask;
    }
    const useful = ctx.economy?.worth?.(item.selfId);
    const gain = quote || ask.npc ? 0 : (ask.money - market.buyback) * units;
    const reference = Math.exp(belief.mu);
    const moneyPrice = Number(ctx.moneyPrice ?? ctx.economy?.moneyPrice);
    const options = [];
    const add = (action, fields) => {
        const result = Valuation.opportunity({ moneyPrice, discountRate: ctx.trader.wait }, [{ probability: 1,
            ownInputOpportunityValue: reference * units, ...fields }]);
        if (result.known) options.push({ action, value: result.valueHours });
    };
    const loss = (price, count) => Math.max(0, reference - price) * count * ctx.trader.caution * moneyPrice;
    if (!smallLot) add('npc', { receipts: market.buyback * units, riskHours: loss(market.buyback, units) });
    if (room > 0) add('keep', { monetaryResidual: units * (useful > 0 ? useful : market.buyback) });
    if (quote) add('list', { monetaryResidual: units * (useful > 0 ? useful : market.buyback) });
    if (gain > 0 && !smallLot && ask.known) {
        const share = market.units > 0 ? units / market.units : 0;
        add('list', { receipts: Math.max(0, Number(ask.sold || 0) * ask.price * share),
            monetaryResidual: Math.max(0, Number(ask.residual || 0) * market.buyback * share),
            delayHours: market.delayHours, riskHours: loss(ask.price, (ask.sold ?? units) * share) });
    }
    const residualUnitValue = useful > 0 && room > 0 ? useful : market.buyback;
    const answer = bestAnswer(item.selfId, ctx, { units, enchant: item.enchant, residualUnitValue,
        reference, caution: ctx.trader.caution });
    if (answer && (Number.isFinite(answer.valueHours) ? answer.valueHours > 0 : answer.net > 0)) {
        const fields = { receipts: answer.outcome.receipts, monetaryResidual: answer.outcome.residualValue,
            riskHours: loss(answer.line.price, answer.count) };
        if (answer.trip) Object.assign(fields, { actualCashFees: answer.trip.fees,
            foregoneBenefitHours: answer.trip.hours, cycleHours: answer.trip.hours });
        else fields.actualCashFees = Math.max(0, ctx.travel?.(answer.line.town) || 0);
        add('ad', fields);
    }
    const chosen = PriceDecision.chooseByValue(options, rollKey);
    if (!chosen) return { action: 'keep', priced, gain: 0, answer: null, known: false };
    return { action: chosen.action, priced, gain: chosen.action === 'list' ? gain : 0,
        answer: chosen.action === 'ad' ? { line: answer.line, count: answer.count } : null };
}

// A buy ad keeps authored worth with its line; the next ad starts fresh.
function bid(selfId, ctx, { units = 1, worth, cap, rollKey }) {
    const belief = PriceBelief.prior(selfId, ctx);
    if (!belief) return null;
    worth = ctx.economy?.worth(selfId) ?? worth;
    const chosen = PriceDecision.chooseBid(belief, marketFor(selfId, ctx, { units }), ctx.trader, { worth, cap }, rollKey);
    return chosen ? { ...chosen, pricing: lineState(selfId, ctx, { price: chosen.price, storeType: BUY, worth,
        count: units, sigma: PriceBelief.sigma(belief) }) } : null;
}

// Only lines selected by the owner's shared attention roll reach this choice.
// Native writes retain revision + previousPricing fences; an unchanged price
// returns no update. Its observation stays in the worker's numeric lookSeen.
function look(state, lines, ctx) {
    const reprices = [];
    const withdrawals = [];
    for (const line of lines) {
        if (!(line.count > 0) || !line.pricing) continue;
        if (line.ownerId && Number(line.ownerId) !== Number(ctx.characterId)) continue;
        const counter = MarketCounters.counter(MarketCounters.counterOf(line.selfId), ctx.timestamp);
        const reason = Number(ctx.reviewReasons?.get(line.lineId) || 0);
        const forced = Boolean(reason & 14);
        if (!forced && !(reason & 1) && counter.deals <= line.pricing.seenCounter) continue;
        const move = { recordId: line.recordId, lineId: line.lineId, selfId: line.selfId,
            expectedRevision: line.revision, previousPricing: { ...line.pricing } };
        if (line.storeType === SELL && ctx.canSell?.(line) === false) { withdrawals.push(move); continue; }
        const belief = beliefFor(line.selfId, ctx, line.enchant || 0);
        if (!belief) continue;
        PriceBelief.learn(belief, PriceBelief.lineObservations(line, belief, ctx));
        const market = marketFor(line.selfId, ctx, { town: line.town, units: line.count, enchant: line.enchant || 0 });
        const acceptedSigma = line.pricing.sigma > 0 ? line.pricing.sigma : PriceBelief.sigma(belief);
        // Keep the accepted baseline through noise: new observations refresh
        // evidence, but never turn every small quote move into another roll.
        const rival = ctx.board?.first(line.selfId, line.storeType, { excludeOwner: ctx.characterId,
            enchant: line.enchant || 0 });
        const movement = rival?.price > 0 && line.pricing.rival > 0
            ? Math.abs(Math.log(rival.price / line.pricing.rival))
            : Math.abs(belief.mu - Math.log(line.pricing.price || line.price));
        if (!forced && reason & 1 && movement < acceptedSigma) continue;
        const rollKey = [line.storeType === BUY ? 'bid' : 'ask', ctx.characterId,
            line.lineId, line.selfId, counter.deals, line.fills || 0];
        let chosen;
        let worth = line.pricing.worth;
        if (line.storeType === BUY) {
            worth = typeof ctx.economy?.worth === 'function' ? ctx.economy.worth(line.selfId) : worth;
            // An incomplete prepared graph cannot justify withdrawal or spend.
            if (!Number.isFinite(worth) || worth < 0) continue;
            const cap = Math.floor(Math.min(worth, line.price + ctx.adena / Math.max(1, line.count)));
            chosen = PriceDecision.chooseBid(belief, market, ctx.trader, { worth, cap }, rollKey, line.price);
            if (!chosen) { withdrawals.push(move); continue; }
        }
        else {
            chosen = PriceDecision.chooseAsk(belief, market, ctx.trader, rollKey, line.price);
            if (!chosen.known) {
                const quote = stockQuotePrice(belief, market,
                    line.custodyPolicy === 1 && ctx.ownStock?.known !== false);
                if (quote === null) continue;
                chosen = { ...chosen, price: quote, npc: false };
            }
            if (chosen.npc) { withdrawals.push(move); continue; }
        }
        const pricing = lineState(line.selfId, ctx, { price: chosen.price, storeType: line.storeType,
            worth, fills: line.fills, enchant: line.enchant || 0,
            count: line.count, sigma: PriceBelief.sigma(belief) });
        if (chosen.price !== line.price) reprices.push({ ...move, price: chosen.price, pricing });
    }
    return reprices.length || withdrawals.length ? { reprices, withdrawals } : null;
}

function lookOwn(state, lines, ctx, lookSeen) {
    return require('./BoardLook').review(state, lines, ctx, lookSeen);
}

module.exports = { beliefFor, traderContext, priceForSale, lineState, bestAnswer, disposition, bid, look, lookOwn };
