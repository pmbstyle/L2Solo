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
// stats.kitRates, the build's kit rates (EconomyContext.kitRates writes it; EconomyContext.kitReader
// computes the amounts from them over the live bag, wallet and prices):
//   [shotId (the shot the verdict was judged for), shotUse (the spot's shots per hour), shotBenefit (hours per unit),
//    shot verdict (0: shots do not pay, 1: the bot fires the shots it holds, 2: a restock pays too), potionId,
//    potionUse (survival drinks per hour), potionRestUse (rest bottles per hour, RestPotion), potionBenefit (hours
//    per unit), scrollHours (-1: the build did not price the scroll), outingHours, gapHorizonHours].
//   A row of another length (the old stockTargets) reads as none. Rounded by roundRates (below), which the build
//   reads too: the row moves with a real change of a rate, not with every loot pickup.
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

// The kit rates row.
const SCROLL_UNPRICED = -1, RATES = 11;
const SHOT_USE = 1, VERDICT = 3, POTION_USE = 5, OUTING = 9, HORIZON = 10;
// The precision a decision reads: rates, benefits and horizons to three
// significant digits, the outing to a tenth of an hour (a target moves by a
// tenth of an hour's use). The build rounds its own rates with it before it reads them.
const significant = value => Number.isFinite(value) && value !== 0 ? Number(value.toPrecision(3)) : value;
function roundRates(rates) {
    return { ...rates, shotUse: significant(rates.shotUse), shotBenefit: significant(rates.shotBenefit),
        potionUse: significant(rates.potionUse), potionRestUse: significant(rates.potionRestUse),
        potionBenefit: significant(rates.potionBenefit), outingHours: Math.round(rates.outingHours * 10) / 10,
        ...(rates.scrollHours == null ? {} : { scrollHours: significant(rates.scrollHours) }),
        ...(rates.gapHorizonHours === undefined ? {} : { gapHorizonHours: significant(rates.gapHorizonHours) }) };
}
function kitRates(named) {
    const { shotId, shotUse, shotBenefit, shotsPay, shotsCanRestock, potionId, potionUse, potionRestUse, potionBenefit,
        scrollHours, outingHours, gapHorizonHours } = roundRates(named);
    return [shotId, shotUse, shotBenefit, shotsCanRestock ? 2 : shotsPay ? 1 : 0, potionId, potionUse, potionRestUse,
        potionBenefit, scrollHours ?? SCROLL_UNPRICED, outingHours, gapHorizonHours];
}
// A row is its length with its two item ids (a saved value may be null: JSON keeps no Infinity).
const isRates = row => Array.isArray(row) && row.length === RATES && Number.isFinite(row[0]) && Number.isFinite(row[4]);
// The row by name; null without one. scrollHours: null when unpriced.
function ratesOf(row) {
    if (!isRates(row)) return null;
    return { shotId: row[0], shotUse: row[SHOT_USE], shotBenefit: row[2], shotsPay: row[VERDICT] >= 1,
        shotsCanRestock: row[VERDICT] === 2, potionId: row[4],
        potionUse: row[POTION_USE], potionRestUse: row[6], potionBenefit: row[7], scrollHours: Number(row[8]) >= 0 ? row[8] : null,
        outingHours: row[OUTING], gapHorizonHours: row[HORIZON] };
}
// One value without the row object (read per rest tick and per step); undefined without a row.
// lineOf: a kind's line, one hour of its use (the survival drinks for potions; no shots that do not pay).
const lineOf = (row, kind) => !isRates(row) ? undefined : kind === 'shots' && !(row[VERDICT] >= 1) ? 0
    : Math.ceil(Math.max(0, Number(row[kind === 'shots' ? SHOT_USE : POTION_USE]) || 0));
const outingHours = row => isRates(row) ? row[OUTING] : undefined;
const gapHorizonHours = row => isRates(row) ? row[HORIZON] : undefined;

// The danger price.
const dangerPrice = ({ deathHours, riskWeight }) => [deathHours, riskWeight];
const deathHours = row => slot(row, 0);
const riskWeight = row => slot(row, 1);

module.exports = { MONEY_ROWS, money, addFunded, hasMoney, hourAdena, moneyPrice, survivalReserve, firstUnfundedPrice,
    fundedRows, fundedRatio, fundedCumulative, fundedItem, setFundedCumulative,
    kitRates, roundRates, roundRate: significant, ratesOf, lineOf, outingHours, gapHorizonHours, dangerPrice, deathHours, riskWeight };
