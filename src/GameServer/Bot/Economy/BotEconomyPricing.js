const ProgressionRates = invoke('GameServer/ProgressionRates');

// The server's Adena rate multiplies every player-like price as it multiplies
// hunt Adena: configured bot stores (sell, buy, reserve and crafter rows), the
// fixed buy lines, crafter material bids, craft fees and bot deal references, so
// a bot's store spend keeps its x1 share of its hunt income at every preset. An NPC shop and
// the NPC buy-back stay at the C4 datapack price (NpcShopPriceScale, NpcSellRules).
// Hot and cold read this one function.
function economyRate() {
    return Math.max(0.01, Number(ProgressionRates.profile().adena || 1));
}

// C4 writes a store price and the Adena count as 32-bit fields (PrivateStoreListSell
// writeD(row.price), writeD(fetchTotalAdena())): no price a client sees passes it.
const MAX_ADENA = 2147483647;
function scalePrice(value, minimum = 1) {
    const price = Math.floor(Math.max(0, Number(value) || 0) * economyRate());
    return Math.min(MAX_ADENA, Math.max(minimum, price));
}

module.exports = { MAX_ADENA, economyRate, scalePrice };
