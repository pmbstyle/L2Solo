const Profit = require('./CraftProfitPolicy');

// The basket of one craft: what the crafter owns of each material (at its
// own value) and, for the rest, one purchase in the town where it costs the
// least with the trip (planFor(selfId, missing): { town, cost, landed, units,
// whole }, the one purchase path, ColdMarketService.planPurchase). cashCost is
// what the purchases pay for goods; cost adds the trips and the owned value.
function basketFor(recipe, planFor, ownedFor = () => null) {
    const purchases = [];
    const owned = [];
    let cashCost = 0;
    let landedCost = 0;
    let ownedValue = 0;
    for (const material of recipe.materials || []) {
        let missing = Number(material.amount || 0);
        if (!Number.isSafeInteger(missing) || missing <= 0) return null;
        const stock = ownedFor(Number(material.selfId)) || {};
        const ownCount = Math.min(missing, Math.max(0, Math.floor(Number(stock.count || 0))));
        if (ownCount > 0) {
            const unitValue = Number(stock.unitValue || 0);
            if (!Number.isFinite(unitValue) || unitValue <= 0) return null;
            owned.push({ selfId: Number(material.selfId), count: ownCount, unitValue });
            ownedValue += ownCount * unitValue;
            missing -= ownCount;
        }
        if (missing <= 0) continue;
        const plan = planFor(Number(material.selfId), missing);
        if (!plan || !plan.whole || !Number.isFinite(plan.landed)) return null;
        purchases.push({ selfId: Number(material.selfId), count: missing, town: plan.town, cost: plan.cost,
            landed: plan.landed });
        cashCost += plan.cost;
        landedCost += plan.landed;
    }
    const cost = landedCost + ownedValue;
    return Number.isFinite(cost) && cost > 0
        ? { purchases, owned, cashCost, ownedValue, cost: Math.ceil(cost) } : null;
}

// The margin of one craft: the product's price x its count x the success
// rate, less the cost of the basket. Also the value a crafter puts on a
// material or a recipe (PriceBelief.demandValue).
function craftMargin(recipe, productPrice, basketCost) {
    return Profit.revenue(recipe, productPrice) - Number(basketCost);
}

// The best exit of a craft: exits [{ price, count, trip }] with trip what the
// sale's trip costs (a buy ad answered in its town; none for a static buyer).
function opportunityFor(state, recipe, planFor, exits = [], ownedFor = () => null, context = {}) {
    const successRate = Math.max(0, Math.min(100, Number(recipe?.successRate || 0))) / 100;
    const outputCount = Number(recipe?.productCount || 0);
    if (!recipe || recipe.type !== 'dwarven' || successRate <= 0 || outputCount <= 0
        || Number(state?.vitals?.mp || 0) < Number(recipe.mpCost || 0)) return null;
    const basket = basketFor(recipe, planFor, ownedFor);
    if (!basket || basket.cost <= 0 || basket.cashCost > Number(state.adena || 0)) return null;
    return exits.filter((exit) => Number.isFinite(Number(exit.price)) && Number(exit.price) > 0
            && Number(exit.count) >= outputCount)
        .map((exit) => {
            const revenue = Number(exit.price) * outputCount;
            const margin = Profit.margin(recipe, exit.price, basket.cost, { ...context, tripCost: Number(exit.trip) || 0 });
            const expectedProfit = margin?.profit ?? -Infinity;
            return { recipe, basket, exit, revenue, expectedProfit, successRate, hours: margin?.hours };
        })
        .filter((candidate) => candidate.expectedProfit > 0)
        .sort((a, b) => b.expectedProfit - a.expectedProfit || b.revenue - a.revenue)[0] || null;
}

module.exports = {
    basketFor, craftMargin, opportunityFor
};
