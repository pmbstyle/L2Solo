'use strict';
// Owner of the layout of the arrays in a bot's published stats packet: what the
// worker's economy build (EconomyContext.forState, statsPacket) publishes, the
// worker message carries and bot_life_state.mindJson saves; read hot and cold,
// on main and in the worker. Every reader and writer of these arrays goes
// through here: their slots and sentinels live only in this file.
//
// stats.money, the money packet (PurchaseFunding.packetFor writes it):
//   [hourAdena, moneyPrice (hours per Adena), survivalReserve, firstUnfundedPrice (the gap's cash, 0 without one),
//    then one (ratio, cumulative, itemId) row per funded queue wish, at most MONEY_ROWS; with more funded
//    wishes the last row merges the tail and carries itemId 0 (FX-E3)].
// stats.stockTargets, the plan's kit targets (EconomyContext.stockTargets writes it):
//   [potionId, potionTarget, shotId, shotTarget, shotCurrentAtBuild, potionSurvivalTarget, gapHorizonHours,
//    shotsCanRestock (1/0), shotSurvivalTarget, scrollHours (-1: the build did not price the scroll)].
//   Rows saved before the restock slots carry 5 or 7 slots and read as such.
// stats.dangerPrice: [deathHours, riskWeight] (DangerRule's weights for the cold fight).
// Values are stored as given: their rounding is the writer's caller's rule.

// The money packet.
const HOUR = 0, PRICE = 1, RESERVE = 2, GAP = 3, QUEUE = 4, ROW = 3;
// The funded rows the money packet keeps (its byte bound).
const MONEY_ROWS = 8;
function money({ hourAdena, moneyPrice, survivalReserve, firstUnfundedPrice }) {
    return [hourAdena, moneyPrice, survivalReserve, firstUnfundedPrice];
}
// Appends a funded wish's row; a packet already holding `rows` rows has its
// last one replaced (the merged tail).
function addFunded(packet, ratio, cumulative, itemId, rows = MONEY_ROWS) {
    if (fundedRows(packet) < rows) packet.push(ratio, cumulative, itemId);
    else { const last = QUEUE + ROW * (rows - 1); packet[last] = ratio; packet[last + 1] = cumulative; packet[last + 2] = itemId; }
    return packet;
}
// A packet with its header (a saved row may be anything else).
const hasMoney = packet => Array.isArray(packet) && packet.length >= QUEUE;
const slot = (packet, at) => Array.isArray(packet) ? packet[at] : undefined;
const hourAdena = packet => slot(packet, HOUR);
const moneyPrice = packet => slot(packet, PRICE);
const survivalReserve = packet => slot(packet, RESERVE);
const firstUnfundedPrice = packet => slot(packet, GAP);
// The packet's complete funded rows, in queue order.
const fundedRows = packet => Array.isArray(packet) ? Math.max(0, Math.floor((packet.length - QUEUE) / ROW)) : 0;
const fundedRatio = (packet, row) => packet[QUEUE + ROW * row];
const fundedCumulative = (packet, row) => packet[QUEUE + ROW * row + 1];
const fundedItem = (packet, row) => packet[QUEUE + ROW * row + 2];
// Writes a row's cumulative into a packet the caller owns (its own copy).
function setFundedCumulative(packet, row, cumulative) {
    packet[QUEUE + ROW * row + 1] = cumulative;
    return packet;
}

// The kit targets row.
const SCROLL_UNPRICED = -1;
function stockTargets({ potionId, potionTarget, shotId, shotTarget, shotCurrentAtBuild, potionSurvivalTarget, gapHorizonHours,
    shotsCanRestock, shotSurvivalTarget, scrollHours }) {
    return [potionId, potionTarget, shotId, shotTarget, shotCurrentAtBuild, potionSurvivalTarget, gapHorizonHours,
        shotsCanRestock ? 1 : 0, shotSurvivalTarget, scrollHours ?? SCROLL_UNPRICED];
}
// The row by name; null without one (fewer than its five first slots).
// complete: the row has the restock slots and finite targets (a row from
// before them serves the sale only). scrollHours: null when unpriced.
function kitRow(row) {
    if (!Array.isArray(row) || row.length < 5) return null;
    return { potionId: row[0], potionTarget: row[1], shotId: row[2], shotTarget: row[3], shotCurrentAtBuild: row[4],
        potionSurvivalTarget: row[5], gapHorizonHours: row[6], shotsCanRestock: row[7] === 1, shotSurvivalTarget: row[8],
        scrollHours: row[9] >= 0 ? row[9] : null,
        complete: row.length >= 10 && [1, 3, 5, 8, 9].every(at => Number.isFinite(row[at])) };
}
// One slot without the row object (read per rest tick and per step).
const potionSurvivalTarget = row => slot(row, 5);
const gapHorizonHours = row => slot(row, 6);

// The danger price.
const dangerPrice = ({ deathHours, riskWeight }) => [deathHours, riskWeight];
const deathHours = row => slot(row, 0);
const riskWeight = row => slot(row, 1);

module.exports = { MONEY_ROWS, money, addFunded, hasMoney, hourAdena, moneyPrice, survivalReserve, firstUnfundedPrice,
    fundedRows, fundedRatio, fundedCumulative, fundedItem, setFundedCumulative,
    stockTargets, kitRow, potionSurvivalTarget, gapHorizonHours, dangerPrice, deathHours, riskWeight };
