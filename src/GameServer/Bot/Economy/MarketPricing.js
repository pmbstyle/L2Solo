// How a bot prices its board trade (group E, user 2026-10-05): the shared
// steps over its beliefs (PriceBelief) and the one decision (PriceDecision),
// for the main thread (a listing at the market, a buy ad, the NPC sale) and
// the cold worker (the look at its own lines, MarketReview there).
//
// The caller's thread supplies the board index, the NPC shops selling an item
// and the trader's trip cost; the counters and first prices are read from
// MarketCounters in either thread.
const { SELL } = require('../../AfkTrade/BoardIndex');
const OfferOrder = require('./OfferOrder');
const TendencyRoll = require('../AI/TendencyRoll');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');

// A bot as a trader: its persona's parameters, its hour and its money, its
// trips, and what its thread knows of the board. deps: { board, persona,
// npcOffersFor(selfId), findSpot(spotId), timestamp }.
function traderContext(state, deps = {}) {
    const timestamp = Number(deps.timestamp || Date.now());
    const hour = invoke('GameServer/Bot/AI/BotHuntEfficiency').hourValue(state, timestamp).perHour;
    const adena = Math.max(0, Number(state?.adena ?? state?.inventory?.[57]?.amount ?? 0));
    const origin = deps.findSpot ? OfferOrder.farmingOrigin(state, deps.findSpot) : null;
    const trip = OfferOrder.tripCost(state, { origin, timestamp });
    const trader = PriceDecision.traderOf(deps.persona, { hour, adena });
    return {
        characterId: Number(state?.characterId || 0),
        understanding: trader.understanding,
        trader,
        hour,
        adena,
        timestamp,
        board: deps.board || null,
        npcOffersFor: deps.npcOffersFor || (() => []),
        tripCost: trip || null
    };
}

// The ask for `units` of an item listed in `town`: { belief, ask, market }.
// The belief is the bot's own, else a fresh prior not yet kept (adopt keeps
// it when the item is listed).
function priceForSale(book, selfId, ctx, { town = null, units = 1, rollKey }) {
    const belief = PriceBelief.lookup(book, selfId, ctx) || PriceBelief.fresh(book, selfId, ctx);
    if (!belief) return null;
    const market = PriceDecision.marketFor(selfId, {
        board: ctx.board, ownerId: ctx.characterId, town, units, tripCost: ctx.tripCost,
        npcOffers: ctx.npcOffersFor(selfId), timestamp: ctx.timestamp
    });
    return { belief, market, ask: PriceDecision.chooseAsk(belief, market, ctx.trader, rollKey) };
}

// The item is listed at `price`: the bot keeps its belief (a touch of its
// own) and remembers its ask and what it has seen of the market now.
function adopt(book, belief, ctx, price) {
    const id = Number(belief.selfId);
    if (book.beliefs.get(id) === belief) PriceBelief.touch(book, belief, ctx);
    else PriceBelief.keep(book, belief, ctx);
    const counter = MarketCounters.counter(MarketCounters.counterOf(id), ctx.timestamp);
    belief.ask = Math.round(price);
    belief.seenItem = MarketCounters.itemDeals(id).deals;
    belief.seenCounter = counter.deals;
    belief.rival = ctx.board?.first(id, SELL, { excludeOwner: ctx.characterId, enchant: 0 })?.price || 0;
    return belief;
}

// What to do with `units` of an item the bot may sell (hold / board /
// warehouse / NPC): one roll between the NPC buy-back now and the best use
// of keeping it: the board at its best ask when it brings more Adena than
// the NPC (the gain the board's slots compete by), else keeping it for a
// later sale at its own value after one more buyer's wait (nothing while
// nobody buys its kind), possible only with room where it keeps it. Values
// per unit, by the bot's utility: a sale under its own value is a loss.
// Returns { action: 'list' | 'npc' | 'keep', priced, gain } with gain the
// board's Adena over the NPC for all units; 'list' still needs a slot.
function disposition(book, item, ctx, { town = null, room = 1, rollKey }) {
    const units = Math.max(1, Number(item.count) || 1);
    const priced = priceForSale(book, item.selfId, ctx, { town, units, rollKey: [...rollKey, 'ask'] });
    if (!priced) return { action: 'keep', priced: null, gain: 0 };
    const { ask, market, belief } = priced;
    const gain = ask.npc ? 0 : (ask.money - market.buyback) * units;
    const options = [{ action: 'npc', value: ask.npcValue }];
    if (gain > 0) options.push({ action: 'list', value: ask.value });
    else if (room > 0) {
        const later = market.buyersPerHour > 0 ? Math.exp(-ctx.trader.wait / market.buyersPerHour) : 0;
        options.push({ action: 'keep', value: Math.exp(belief.mu) * later });
    }
    const chosen = PriceDecision.chooseByValue(options, rollKey);
    return { action: chosen.action, priced, gain: chosen.action === 'list' ? gain : 0 };
}

