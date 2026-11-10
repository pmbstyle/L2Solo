'use strict';

const Funding = require('./PurchaseFunding');
const { GRADED_SHOTS } = require('./ProductionPolicy');
const FORECAST_MARGIN = 0.15;

function routeCash(route) {
    return Number(route?.valuation?.cashNow ?? (Number(route?.basket?.cashCost)
        + Number(route?.basket?.actualCashFees || 0)));
}

// Shot outcomes already deduct inputs, labour and travel. Fund their gross
// benefit so the wallet rule does not charge the same inputs a second time.
// Public demand, quantities and physical cash still come from the native route.
function investment(route, context = {}, { cash = 0, opportunity = 0, hours = 0 } = {}) {
    const moneyPrice = Number(context.moneyPrice ?? (context.hourAdena > 0 ? 1 / context.hourAdena : NaN));
    const value = Number(route?.valueHours);
    const basket = route?.basket;
    if (!GRADED_SHOTS.has(Number(route?.recipe?.productId)) || !basket
        || !(moneyPrice > 0) || !Number.isFinite(moneyPrice) || !Number.isFinite(value)
        || ![cash, opportunity, hours].every(n => Number.isFinite(n) && n >= 0)) return null;
    const requiredCash = routeCash(route) + cash;
    const net = value - (cash + opportunity) * moneyPrice - hours;
    const receipts = Number(route.valuation?.expectedReceipts);
    const residual = Number(route.valuation?.expectedResidual);
    if (!(net > 0) || !Number.isFinite(requiredCash) || requiredCash < 0
        || !Number.isFinite(receipts) || !Number.isFinite(residual)) return null;
    const routeCost = Math.max(0, receipts + residual - value / moneyPrice);
    const extraCost = opportunity + hours / moneyPrice;
    const cost = routeCost + cash + extraCost;
    const forecast = route.exit?.type === 'listing' || route.exit?.conditional === true
        || route.exit?.offer?.conditional === true || route.exit?.offer?.custodyPolicy === 1;
    const margin = forecast ? FORECAST_MARGIN : 0;
    if (net / moneyPrice + 1e-7 < margin * cost) return null;
    const maxExtraCash = Math.max(0, Math.floor((value / moneyPrice - extraCost
        - margin * (routeCost + extraCost)) / (1 + margin)));
    return { cash: requiredCash, maxExtraCash,
        terms: { r: requiredCash > 0 ? moneyPrice + net / requiredCash : Infinity } };
}

function canFund(state, route, context) {
    const funding = investment(route, context);
    return !!funding && funding.cash <= Funding.spendable(state, 0, funding.terms);
}

function recipePaths(state, recipe, options) {
    const missing = !options.known && !(Number(state.inventory?.[recipe.recipeItemId]?.amount) > 0)
        && options.acquisition?.available !== true;
    let seeking = false, acquisition = options.acquisition;
    if (missing && options.allowSeeking
        && require('../../Items/ItemAcquisitionCatalog').hasNonRaidSource(Number(recipe.recipeItemId))) {
        const hours = require('./ShotProductionHorizon').HOURS;
        const affordable = investment(options.route, options.context, { hours });
        const reference = require('./MarketCounters').firstPrice(Number(recipe.recipeItemId));
        const price = Math.floor(Math.min(Number(reference), Number(affordable?.maxExtraCash)));
        if (price > 0 && Number.isFinite(price)) {
            // A funded WTB / collection target, never an executable seller.
            // Charge one window of supply waiting before valuing the intent.
            acquisition = { available: true, price, hours }; seeking = true;
        }
    }
    const decision = require('./WealthCraftDecision').recipePaths(state, recipe, { ...options, acquisition,
        fundingFor: ({ route, acquireCash, scrollValue, acquisitionHours, acquisitionFees, context }) => {
            const funding = investment(route, context, { cash: acquireCash + acquisitionFees, opportunity: scrollValue,
                hours: acquisitionHours + Number(context.learningHours || 0) });
            return funding && { ...funding, maxPrice: Math.max(0, Math.min(funding.maxExtraCash - acquisitionFees,
                Funding.spendable(state, 0, funding.terms) - routeCash(route) - acquisitionFees)) };
        } });
    if (seeking) for (const row of decision.rows) if (row.kind === 'acquire') row.kind = 'seek';
    return decision;
}

module.exports = { FORECAST_MARGIN, investment, canFund, recipePaths };
