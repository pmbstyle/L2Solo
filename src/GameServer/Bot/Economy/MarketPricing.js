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
const BidPurchaseAlternative = require('./BidPurchaseAlternative');
const { npcOwnsPurchase } = require('./TradeIntent');
const { MAX_INSPECTED } = require('./ReadyTradeChoice');
const ColdEconomyDecision = require('../Population/ColdEconomyDecision');
const BoardLook = require('./BoardLook');

// A bot as a trader: its persona's parameters, its hour and its money, its
// trips, and what its thread knows of the board. deps: { board, persona,
// npcOffersFor(selfId), findSpot(spotId), timestamp }.
function traderContext(state, deps = {}) {
    const timestamp = Number(deps.timestamp || Date.now());
    const economy = deps.economy || ColdEconomyDecision.economyFor(state, { ...deps, timestamp });
    const hour = economy.hourAdena;
    const adena = Math.max(0, Number(state?.adena ?? state?.inventory?.[57]?.amount ?? 0));
    const origin = deps.findSpot ? OfferOrder.farmingOrigin(state, deps.findSpot) : null;
    const economicTrip = deps.tripCost?.details ? deps.tripCost : economy.trip?.details ? economy.trip
        : Profit.tripFor(state, { ...economy, origin });
    const trip = economicTrip;
    const persona = deps.persona || economy.persona;
    const trader = PriceDecision.traderOf(persona, { hourAdena: hour, moneyPrice: economy.moneyPrice, gapHorizonHours: economy.gapHorizonHours });
    // The bot's own trip to a town: none to the town it is shopping in.
    const here = state?.activity === 'shopping' ? state.currentRegion || null : null;
    const demandFor = (id, enchant, town, askingPrice) => {
        const demand = !enchant ? require('./MarketTradeDemand').forecast(id, town, timestamp) : null;
        if (!demand || !(askingPrice > 0)) return demand;
        const board = deps.board || economy.board;
        const belief = PriceBelief.prior(id, { board, characterId: Number(state.characterId),
            timestamp, understanding: trader.understanding, marketTrades: state.marketTrades || {} });
        if (!belief) return null;
        const market = PriceDecision.marketFor(id, { board, ownerId: state.characterId, town, timestamp,
            tripCost: trip, npcOffers: deps.npcOffersFor?.(id) || [], demand });
        return { ...demand, willingUnits: PriceDecision.willingUnitsAt(belief, trader,
            { price: askingPrice, applicableUnits: demand.applicableUnits,
                landed: askingPrice + market.ownTrip, npcLanded: market.npcLanded }) };
    };
    let saleAmounts = null;
    const saleCount = line => {
        // Accepted custody keeps its advertised remainder until completion.
        if (line.storeType !== SELL || line.custodyPolicy !== 1 || state.stats?.tradeMeeting)
            return line.count;
        if (!saleAmounts) {
            const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
            const candidates = Disposition.saleCandidates(state, { unlimited: true,
                keptAmounts: {
                    ...invoke('GameServer/Inventory/ShotStock').keptAmounts(state, economy),
                    ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: economy.stock('potions').target }),
                    ...invoke('GameServer/Bot/Travel/ScrollStock').keptAmounts(state)
                }, reserved: economy.craftReservations || Disposition.selectedCraftAmounts(state, economy.network) });
            saleAmounts = new Map(candidates.map(item => [`${item.selfId}:${item.enchant || 0}`, item.count]));
        }
        return Math.min(line.count, saleAmounts.get(`${line.selfId}:${line.enchant || 0}`) || 0);
    };
    return {
        state,
        characterId: Number(state?.characterId || 0),
        understanding: trader.understanding,
        persona,
        marketTrades: state?.marketTrades || {},
        knowledgeEnabled: deps.knowledgeEnabled ?? PriceLearning.knowledgeEnabled(),
        trader,
        economy,
        preparedWorth: deps.preparedWorth || (economy.network?.demands && economy.projection?.values
            ? id => economy.network.demands.has(`item:${id}`) || economy.projection.values.has(Number(id))
                ? economy.worth(id) : NaN : typeof economy.worth === 'function' && !economy.price ? id => economy.worth(id) : null),
        preparedBuffer: deps.preparedBuffer || null,
        preparedValue: economy.network?.demands && economy.projection?.values ? id => {
            const key = `item:${id}`;
            return economy.network.demands.has(key) ? economy.network.demands.get(key)
                : economy.projection.values.has(Number(id)) ? economy.projection.values.get(Number(id)) : NaN;
        } : null,
        moneyPrice: economy.moneyPrice,
        hour,
        adena,
        timestamp,
        board: deps.board || economy.board,
        npcOffersFor: deps.npcOffersFor || (() => []),
        purchaseNpcOffersFor: deps.purchaseNpcOffersFor || deps.npcOffersFor || (() => []),
        demandFor: deps.demandFor || economy.demandFor || demandFor,
        ownStock: deps.ownStock || economy.ownStock || null,
        canSell: line => invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId)
            && !invoke('GameServer/Bot/Economy/ItemDisposition').isStarterEquipment(line)
            // Also withdraw legacy backed stock, which is no longer in the bag.
            && (state.stats?.tradeMeeting || !invoke('GameServer/Inventory/ShotStock').isPersonalShot(state, line.selfId))
            && deps.canSell?.(line) !== false,
        canBuy: line => invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId)
            && (Number(line.enchant || 0) > 0 || !npcOwnsPurchase(economy, line.selfId)),
        saleCount: deps.saleCount || (typeof economy.stock === 'function' ? saleCount : null),
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
    reference = 0, caution = 0, belief = null } = {}) {
    let best = null;
    // Keep finite quantities among the observed candidates: a lower bid for
    // five units can beat the top bid for only one unit in the same town.
    // A conditional bid holds no money: its value counts only the units its
    // buyer is expected to pay for (MVP-5), a backed one its count. The
    // physical answer still offers the bid's count; the trade checks money.
    const lines = (ctx.board?.list(selfId, BUY) || []).slice(0, MAX_INSPECTED);
    const seller = { characterId: Number(ctx.characterId), marketTrades: ctx.marketTrades || {} };
    for (const line of lines) {
        if (line.ownerId === Number(ctx.characterId) || line.enchant !== Number(enchant || 0)) continue;
        if (line.custodyPolicy === 1 && !require('../Population/PartyAdmission').personalOfferAllowed(line, ctx.state)) continue;
        if (line.custodyPolicy === 1 && require('./MeetingPriceRefusals').rejects(line,
            Math.min(units, line.count), require('../Population/PartyAdmission').counterpartyState(line.ownerId))) continue;
        const sale = PriceDecision.bidSale(seller, line, { board: ctx.board, persona: ctx.persona,
            timestamp: ctx.timestamp, units, residualUnitValue, belief });
        const outcome = sale.after;
        if (sale.status !== 'ready' || !(outcome.sold > 0)) continue;
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
        if (!best || score > best.score) best = { line, count: Math.min(units, line.count), net, outcome, trip,
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
function priceForSale(selfId, ctx, { town = null, units = 1, enchant = 0, current = 0, rollKey }) {
    const belief = beliefFor(selfId, ctx, enchant);
    if (!belief) return null;
    const market = marketFor(selfId, ctx, { town, units, enchant });
    return { belief, market, ask: PriceDecision.chooseAsk(belief, market, ctx.trader, rollKey, current) };
}

function marketFor(selfId, ctx, { town = null, units = 1, enchant = 0 } = {}) {
    const stock = ctx.ownStock?.groups?.get(`${Number(selfId)}:${Number(enchant)}`);
    return PriceDecision.marketFor(selfId, {
        board: ctx.board, ownerId: ctx.characterId, town, units, enchant, tripCost: ctx.tripCost,
        npcOffers: ctx.npcOffersFor(selfId), timestamp: ctx.timestamp,
        demand: ctx.demandFor?.(Number(selfId), Number(enchant), town) || null,
        ownUnits: stock?.units ?? units,
        // Different accepted own asks have no declared common exposure. A
        // failed physical preparation cannot become a smaller profitable lot.
        jointKnown: ctx.ownStock?.known !== false && !(stock?.prices?.size > 1)
    });
}

// A conditional stock quote declares a price, never guaranteed income.
// Creation and review use the same evidence when finite demand is unknown.
// Grade crystals have no bot NPC exit: when that alternative would win,
// their belief can still price a waiting offer without forecasting a sale.
function stockQuotePrice(belief, market, allowed, marketOnly = false) {
    const price = Math.round(Math.exp(belief.mu));
    return allowed && (marketOnly || !market.known && !market.truncated && !market.demand)
        && Number.isSafeInteger(price) && price > (marketOnly ? 0 : market.buyback) ? price : null;
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
function disposition(item, ctx, { town = null, room = 1, stockQuote = false, standingPrice = 0, rollKey,
    selectedAnswerRecord = 0 }) {
    const marketOnly = invoke('GameServer/Bot/Economy/ItemDisposition').isGradeCrystal(item);
    const units = Math.max(1, Number(item.count) || 1);
    const priced = priceForSale(item.selfId, ctx, { town, units, enchant: item.enchant || 0,
        current: standingPrice, rollKey: [...rollKey, 'ask'] });
    if (!priced) return { action: 'keep', priced: null, gain: 0 };
    let { ask } = priced;
    const { market, belief } = priced;
    // A free conditional offer retains these same physical goods. It is not
    // a forecast: neither income nor a buyer/arrival/lifetime is invented.
    // The listing owner enables this option before choosing its storefront
    // or board advertisement. Production still needs a supported outcome.
    const quotePrice = stockQuotePrice(belief, market,
        stockQuote && room > 0 && ctx.ownStock?.known !== false, marketOnly && ask.npc);
    const quote = quotePrice !== null;
    if (quote) {
        ask = { ...ask, price: standingPrice || quotePrice, npc: false, money: NaN, value: NaN, stockQuote: true };
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
    if (!marketOnly) add('npc', { receipts: market.buyback * units, riskHours: loss(market.buyback, units) });
    if (room > 0) add('keep', { monetaryResidual: units * (useful > 0 ? useful : market.buyback) });
    if (quote) add('list', { monetaryResidual: units * (useful > 0 ? useful : market.buyback) });
    if (gain > 0 && ask.known) {
        const share = market.units > 0 ? units / market.units : 0;
        add('list', { receipts: Math.max(0, Number(ask.sold || 0) * ask.price * share),
            monetaryResidual: Math.max(0, Number(ask.residual || 0) * market.buyback * share),
            delayHours: market.delayHours, riskHours: loss(ask.price, (ask.sold ?? units) * share) });
    }
    const residualUnitValue = useful > 0 && room > 0 ? useful : market.buyback;
    const answer = bestAnswer(item.selfId, ctx, { units, enchant: item.enchant, residualUnitValue,
        reference, caution: ctx.trader.caution, belief });
    if (answer && (Number.isFinite(answer.valueHours) ? answer.valueHours > 0 : answer.net > 0)) {
        const fields = { receipts: answer.outcome.receipts, monetaryResidual: answer.outcome.residualValue,
            riskHours: loss(answer.line.price, answer.outcome.sold) };
        if (answer.trip) Object.assign(fields, { actualCashFees: answer.trip.fees,
            foregoneBenefitHours: answer.trip.hours, cycleHours: answer.trip.hours });
        else fields.actualCashFees = Math.max(0, ctx.travel?.(answer.line.town) || 0);
        add('ad', fields);
    }
    // A previously selected sale has already won its roll. Fresh consent
    // still needs the exact bid to remain the executable positive-value
    // answer; a second unrelated roll is not a change in those facts.
    const selected = Number(selectedAnswerRecord) === Number(answer?.line?.recordId)
        ? options.find(option => option.action === 'ad') : null;
    const chosen = selected || PriceDecision.chooseByValue(options, rollKey);
    if (!chosen) return { action: 'keep', priced, gain: 0, answer: null, known: false };
    return { action: chosen.action, priced, gain: chosen.action === 'list' ? gain : 0,
        answer: chosen.action === 'ad' ? { line: answer.line, count: answer.count, receipts: answer.outcome.receipts } : null };
}

// A buy ad keeps authored worth with its line; the next ad starts fresh.
function bid(selfId, ctx, { units = 1, worth, cap, money = ctx.adena, town = null, rollKey, preferProvidedWorth = false }) {
    if (ctx.canBuy?.({ selfId, enchant: 0 }) === false) return null;
    const belief = PriceBelief.prior(selfId, ctx);
    if (!belief) return null;
    if (!preferProvidedWorth) worth = ctx.economy?.worth(selfId) ?? worth;
    const meeting = ctx.travelDetails?.(town);
    if (town && !meeting?.known) return null;
    const spendable = Number.isFinite(money) ? Math.max(0, money - (meeting?.known ? meeting.fees : 0)) : money;
    cap = Math.min(cap, spendable);
    // A short wallet may reduce the order. Compare alternatives for that
    // actual quantity too; scarce cheap stock can cover the smaller order.
    for (let pass = 0; pass < 4; pass++) {
        const market = marketFor(selfId, ctx, { units, town });
        market.purchaseCap = BidPurchaseAlternative.cap(selfId, ctx, { units, town, money });
        const chosen = PriceDecision.chooseBid(belief, market, ctx.trader, { worth, cap }, rollKey);
        if (!chosen) return null;
        const count = Number.isFinite(spendable) ? Math.min(units, Math.floor(spendable / chosen.price)) : units;
        if (count === units) return { ...chosen, count, purchaseCap: market.purchaseCap, pricing: lineState(selfId, ctx, { price: chosen.price, storeType: BUY, worth,
            count, sigma: PriceBelief.sigma(belief) }) };
        if (!(count > 0)) return null;
        units = count;
    }
    return null;
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
        // Source admission is independent of price noise or a retained quote:
        // the native withdrawal owner returns only this line's held remainder.
        const move = { recordId: line.recordId, lineId: line.lineId, selfId: line.selfId,
            expectedRevision: line.revision, previousPricing: { ...line.pricing } };
        if (!invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId)) {
            withdrawals.push(move); continue;
        }
        const count = ctx.saleCount?.(line);
        if (line.storeType === SELL && line.custodyPolicy === 1 && Number.isSafeInteger(count) && count < line.count) {
            if (!count) withdrawals.push(move);
            else reprices.push({ ...move, price: line.price, count,
                pricing: { ...line.pricing, seenCount: count } });
            continue;
        }
        const counter = MarketCounters.counter(MarketCounters.counterOf(line.selfId), ctx.timestamp);
        const reason = Number(ctx.reviewReasons?.get(line.lineId) || 0);
        const forced = Boolean(reason & 14);
        if (!forced && !(reason & 1) && counter.deals <= line.pricing.seenCounter) continue;
        if (line.storeType === SELL && ctx.canSell?.(line) === false) { withdrawals.push(move); continue; }
        if (line.storeType === BUY && ctx.canBuy?.(line) === false) { withdrawals.push(move); continue; }
        const belief = beliefFor(line.selfId, ctx, line.enchant || 0);
        if (!belief) continue;
        PriceBelief.learn(belief, PriceBelief.lineObservations(line, belief, ctx));
        const market = marketFor(line.selfId, ctx, { town: line.town, units: line.count, enchant: line.enchant || 0 });
        if (line.storeType === BUY) market.purchaseCap = ctx.purchaseCaps?.get(line.lineId)
            ?? BidPurchaseAlternative.forLine(line, ctx);
        const acceptedSigma = line.pricing.sigma > 0 ? line.pricing.sigma : PriceBelief.sigma(belief);
        // Keep the accepted baseline through noise: new observations refresh
        // evidence, but never turn every small quote move into another roll.
        const rival = ctx.board?.first(line.selfId, line.storeType, { excludeOwner: ctx.characterId,
            enchant: line.enchant || 0 });
        const movement = rival?.price > 0 && line.pricing.rival > 0
            ? Math.abs(Math.log(rival.price / line.pricing.rival))
            : Math.abs(belief.mu - Math.log(line.pricing.price || line.price));
        if (!forced && reason & 1 && movement < acceptedSigma && !(line.price > market.purchaseCap)) continue;
        const rollKey = [line.storeType === BUY ? 'bid' : 'ask', ctx.characterId,
            line.lineId, line.selfId, counter.deals, line.fills || 0];
        let chosen;
        let worth = line.pricing.worth;
        if (line.storeType === BUY) {
            worth = Object.hasOwn(ctx, 'preparedWorth') ? ctx.preparedWorth?.(line.selfId) ?? NaN
                : typeof ctx.economy?.worth === 'function' ? ctx.economy.worth(line.selfId) : worth;
            const cashCap = BidPurchaseAlternative.cashCap(line, ctx);
            if (!Number.isFinite(worth) || worth < 0) {
                // Unknown new usefulness cannot author additional spend. A
                // confirmed cheaper purchase/funding limit can still reduce
                // an old bid while its original authored worth is retained.
                const ceiling = Math.min(market.purchaseCap, cashCap);
                if (!(ceiling >= 0 && ceiling < line.price)) continue;
                worth = line.pricing.worth;
                chosen = ceiling >= 1 ? { price: Math.floor(ceiling) } : null;
            } else {
                const cap = Math.floor(Math.min(worth, cashCap));
                chosen = PriceDecision.chooseBid(belief, market, ctx.trader, { worth, cap }, rollKey, line.price);
            }
            if (!chosen) { withdrawals.push(move); continue; }
        }
        else {
            chosen = PriceDecision.chooseAsk(belief, market, ctx.trader, rollKey, line.price);
            const marketOnly = invoke('GameServer/Bot/Economy/ItemDisposition').isGradeCrystal(line);
            if (!chosen.known || marketOnly && chosen.npc) {
                const quote = stockQuotePrice(belief, market,
                    (line.custodyPolicy === 1 || marketOnly) && ctx.ownStock?.known !== false,
                    marketOnly && chosen.npc);
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
    return BoardLook.review(state, lines, ctx, lookSeen);
}

module.exports = { beliefFor, traderContext, priceForSale, lineState, bestAnswer, disposition, bid, look, lookOwn };