// The bid of a buy ad for `units` worth `worth` a unit to the buyer, at most
// `cap` a unit: the same belief, the mirrored decision. null: no bid gains.
function bid(book, selfId, ctx, { units = 1, worth, cap, rollKey }) {
    const belief = PriceBelief.lookup(book, selfId, ctx) || PriceBelief.fresh(book, selfId, ctx);
    if (!belief) return null;
    const market = PriceDecision.marketFor(selfId, {
        board: ctx.board, ownerId: ctx.characterId, units, tripCost: ctx.tripCost,
        npcOffers: ctx.npcOffersFor(selfId), timestamp: ctx.timestamp
    });
    return PriceDecision.chooseBid(belief, market, ctx.trader, { worth, cap }, rollKey);
}

// Attention (user, 2026-10-05): at a cold resolve the bot looks at its lines
// with chance worth / (worth + cost). worth = the value listed (price x units
// over its open lines) x its counters' hourly move x the hours since its last
// look (at most 1) x its understanding (at least 0.05) x (1 + its money
// need); cost = what it earns now in one minute (a hunting or grouped bot:
// its hour; any other: nothing).
const EARNING_ACTIVITIES = new Set(['hunting', 'grouped']);
function lookChance(state, lines, ctx, lookAt) {
    let listed = 0;
    let moved = 0;
    for (const line of lines) {
        const value = line.price * line.count;
        listed += value;
        moved += value * MarketCounters.moveOf(MarketCounters.counterOf(line.selfId), ctx.timestamp);
    }
    if (!(listed > 0)) return 0;
    const hours = lookAt > 0 ? Math.min(1, Math.max(0, ctx.timestamp - lookAt) / 3600000) : 1;
    const need = ctx.hour / Math.max(1, ctx.adena + ctx.hour);
    const worth = moved * hours * Math.max(0.05, ctx.understanding) * (1 + need);
    const cost = EARNING_ACTIVITIES.has(state?.activity) ? ctx.hour / 60 : 0;
    return TendencyRoll.chance(worth / Math.max(1e-9, worth + cost));
}

// The bot's look at its own sell lines (MarketReview, cold worker): learns
// from what happened since its last look and chooses each line's ask again
// where new evidence arrived. Returns { book, reprices: [{ recordId, lineId,
// selfId, price }], withdrawals: [{ recordId, lineId, selfId }] }; null when
// it did not look.
function look(state, lines, ctx) {
    const book = PriceBelief.readBook(state.stats);
    const roll = TendencyRoll.roll('look', ctx.characterId, ctx.timestamp);
    if (roll >= lookChance(state, lines, ctx, book.lookAt)) return null;
    const reprices = [];
    const withdrawals = [];
    book.looks += 1;
    for (const line of lines) {
        const known = PriceBelief.lookup(book, line.selfId, ctx);
        const belief = known || PriceBelief.ensure(book, line.selfId, ctx);
        if (!belief) continue;
        const ask = belief.ask > 0 ? belief.ask : line.price;
        const { observations, sales } = PriceBelief.lookObservations(book, belief, ctx, {
            ask, lines: ctx.board?.linesIn(MarketCounters.counterOf(line.selfId)) || 0
        });
        if (sales) {
            PriceBelief.ownDeals(belief, sales);
            PriceBelief.touch(book, belief, ctx, sales);
        }
        belief.ask = line.price;
        // React only when new evidence arrived.
        if (known && !PriceBelief.learn(belief, observations)) continue;
        if (!known) PriceBelief.learn(belief, observations);
        const market = PriceDecision.marketFor(line.selfId, {
            board: ctx.board, ownerId: ctx.characterId, town: line.town, units: line.count, tripCost: ctx.tripCost,
            npcOffers: ctx.npcOffersFor(line.selfId), timestamp: ctx.timestamp
        });
        const chosen = PriceDecision.chooseAsk(belief, market, ctx.trader, ['ask', ctx.characterId, line.selfId, book.looks]);
        if (chosen.npc) {
            withdrawals.push({ recordId: line.recordId, lineId: line.lineId, selfId: line.selfId });
            continue;
        }
        if (chosen.price !== line.price) {
            reprices.push({ recordId: line.recordId, lineId: line.lineId, selfId: line.selfId, price: chosen.price });
            belief.ask = chosen.price;
        }
    }
    book.lookAt = ctx.timestamp;
    return { book, reprices, withdrawals };
}

module.exports = { traderContext, priceForSale, adopt, disposition, bid, lookChance, look };
