
// Prices are x1 at every preset: the adena
// rate multiplies hunt adena only, never a store, fee or buyer price.
function economyRate() {
    return 1;
}

function scalePrice(value, minimum = 1) {
    const price = Math.floor(Math.max(0, Number(value) || 0) * economyRate());
    return Math.max(minimum, price);
}

module.exports = { economyRate, scalePrice };
