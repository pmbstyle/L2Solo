// What a shot recipe is worth to the crafter that would buy it (E92): the gain
// it adds to the bot's hour, over the bot's horizon (the hours it still has at
// this stage, EconomicValuation.stageHours), in adena. Read from the board the
// bot sees (deals per hour of the product, funded buy ads, the shops that sell
// it), never from who holds the recipe:
//  - own use: the shots it burns an hour at what they would cost it on the
//    board against what they cost it to make, and, when nobody sells them,
//    the whole combat gain of having shots (the stock rule's benefit);
//  - sale: the units the board takes an hour (deals plus the funded unmet
//    demand spread over the horizon) shared with the visible sellers and
//    the bot, at the craft profit, within the mana the crafts take.
// Own crafts come first, the sale takes the mana left. The bot's own
// understanding of the market puts a stable personal error on the result.
const Profit = require('./CraftProfitPolicy');
const Valuation = require('./EconomicValuation');
const TendencyRoll = require('../AI/TendencyRoll');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');

const positive = value => Math.max(0, Number(value) || 0);

// route: ColdShotEconomyService.craftCandidate for this recipe (null: no way
// to make it now, so no worth). offers: the board's sell lines of the product.
function of(state, recipe, route, { economy, offers = [], now = Date.now() } = {}) {
    const none = { worth: 0, hourGain: 0, own: 0, sale: 0, horizon: 0 };
    if (!route || !economy) return none;
    const context = Profit.contextFor(state, now);
    const margin = Profit.margin(recipe, route.salePrice, route.cost, context);
    if (!margin || !(margin.hours > 0)) return none;
    const productId = Number(recipe.productId);
    const units = Math.max(1, Number(recipe.productCount || 1));
    const unitCost = route.cost / units;
    const horizon = Valuation.stageHours(state, economy.hunt.expPerHour, economy.persona);
    const crafts = 1 / margin.hours;
    const sellers = offers.length;
    const supply = offers.reduce((sum, offer) => sum + positive(offer.count), 0);

    const stock = economy.stock('shots');
    const uses = Number(stock.itemId) === productId ? positive(stock.usePerHour) : 0;
    const ownCrafts = Math.min(crafts, uses / units);
    let own = ownCrafts * units * Math.max(0, route.salePrice - unitCost) - ownCrafts * margin.labour;
    if (uses > 0 && supply === 0 && stock.targetHours > 0) {
        own += positive(stock.benefitHours) / stock.targetHours * positive(economy.hunt.perHour);
    }

    const counter = MarketCounters.counter(MarketCounters.counterOf(productId), now);
    const deals = MarketCounters.itemDeals(productId);
    const observed = counter.perHour * positive(deals.units);
    const demand = observed + positive(route.demand) / Math.max(1, horizon);
    const saleCrafts = Math.min(Math.max(0, crafts - ownCrafts), demand / (sellers + 1) / units);
    const sale = saleCrafts * Math.max(0, margin.profit);

    const hourGain = Math.max(0, own) + sale;
    const error = 1 + (1 - Number(economy.persona?.understanding ?? 0.3))
        * (2 * TendencyRoll.roll('recipe-worth', state.characterId, Number(recipe.recipeId)) - 1);
    return { worth: Math.floor(hourGain * horizon * Math.max(0, error)), hourGain, own, sale, horizon };
}

module.exports = { of };
