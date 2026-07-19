const ProgressionRates = invoke('GameServer/ProgressionRates');

function economyRate() {
    // Adena is the common currency for every bot-to-bot transaction.  Its
    // active server rate keeps private stores and manufacture fees in the same
    // economy as the rewards funding those purchases.
    return Math.max(0.01, Number(ProgressionRates.profile().adena || 1));
}

function scalePrice(value, minimum = 1) {
    const price = Math.floor(Math.max(0, Number(value) || 0) * economyRate());
    return Math.max(minimum, price);
}

module.exports = { economyRate, scalePrice };
