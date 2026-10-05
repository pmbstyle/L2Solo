const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');
const DynamicBuyerService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const OfferOrder = require('./OfferOrder');
const Karma = require('../../Karma');

const GLUDIO_D_GRADE_SHARE_PERCENT = 15;

// The starter villages and the captured plaza centre their market travel goes to.
const NO_GRADE_MARKETS = Object.freeze(['Talking Island', 'Elven Village', 'Dark Elven Village', 'Orc Village', 'Dwarven Village']
    .map((name) => ({ name, ...ShopPlaces.PLAZAS[name].travelCenter, radius: 12000 })));

// These starter villages are intentionally not all part of TownPathfinder's
// geodata atlas yet. Market travel only needs the captured plaza centre: the
// cold resolver places the actual private store inside its polygon on arrival.
function marketTown(name) {
    const market = NO_GRADE_MARKETS.find((candidate) => candidate.name === name);
    return market && {
        name: market.name,
        center: { locX: market.locX, locY: market.locY, locZ: market.locZ || 0 }
    };
}

function nearestNoGradeMarket(loc = {}) {
    const x = Number(loc.locX || 0);
    const y = Number(loc.locY || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return null;
    return NO_GRADE_MARKETS
        .map((market) => ({ ...market, distance: Math.hypot(x - market.locX, y - market.locY) }))
        .sort((a, b) => a.distance - b.distance)[0] || null;
}

// The grade of an item by the one static classifier (E47,
// MarketCounters.counterOf); a row without an item id keeps its own rank.
function rankOf(item) {
    if (Number(item?.selfId) > 0) return MarketCounters.gradeOf(item.selfId);
    return String(item?.rank || 'none').toLowerCase();
}

function dGradeMarketFor(state = {}) {
    // Gludio's compact D plaza holds roughly one hundred shops once its
    // permanent merchants are reserved.  Dion receives the overflow through
    // a stable character-id split, so bots do not oscillate between towns.
    const bucket = Math.abs(Number(state.characterId || 0)) % 100;
    return bucket < GLUDIO_D_GRADE_SHARE_PERCENT ? 'Gludio' : 'Dion';
}

function targetTownForItems(state, items = []) {
    // A bot with karma trades in Floran (design 5.8, E48).
    if (Karma.closesTowns(state?.stats?.karma)) return Karma.TOWN_NAME;
    const ranks = items.map(rankOf);
    const hasHigherGrade = ranks.some((rank) => ['c', 'b', 'a', 's'].includes(rank));
    const hasDGrade = ranks.includes('d');
    const onlyNoGrade = ranks.length > 0 && ranks.every((rank) => rank === 'none');
    // No-grade stock belongs to the starter village nearest the bot's actual
    // farming location. Early hunting routes legitimately extend beyond a
    // village's immediate square, so a small-radius check funnels Elven,
    // Dark Elven, and Talking Island sellers into Giran incorrectly.
    // The farming location is the centre of the hunting spot: the bot's own
    // position wanders across village areas while it hunts, and following it
    // moved a listed shop between villages on nearly every review.
    if (onlyNoGrade) {
        const origin = OfferOrder.farmingOrigin(state, (spotId) => SpotService.findById(spotId));
        return nearestNoGradeMarket(origin)?.name || 'Giran';
    }
    if (!hasHigherGrade && hasDGrade) return dGradeMarketFor(state);
    return 'Giran';
}

// Where a bot opens its shop (б7, Q6, user 2026-10-05): one weighted roll
// (PriceDecision.chooseByWeight) at the decision to open, over the towns
// with shop places, by the value
// the shop would see there less the trip: each item's listed value (price x
// count) times the share of its counter's buyers in that town
// (MarketCounters.townDemand), minus the bot's round trip to the town. A
// counter with no deals yet takes the author's grade table
// (targetTownForItems) as its whole share: the seed of a young world. A bot
// with karma opens in Floran. O(items x towns), at an opening only.
function shopTown(state, items = [], { tripCost = null, timestamp = Date.now(), rollKey = null } = {}) {
    if (Karma.closesTowns(state?.stats?.karma)) return Karma.TOWN_NAME;
    const towns = Object.keys(ShopPlaces.PLAZAS);
    const values = new Map(towns.map((town) => [town, 0]));
    for (const item of items) {
        const worth = Math.max(0, Number(item.price) || 0) * Math.max(1, Number(item.count) || 1);
        if (!(worth > 0)) continue;
        const demand = MarketCounters.townDemand(MarketCounters.counterOf(item.selfId), timestamp);
        let total = 0;
        for (const entry of demand) total += entry.perHour;
        if (!(total > 0)) {
            const seed = targetTownForItems(state, [item]);
            if (values.has(seed)) values.set(seed, values.get(seed) + worth);
            continue;
        }
        for (const entry of demand) {
            if (values.has(entry.town)) values.set(entry.town, values.get(entry.town) + worth * entry.perHour / total);
        }
    }
    // The bot's round trip there (none to the town it is shopping in).
    const trip = tripCost || invoke('GameServer/Bot/Economy/ColdMarketService').tripFrom(state, timestamp);
    const options = towns.map((town) => ({ action: town, value: values.get(town) - trip(town) }));
    const chosen = invoke('GameServer/Bot/Economy/PriceDecision').chooseByWeight(options,
        rollKey || ['shop_town', Number(state?.characterId || 0), timestamp]);
    return chosen?.action || targetTownForItems(state, items);
}

// The town a bot without a shop opens one in: the decision it already made
// (stats.shopTown, kept until it is back on its spot) or a new roll
// (shopTown). Returns { town, shopTown } with shopTown the decision to keep
// when one was made now.
function openingTown(state, items, timestamp = Date.now()) {
    if (state?.stats?.shopTown?.town) return { town: state.stats.shopTown.town, shopTown: null };
    const town = shopTown(state, items, { timestamp });
    return { town, shopTown: { town, at: timestamp } };
}

// Where a bot's sale trip goes: the town of a buyer bidding on its bag (the
// static and buy-ad buyers, until step 3.6); else the town of its shop, which
// never moves (N51, E46); else the town its shop will open in (openingTown).
function saleTown(state, timestamp = Date.now()) {
    if (Karma.closesTowns(state?.stats?.karma)) return { town: Karma.TOWN_NAME, shopTown: null };
    const buyerTown = DynamicBuyerService.bestTownFor(state)?.town || StaticBuyerService.bestTownFor(state)?.town;
    if (buyerTown) return { town: buyerTown, shopTown: null };
    const shop = invoke('GameServer/AfkTrade/AfkTradeService').findOwnerProjection(state?.characterId)?.shop;
    if (shop?.town) return { town: shop.town, shopTown: null };
    return openingTown(state, ItemDisposition.saleCandidates(state), timestamp);
}

function targetTownForSale(state) {
    return saleTown(state).town;
}

module.exports = {
    GLUDIO_D_GRADE_SHARE_PERCENT,
    NO_GRADE_MARKETS,
    dGradeMarketFor,
    marketTown,
    nearestNoGradeMarket,
    openingTown,
    saleTown,
    shopTown,
    targetTownForItems,
    targetTownForSale
};
