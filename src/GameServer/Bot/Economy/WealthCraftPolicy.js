const MAX_INPUT_OFFERS = 12;
const MIN_PROFIT = 1000;
const MIN_RETURN = 0.25;
const MAX_WALLET_SHARE = 0.2;
const WALLET_RESERVE = 10000;

function basketFor(recipe, offersFor, ownedFor = () => null) {
    const purchases = [];
    const owned = [];
    let cashCost = 0;
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
        const offers = offersFor(Number(material.selfId))
            .filter((offer) => Number.isFinite(Number(offer.price)) && Number(offer.price) > 0
                && Number.isFinite(Number(offer.count)) && Number(offer.count) > 0 && offer.store?.afkTrade)
            .sort((a, b) => Number(a.price) - Number(b.price)
                || Number(b.playerPriority === true) - Number(a.playerPriority === true));
        for (const offer of offers) {
            if (missing <= 0) break;
            const count = Math.min(missing, Number(offer.count));
            purchases.push({ selfId: Number(material.selfId), count, price: Number(offer.price), offer });
            cashCost += count * Number(offer.price);
            missing -= count;
            if (purchases.length > MAX_INPUT_OFFERS) return null;
        }
        if (missing > 0) return null;
    }
    const cost = cashCost + ownedValue;
    return Number.isSafeInteger(cost) && cost > 0
        ? { purchases, owned, cashCost, ownedValue, cost } : null;
}

// The margin of one craft: the product's price x its count x the success
// rate, less the cost of the basket. Also the value a crafter puts on a
// material or a recipe (PriceBelief.demandValue).
function craftMargin(recipe, productPrice, basketCost) {
    const successRate = Math.max(0, Math.min(100, Number(recipe?.successRate || 0))) / 100;
    return Math.floor(Number(productPrice) * Number(recipe?.productCount || 0) * successRate) - Number(basketCost);
}

function opportunityFor(state, recipe, offersFor, exits = [], ownedFor = () => null) {
    const successRate = Math.max(0, Math.min(100, Number(recipe?.successRate || 0))) / 100;
    const outputCount = Number(recipe?.productCount || 0);
    if (!recipe || recipe.type !== 'dwarven' || successRate <= 0 || outputCount <= 0
        || Number(state?.vitals?.mp || 0) < Number(recipe.mpCost || 0)) return null;
    const basket = basketFor(recipe, offersFor, ownedFor);
    if (!basket || basket.cost <= 0 || basket.cashCost > Number(state.adena || 0) * MAX_WALLET_SHARE
        || Number(state.adena || 0) - basket.cashCost < WALLET_RESERVE) return null;
    return exits.filter((exit) => Number.isFinite(Number(exit.price)) && Number(exit.price) > 0
            && Number(exit.count) >= outputCount)
        .map((exit) => {
            const revenue = Number(exit.price) * outputCount;
            const expectedProfit = craftMargin(recipe, exit.price, basket.cost);
            return { recipe, basket, exit, revenue, expectedProfit, successRate };
        })
        .filter((candidate) => candidate.expectedProfit >= Math.max(MIN_PROFIT, Math.ceil(basket.cost * MIN_RETURN)))
        .sort((a, b) => b.expectedProfit - a.expectedProfit || b.revenue - a.revenue)[0] || null;
}

module.exports = {
    MAX_INPUT_OFFERS, MIN_PROFIT, MIN_RETURN, MAX_WALLET_SHARE, WALLET_RESERVE,
    basketFor, craftMargin, opportunityFor
};
