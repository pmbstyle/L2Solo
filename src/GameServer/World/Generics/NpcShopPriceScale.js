// NPC prices are x1 at every preset: a
// server rate multiplies drops and hunt adena, never a shop's price.
function multiplier() {
    return 1;
}

function price(basePrice, progressionMultiplier) {
    const base = Math.max(0, Number(basePrice) || 0);
    if (base === 0) return 0;
    return Math.max(1, Math.round(base * multiplier(progressionMultiplier)));
}

module.exports = { multiplier, price };
