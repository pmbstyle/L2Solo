'use strict';
// The bots' stand-in supply and the windows that read its flow (a crafter's restock
// pace, the spoilers' scroll stock, the trade demand window, the craft-route stall
// budget) are tuned at x50 and follow the server's drop rate from there, as the drops
// they stand for do: at x1 a crafter stocks a fiftieth of what it stocks at x50 per
// hour, while the world levels fifty times slower. Our rule.
const SUPPLY_TUNED_RATE = 50;
function supplyScale() {
    return invoke('GameServer/ProgressionRates').profile().drop / SUPPLY_TUNED_RATE;
}
module.exports = { supplyScale };
