// The order in which a buyer considers sell offers (U20, б5). Used by the main
// thread and the planning workers, so it reads only static tables (the towns,
// the gatekeeper routes) and the buyer's own state.
const { towns } = require('../../World/TownRespawn');
const ColdTrip = require('../Population/ColdTrip');

const townByName = new Map(Object.values(towns).map((town) => [town.name, town]));
const HOUR_MS = 60 * 60 * 1000;

// Distance from the buyer to the offer's town; Infinity when either is unknown.
function townDistance(offer, origin) {
    const town = townByName.get(offer?.town);
    const x = Number(origin?.locX);
    const y = Number(origin?.locY);
    // Life states persist an unknown location as 0,0.
    if (!town || !Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return Infinity;
    return Math.hypot(town.locX - x, town.locY - y);
}

// A bot's farming place: the centre of the spot it hunts on (the spot it
// left, for a bot listed at the market), else its departure point or its
// position. The position wanders across the spot while the bot hunts, so a
// choice made from it would flip between two near towns.
function farmingOrigin(state, findSpot) {
    const spotId = state?.stats?.marketReturn?.spotId || state?.spotId;
    const center = spotId ? findSpot(spotId)?.center : null;
    return center || state?.stats?.marketReturn?.loc || state?.loc;
}

// Towns with the same tax sell an NPC item at the same price. Such a tie
// goes to the town nearest the buyer; equal distances, or a buyer without a
// location, keep the caller's order.
function compareDistance(left, right, origin) {
    const leftDistance = townDistance(left, origin);
    const rightDistance = townDistance(right, origin);
    if (leftDistance === rightDistance) return 0;
    return leftDistance < rightDistance ? -1 : 1;
}

function fromPlayer(offer) {
    return offer.playerPriority === true || offer.sellerKind === 'player';
}

// What the trip to each town costs the buyer in Adena (б5): the trip's time at
// the buyer's hour value plus the gatekeeper fee, for a trip from `origin` (its
// farming place, else its position) as the bot's trip builder plans it
// (ColdTrip.townPlan). A function of the town's name, each town computed once;
// null for a buyer without a location (no trip to weigh). A town no gatekeeper
// route reaches costs Infinity.
function tripCost(state, { origin = null, timestamp = Date.now() } = {}) {
    const from = origin || state?.loc;
    if (!state || !from || (!Number(from.locX) && !Number(from.locY))) return null;
    const traveller = from === state.loc ? state : { ...state, loc: from };
    const hour = invoke('GameServer/Bot/AI/BotHuntEfficiency').hourValue(state, timestamp).perHour;
    const costs = new Map();
    return (townName) => {
        if (!townName) return 0;
        if (!costs.has(townName)) {
            const town = townByName.get(townName);
            const plan = town ? ColdTrip.townPlan(traveller, town) : null;
            costs.set(townName, plan ? Math.round(plan.durationMs / HOUR_MS * hour) + Number(plan.route.fee || 0) : Infinity);
        }
        return costs.get(townName);
    };
}

// The price an offer costs the buyer: its price and the trip to its town.
function landedPrice(offer, cost) {
    return Number(offer.price) + (cost ? cost(offer.town) : 0);
}

function compareIds(left, right) {
    const leftId = Number(left);
    const rightId = Number(right);
    if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
    return String(left ?? '').localeCompare(String(right ?? ''));
}

// The one order of offers for every buyer: the price plus the trip to the
// offer's town (`cost`, from tripCost; none for a buyer that does not travel)
// first; at the same cost a player before a bot, an NPC last; then a stable
// id (the board record and line, the town, the seller).
function compareOffers(left, right, cost = null) {
    const leftPrice = landedPrice(left, cost);
    const rightPrice = landedPrice(right, cost);
    return (leftPrice === rightPrice ? 0 : leftPrice < rightPrice ? -1 : 1)
        || Number(fromPlayer(right)) - Number(fromPlayer(left))
        || Number(left.sourceType === 'npc') - Number(right.sourceType === 'npc')
        || compareIds(left.recordId ?? 0, right.recordId ?? 0)
        || compareIds(left.lineId ?? 0, right.lineId ?? 0)
        || String(left.town || '').localeCompare(String(right.town || ''))
        || compareIds(left.sourceId, right.sourceId);
}

// The first offer in the one order, of those within `budget`.
function best(offers, { budget = Infinity, cost = null } = {}) {
    let chosen = null;
    for (const offer of offers) {
        if (!offer || offer.available === false || !(Number(offer.price) <= budget)) continue;
        if (!chosen || compareOffers(offer, chosen, cost) < 0) chosen = offer;
    }
    return chosen;
}

// A companion's supply errand: cheaper first; at the same price an NPC
// before a configured store, since NPC stock never runs out; then the town
// nearest the buyer.
function compareSupplyOffers(left, right, origin) {
    return Number(left.price) - Number(right.price)
        || Number(left.sourceType !== 'npc') - Number(right.sourceType !== 'npc')
        || compareDistance(left, right, origin);
}

module.exports = { best, compareDistance, compareOffers, compareSupplyOffers, farmingOrigin, landedPrice, tripCost };
