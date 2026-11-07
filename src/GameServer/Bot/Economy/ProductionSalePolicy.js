'use strict';
const Demand = require('./MarketDemand');
const Price = require('./PriceDecision');
const Belief = require('./PriceBelief');
const { isShot } = require('./ShotTradeDemand');

// Production and native rechecks share the seller's ordinary price decision
// and finite public demand evidence. No accepted buyer is invented here.
function exit(state, id, { board, town, timestamp = Date.now(), trip, npcOffers = [], units, lot = 1, reserve = 0,
    productionUnits = null, current = 0, origin = null, preparedQuote = null } = {}) {
    origin ||= isShot(id) ? null : 'public_buy_interest';
    let demand = preparedQuote?.market.demand || Demand.forecast(id, town, { board, ownerId: state.characterId, timestamp });
    if (origin && demand?.alternatives) demand = demand.alternatives.find(row => row.origin === origin);
    if (origin && demand?.origin !== origin) return null;
    const persona = preparedQuote?.persona || invoke('GameServer/Bot/AI/BotPersona').of(state);
    if (!demand || !persona || !trip?.details?.(town)?.known) return null;
    const belief = preparedQuote?.belief || Belief.prior(id, { board, characterId: Number(state.characterId), timestamp,
        understanding: persona.understanding, marketTrades: state.marketTrades || {} });
    if (!belief) return null;
    const trader = preparedQuote?.trader || Price.traderOf(persona);
    const pricedUnits = productionUnits === null ? units
        : Math.max(0, units - lot) + Math.max(0, productionUnits - Math.max(0, Number(reserve) || 0));
    const market = preparedQuote ? { ...preparedQuote.market, units: Math.max(1, pricedUnits) }
        : Price.marketFor(id, { board, ownerId: state.characterId, town, tripCost: trip,
            npcOffers, timestamp, demand, units: pricedUnits });
    const ask = Price.chooseAsk(belief, market, trader, ['shot-production', state.characterId, id, demand.authority.revision], current);
    if (!ask.known || ask.npc || !(ask.sold > 0)) return null;
    const landed = ask.price + market.ownTrip;
    const cheaperUnits = market.rivals.reduce((sum, rival) => sum + (rival.landed < landed ? rival.units : 0), 0);
    if (ask.demandOrigin) demand = (demand.alternatives || [demand]).find(row => row.origin === ask.demandOrigin);
    const applicableUnits = ask.applicableUnits ?? demand.applicableUnits;
    const willingUnits = ask.willingUnits ?? Price.willingUnitsAt(belief, trader, { price: ask.price,
        applicableUnits, landed, npcLanded: market.npcLanded });
    const remaining = Math.max(0, Math.min(applicableUnits, willingUnits) - cheaperUnits - Math.max(0, units - lot));
    if (!(remaining > 0) || !Number.isSafeInteger(lot) || lot < 1) return null;
    const result = { type: 'listing', town, price: ask.price, count: applicableUnits,
        applicableUnits, willingUnits, cheaperUnits,
        maxBatches: Math.ceil((remaining + Math.max(0, Number(reserve) || 0)) / lot),
        residualUnitValue: market.buyback, delayHours: demand.delayHours,
        repeatable: false, forecast: demand, trip: trip(town), tripDetails: trip.details(town) };
    Object.defineProperty(result, 'quoteInputs', { value: preparedQuote || { market, persona, belief, trader } });
    return result;
}
function* exits(state, recipe, { board, timestamp, trip, prepareTrip, npcOffersFor, read = () => {}, existing = 0, reserve = 0 } = {}) {
    const id = Number(recipe.productId);
    read(id);
    const result = [];
    for (const town of isShot(id) ? Demand.towns(id, board, timestamp) : board?.demandTowns?.(id) || []) {
        if (prepareTrip) yield* prepareTrip(town);
        yield 'trip';
        const terms = { board, town, timestamp, trip,
            npcOffers: npcOffersFor?.(id) || [], lot: Number(recipe.productCount), reserve,
            units: Number(recipe.productCount) + Math.max(0, Number(existing) || 0) };
        const value = exit(state, id, terms);
        if (value) {
            // A larger lot may need a lower ask to reach its observed buyers.
            // This local adapter never enters the worker command; only the
            // selected price, quantity and public forecast revision do.
            Object.defineProperty(value, 'forQuantity', { value: batches => exit(state, id,
                { ...terms, preparedQuote: value.quoteInputs, productionUnits: batches * Number(recipe.productCount) }) });
            result.push(value);
        }
        yield 'exit';
    }
    return result;
}
module.exports = { exit, exits };
