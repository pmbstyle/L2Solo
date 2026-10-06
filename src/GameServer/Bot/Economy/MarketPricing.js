// One stateless board estimate and the unchanged expected-value decision
// for hot/cold trading. Only an author's open line keeps review cursors;
// own experience is counted by the actual trade transaction, not here.
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const OfferOrder = require('./OfferOrder');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceLearning = invoke('GameServer/Bot/Economy/PriceLearning');

// A bot as a trader: its persona's parameters, its hour and its money, its
// trips, and what its thread knows of the board. deps: { board, persona,
// npcOffersFor(selfId), findSpot(spotId), timestamp }.
function traderContext(state, deps = {}) {
    const timestamp = Number(deps.timestamp || Date.now());
    const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(state, { ...deps, timestamp });
    const hour = economy.hourAdena;
    const adena = Math.max(0, Number(state?.adena ?? state?.inventory?.[57]?.amount ?? 0));
    const origin = deps.findSpot ? OfferOrder.farmingOrigin(state, deps.findSpot) : null;
    const trip = OfferOrder.tripCost(state, { origin, timestamp });
    const trader = PriceDecision.traderOf(deps.persona || economy.persona, { hourAdena: hour, moneyPrice: economy.moneyPrice, gapHorizonHours: economy.gapHorizonHours });
    // The bot's own trip to a town: none to the town it is shopping in.
    const here = state?.activity === 'shopping' ? state.currentRegion || null : null;
    return {
        characterId: Number(state?.characterId || 0),
        understanding: trader.understanding,
        marketTrades: state?.stats?.marketTrades || {},
        knowledgeEnabled: deps.knowledgeEnabled ?? PriceLearning.knowledgeEnabled(),
        trader,
        economy,
        moneyPrice: economy.moneyPrice,
        hour,
        adena,
        timestamp,
        board: economy.board,
        npcOffersFor: deps.npcOffersFor || (() => []),
        tripCost: trip || null,
        travel: (town) => (town && town === here ? 0 : trip ? trip(town) : 0)
    };
}

