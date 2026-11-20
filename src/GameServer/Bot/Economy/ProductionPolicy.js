'use strict';

// The configured city stores are a priced reserve alongside public crafters: a
// store line sells a bot its shots, and the gear lines it marks `reserve` (a
// limited lot of the same item stays the player's). The optional disable switch
// removes that whole reserve and NPC graded shots; ordinary NPC non-shot stock
// remains available. Purchases and prices read the same policy through
// OfferQuery.sourceAllowed, FixedShotOffers and TradeService.buyFromStore.
const NO_GRADE_SHOTS = new Set([1835, 2509, 3947]);
const GRADED_SHOTS = new Set([1463, 1464, 1465, 1466, 1467, 2510, 2511, 2512, 2513, 2514, 3948, 3949, 3950, 3951, 3952]);
const config = () => invoke('GameServer/Bot/Population/PopulationConfig');
function buyersDisabled() { return config().staticBuyersDisabled === true; }
function shotsDisabled() { return config().staticShotsDisabled === true; }
// A valve row (`valve`: its grade) sells a buyer VALVE_PIECES weapons of that grade
// over its life, counted in its stats.valveGear ({ C, B, A }); our rule, bounding
// the worst wait for a crafter's weapon without taking the crafters' trade. Armour
// and jewels stay open at the valve: a bot needs about ten of them a grade, and
// limiting them to one starved the market (run 9fbbc5405: C jewel bids at 3x ref,
// exp per bot-hour of C/B bots -12 %, money growth 2.2 -> 6.6 %/h).
const VALVE_PIECES = 1;
const weaponKinds = new Map();
function limitedValve(line) {
    if (!line?.valve) return false;
    const id = Number(line.selfId);
    if (!weaponKinds.has(id)) {
        const found = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, id);
        weaponKinds.set(id, String(found?.template?.kind || '').startsWith('Weapon.'));
    }
    return weaponKinds.get(id);
}
// The units of a line a buyer may still take: a valve row's remaining pieces, else
// Infinity (without a buyer: a quote, Infinity).
function valveAllowance(line, buyer = null) {
    if (!limitedValve(line) || !buyer) return Infinity;
    return Math.max(0, VALVE_PIECES - Number(buyer.stats?.valveGear?.[line.valve] || 0));
}
// The stats patch a purchase of `units` from a line writes (null: none counted).
function valvePatch(line, buyer, units) {
    if (!limitedValve(line)) return null;
    const counted = buyer?.stats?.valveGear || {};
    return { valveGear: { ...counted, [line.valve]: Number(counted[line.valve] || 0) + Number(units) } };
}
// line: a configured store line or an offer of one ({ selfId, reserve, buyerClasses, valve }).
// A line naming buyerClasses sells only to a buyer (a bot's state or actor) of one
// of those classes; without a buyer it is refused. A valve row refuses a buyer
// whose pieces of its grade are used up.
function allowsFixed(line, buyer = null) {
    const id = Number(line?.selfId);
    if (Array.isArray(line?.buyerClasses)
        && !line.buyerClasses.includes(Number(invoke('GameServer/Bot/AI/BotRoles').classIdOf(buyer)))) return false;
    if (!(valveAllowance(line, buyer) > 0)) return false;
    return !shotsDisabled() && (NO_GRADE_SHOTS.has(id) || GRADED_SHOTS.has(id) || line?.reserve === true);
}
function allowsNpcShot(id) { return !shotsDisabled() || !GRADED_SHOTS.has(Number(id)); }
// The one seller gate of the configured fixed buyers (static_wtb) for a bot: they
// take materials only (the gear goes to players through a private store), and from a
// gnome only (Scavenger, Bounty Hunter, Artisan, Warsmith); every other bot sells its
// materials to the gnomes' buy lines or the NPC. Our rule: the gnomes stand for the
// dwarves a C4 server's material trade ran through. A player is admitted by his
// caller (TradeService.acceptsSellerItem), not here.
// seller: a bot's state or actor; kind: the item's template kind.
const GNOME_SELLERS = new Set([54, 55, 56, 57]);
function sellsToFixedBuyer(seller, kind) {
    return !buyersDisabled() && String(kind || '').startsWith('Other.Material')
        && GNOME_SELLERS.has(Number(invoke('GameServer/Bot/AI/BotRoles').classIdOf(seller)));
}
module.exports = { buyersDisabled, shotsDisabled, allowsFixed, sellsToFixedBuyer, GNOME_SELLERS, valveAllowance, valvePatch, allowsNpcShot, NO_GRADE_SHOTS, GRADED_SHOTS };
