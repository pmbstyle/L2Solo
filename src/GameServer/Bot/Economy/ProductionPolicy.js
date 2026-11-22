'use strict';

// The configured city stores are the players' (our rule, maintainer 2026-11-21): a bot
// buys from them only the hidden reserve rows marked `reserve` (never in the player's
// window): the crafter row, the station trader row and the spoiler scroll row.
// No-grade shots a bot buys from the NPC, graded shots from the crafters (CrafterStock).
// The optional disable switch removes that whole reserve and the crafters' graded shots; ordinary
// NPC stock remains available. Purchases and prices read the same policy through
// OfferQuery.sourceAllowed, FixedShotOffers and TradeService.buyFromStore.
const NO_GRADE_SHOTS = new Set([1835, 2509, 3947]);
// The grade of each graded soulshot, spiritshot and blessed spiritshot (the shot
// templates carry no rank).
const SHOT_GRADE = Object.freeze({
    1463: 'd', 1464: 'c', 1465: 'b', 1466: 'a', 1467: 's',
    2510: 'd', 2511: 'c', 2512: 'b', 2513: 'a', 2514: 's',
    3948: 'd', 3949: 'c', 3950: 'b', 3951: 'a', 3952: 's'
});
const GRADED_SHOTS = new Set(Object.keys(SHOT_GRADE).map(Number));
const SupplierRoles = require('./SupplierRoles');
const config = () => invoke('GameServer/Bot/Population/PopulationConfig');
function buyersDisabled() { return config().staticBuyersDisabled === true; }
function shotsDisabled() { return config().staticShotsDisabled === true; }
// line: a configured store line or an offer of one ({ selfId, reserve, consignment, buyerClasses, buyerRole }).
// A consignment line (a supplier's reserve gear row) sells only to a consignment
// restock (CrafterStock.townOffers: options.consignment), never to a purchase.
// A line naming buyerClasses sells only to a buyer (a bot's state or actor) of one
// of those classes, a line naming buyerRole 'trader' only to a station trader
// (SupplierRoles.isStationTrader: a cold state; the trader restocks cold); without a
// buyer either is refused. A bot buys a reserve row only.
function allowsFixed(line, buyer = null, { consignment = false } = {}) {
    if (line?.consignment && !consignment) return false;
    if (Array.isArray(line?.buyerClasses)
        && !line.buyerClasses.includes(Number(invoke('GameServer/Bot/AI/BotRoles').classIdOf(buyer)))) return false;
    if (line?.buyerRole === 'trader' && !SupplierRoles.isStationTrader(buyer)) return false;
    return !shotsDisabled() && line?.reserve === true;
}
function allowsNpcShot(id) { return !shotsDisabled() || !GRADED_SHOTS.has(Number(id)); }
module.exports = { buyersDisabled, shotsDisabled, allowsFixed, allowsNpcShot, NO_GRADE_SHOTS, GRADED_SHOTS, SHOT_GRADE };
