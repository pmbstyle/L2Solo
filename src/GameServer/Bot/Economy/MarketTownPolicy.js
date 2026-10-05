const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');
const DynamicBuyerService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const OfferOrder = require('./OfferOrder');

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

function targetTownForSale(state) {
    // Static buyer stores are the dependable Adena path for harvested
    // resources. Prefer the city that is actually bidding on this inventory;
    // equipment left after that sale may still open a normal private store
    // there. Without this, no-grade local markets can strand materials in a
    // town with no buyer.
    const buyerTown = DynamicBuyerService.bestTownFor(state)?.town || StaticBuyerService.bestTownFor(state)?.town;
    return buyerTown || targetTownForItems(state, ItemDisposition.saleCandidates(state));
}

module.exports = {
    GLUDIO_D_GRADE_SHARE_PERCENT,
    NO_GRADE_MARKETS,
    dGradeMarketFor,
    marketTown,
    nearestNoGradeMarket,
    targetTownForItems,
    targetTownForSale
};