// The best buy ad to answer with `units` of an item (E45, user Q3 C: the side
// that acts travels): of the best ad of each town, the one that pays most
// for what it takes less the bot's trip there. { line, count, net } or null.
function bestAnswer(selfId, ctx, { units = 1, enchant = 0 } = {}) {
    let best = null;
    for (const line of ctx.board ? ctx.board.heads(selfId, BUY, {
        excludeOwner: ctx.characterId, accept: (candidate) => candidate.enchant === Number(enchant || 0)
    }) : []) {
        const count = Math.min(Math.max(1, Number(units) || 1), line.count);
        const net = line.price * count - ctx.travel(line.town);
        if (!best || net > best.net) best = { line, count, net };
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
    return PriceDecision.marketFor(selfId, {
        board: ctx.board, ownerId: ctx.characterId, town, units, enchant, tripCost: ctx.tripCost,
        npcOffers: ctx.npcOffersFor(selfId), timestamp: ctx.timestamp
    });
}

// Publication and every completed review checkpoint exactly this line's
// state, even when its standing price remains among the near-best choices.
function lineState(selfId, ctx, { price, storeType = SELL, worth = 0, fills = 0, enchant = 0 }) {
    const counter = MarketCounters.counter(MarketCounters.counterOf(selfId), ctx.timestamp);
    return {
        price: Math.round(price),
        seenCounter: counter.deals,
        seenItem: MarketCounters.itemDeals(selfId).deals,
        rival: ctx.board?.first(selfId, storeType, { excludeOwner: ctx.characterId, enchant })?.price || 0,
        worth: storeType === BUY ? Number(worth) || 0 : 0,
        seenFills: Math.max(0, Number(fills) || 0)
    };
}

// What to do with `units` of an item the bot may sell (hold / board /
// warehouse / NPC / a buy ad): one roll between the NPC buy-back now, the
// best buy ad on the board answered in its town (its price less the bot's
// trip there, E45) and the best use of keeping it: the board at its best ask
// when it brings more Adena than the NPC (the gain the board's slots compete
// by), else keeping it for a later sale at its own value after one more
// buyer's wait (nothing while nobody buys its kind), possible only with room
// where it keeps it. Values per unit, by the bot's utility: a sale under its
// own value is a loss. Returns { action: 'list' | 'npc' | 'keep' | 'ad',
// priced, gain, answer } with gain the board's Adena over the NPC for all
// units ('list' still needs a slot) and answer the ad ({ line, count }).
// smallLot: a lot too small for the board (MarketLotPolicy) that the author
// keeps for a bulk lot: keeping it or a buy ad only.
function disposition(item, ctx, { town = null, room = 1, smallLot = false, rollKey }) {
    const units = Math.max(1, Number(item.count) || 1);
    const priced = priceForSale(item.selfId, ctx, { town, units, enchant: item.enchant || 0, rollKey: [...rollKey, 'ask'] });
    if (!priced) return { action: 'keep', priced: null, gain: 0 };
    const { ask, market, belief } = priced;
    const useful = ctx.economy?.worth(item.selfId);
    const gain = ask.npc ? 0 : (ask.money - market.buyback) * units;
    const options = smallLot ? [] : [{ action: 'npc', value: ask.npcValue }];
    if (useful > 0 && room > 0) options.push({ action: 'keep', value: useful });
    if (gain > 0 && !smallLot) options.push({ action: 'list', value: ask.value });
    else if (room > 0) {
        const later = market.buyersPerHour > 0 ? Math.exp(-ctx.trader.wait / market.buyersPerHour) : 0;
        options.push({ action: 'keep', value: Math.exp(belief.mu) * later });
    }
    const answer = bestAnswer(item.selfId, ctx, { units, enchant: item.enchant });
    if (answer && answer.net > 0) {
        options.push({ action: 'ad', value: PriceDecision.saleUtility(answer.net / answer.count, Math.exp(belief.mu),
            ctx.trader.caution) });
    }
    const chosen = PriceDecision.chooseByValue(options, rollKey);
    return { action: chosen.action, priced, gain: chosen.action === 'list' ? gain : 0,
        answer: chosen.action === 'ad' ? { line: answer.line, count: answer.count } : null };
}

// A buy ad keeps authored worth with its line; the next ad starts fresh.
function bid(selfId, ctx, { units = 1, worth, cap, rollKey }) {
    const belief = PriceBelief.prior(selfId, ctx);
    if (!belief) return null;
    worth = ctx.economy?.worth(selfId) ?? worth;
    const chosen = PriceDecision.chooseBid(belief, marketFor(selfId, ctx, { units }), ctx.trader, { worth, cap }, rollKey);
    return chosen ? { ...chosen, pricing: lineState(selfId, ctx, { price: chosen.price, storeType: BUY, worth }) } : null;
}

// A counter event is the attention trigger. No event means no estimate,
// market construction or roll. The caller supplies only its indexed lines.
// The database applies each move using revision + the full previousPricing
// fence; metadata-only updates checkpoint no-change choices too.
function look(state, lines, ctx) {
    const updates = [];
    const reprices = [];
    const withdrawals = [];
    for (const line of lines) {
        if (!(line.count > 0) || !line.pricing) continue;
        if (line.ownerId && Number(line.ownerId) !== Number(ctx.characterId)) continue;
        const counter = MarketCounters.counter(MarketCounters.counterOf(line.selfId), ctx.timestamp);
        if (counter.deals <= line.pricing.seenCounter) continue;
        const belief = beliefFor(line.selfId, ctx, line.enchant || 0);
        if (!belief) continue;
        PriceBelief.learn(belief, PriceBelief.lineObservations(line, belief, ctx));
        const market = marketFor(line.selfId, ctx, { town: line.town, units: line.count, enchant: line.enchant || 0 });
        const move = { recordId: line.recordId, lineId: line.lineId, selfId: line.selfId,
            expectedRevision: line.revision, previousPricing: { ...line.pricing } };
        const rollKey = [line.storeType === BUY ? 'bid' : 'ask', ctx.characterId,
            line.lineId, line.selfId, counter.deals, line.fills || 0];
        let chosen;
        if (line.storeType === BUY) {
            const worth = line.pricing.worth;
            const cap = Math.floor(Math.min(worth, line.price + ctx.adena / Math.max(1, line.count)));
            chosen = PriceDecision.chooseBid(belief, market, ctx.trader, { worth, cap }, rollKey, line.price);
            if (!chosen) { withdrawals.push(move); continue; }
        }
        else {
            chosen = PriceDecision.chooseAsk(belief, market, ctx.trader, rollKey, line.price);
            if (chosen.npc) { withdrawals.push(move); continue; }
        }
        const pricing = lineState(line.selfId, ctx, { price: chosen.price, storeType: line.storeType,
            worth: line.pricing.worth, fills: line.fills, enchant: line.enchant || 0 });
        if (chosen.price !== line.price) reprices.push({ ...move, price: chosen.price, pricing });
        else updates.push({ ...move, pricing });
    }
    return updates.length || reprices.length || withdrawals.length ? { updates, reprices, withdrawals } : null;
}

module.exports = { beliefFor, traderContext, priceForSale, lineState, bestAnswer, disposition, bid, look };
