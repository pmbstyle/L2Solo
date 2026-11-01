'use strict';

// A production certificate is derived from a freshly priced complete basket,
// never from the saved spending cap or the fact that a journey was started.
function purchaseIntent(opportunity, line, count, town) {
    if (!opportunity || !Number.isSafeInteger(count) || count <= 0 || Number(line.enchant || 0) !== 0
        || !(Number(opportunity.valueHours) > 0) || !Number.isFinite(opportunity.valueHours)
        || !(Number(opportunity.r) > 0) || !Number.isFinite(opportunity.r)) return null;
    const purchase = opportunity.basket?.purchases?.find(row => Number(row.selfId) === Number(line.selfId)
        && row.town === town);
    if (!purchase || Number(purchase.count) < count) return null;
    const selected = (purchase.lines || []).filter(row => Number(row.line?.recordId) === Number(line.adId)
        && Number(row.line?.revision ?? row.line?.expectedRevision) === Number(line.adRevision)
        && Number(row.price) === Number(line.price));
    if (selected.reduce((sum, row) => sum + Number(row.count || 0), 0) < count) return null;
    const recipeId = Number(opportunity.recipe?.recipeId);
    if (!Number.isSafeInteger(recipeId) || recipeId <= 0) return null;
    return { itemId: Number(line.selfId), amount: count, price: Number(line.price),
        key: `production:${recipeId}`, recipeId, valueHours: Number(opportunity.valueHours),
        valueRate: require('./PurchaseFunding').significant(Number(opportunity.r)) };
}

module.exports = { purchaseIntent };
