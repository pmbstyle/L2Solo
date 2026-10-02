const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const DataCache = invoke('GameServer/DataCache');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');
const DynamicBuyerService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const OfferOrder = require('./OfferOrder');

const GLUDIO_D_GRADE_SHARE_PERCENT = 15;
let rankIndexSource = null;
let rankIndexSize = -1;
let rankBySelfId = new Map();
let kindBySelfId = new Map();
let materialRanksBySelfId = new Map();

const NO_GRADE_MARKETS = Object.freeze([
    { name: 'Talking Island', locX: -84700, locY: 244200, radius: 12000 },
    { name: 'Elven Village', locX: 46600, locY: 49700, radius: 12000 },
    { name: 'Dark Elven Village', locX: 12700, locY: 16600, radius: 12000 },
    { name: 'Orc Village', locX: -44600, locY: -112400, locZ: -240, radius: 12000 },
    { name: 'Dwarven Village', locX: 115440, locY: -178580, locZ: -920, radius: 12000 }
]);

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

function rankOf(item) {
    const selfId = Number(item?.selfId || 0);
    const items = DataCache.items || [];
    if (rankIndexSource !== items || rankIndexSize !== items.length) {
        rankIndexSource = items;
        rankIndexSize = items.length;
        rankBySelfId = new Map(items.map((candidate) => [Number(candidate.selfId), candidate?.etc?.rank || 'none']));
        kindBySelfId = new Map(items.map((candidate) => [Number(candidate.selfId), candidate?.template?.kind || '']));
        materialRanksBySelfId = new Map();
        Object.values(C4RecipeItems.loadRecipeItems()).forEach((recipe) => {
            const productRank = String(rankBySelfId.get(Number(recipe.productId)) || 'none').toLowerCase();
            (recipe.materials || []).forEach((material) => {
                const id = Number(material.selfId);
                if (!materialRanksBySelfId.has(id)) materialRanksBySelfId.set(id, new Set());
                materialRanksBySelfId.get(id).add(productRank);
            });
        });
    }
    const directRank = String(item?.rank || rankBySelfId.get(selfId) || 'none').toLowerCase();
    if (directRank !== 'none') return directRank;
    if (ItemDisposition.isMarketRecipeItem(item)) return ItemDisposition.recipeProductRank(item);
    const kind = String(item?.kind || kindBySelfId.get(selfId) || '');
    if (!kind.startsWith('Other.Material')) return directRank;
    const productRanks = materialRanksBySelfId.get(selfId);
    // A part used for one equipment grade follows that grade. Shared crafting
    // resources keep their no-grade routing because they serve many tiers.
    return productRanks?.size === 1 ? [...productRanks][0] : directRank;
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
