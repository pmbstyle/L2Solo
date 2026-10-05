const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const TradeService = invoke('GameServer/Bot/TradeService');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const TownNpcCatalog = require('./TownNpcCatalog');
const OfferOrder = require('./OfferOrder');
const OfferQuery = require('./OfferQuery');
const SHOT_IDS = new Set([
    1835, 1463, 1464, 1465, 1466, 1467,
    2509, 2510, 2511, 2512, 2513, 2514,
    3947, 3948, 3949, 3950, 3951, 3952
]);

function itemName(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId)?.template?.name || `Item ${selfId}`;
}

function normalizeItemLookup(value) {
    const normalized = String(value || '')
        .toLowerCase()
        .replace(/soulshots?/g, 'soulshot')
        .replace(/spiritshots?/g, 'spiritshot')
        .replace(/blessed\s+spiritshot/g, 'blessed_spiritshot')
        .replace(/no\s*grade/g, 'no_grade')
        .replace(/([a-z])\s*[- ]\s*grade/g, '$1_grade')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');

    // Players commonly put the grade before the item family (“D-grade
    // soulshots”), while the C4 item names put it after the family. Keep one
    // canonical form so both phrasings resolve to the same catalog entry.
    return normalized
        .replace(/^no_grade_(blessed_)?spiritshot$/, '$1spiritshot_no_grade')
        .replace(/^no_grade_soulshot$/, 'soulshot_no_grade')
        .replace(/^([a-z])_grade_(blessed_)?spiritshot$/, '$2spiritshot_$1_grade')
        .replace(/^([a-z])_grade_soulshot$/, 'soulshot_$1_grade')
        .replace(/^grade_([a-z])_(blessed_)?spiritshot$/, '$2spiritshot_$1_grade')
        .replace(/^grade_([a-z])_soulshot$/, 'soulshot_$1_grade');
}

function npcOffers(selfId, town) {
    const offers = [];
    const seen = new Set();
    TownNpcCatalog.rowsForTown(town).forEach((seller) => {
        const npcSelfId = Number(seller.npcSelfId);
        const row = NpcShopBuyLists.rowForNpc(npcSelfId, selfId);
        if (!row) return;
        const price = Number(row.price || 0);
        const key = `${npcSelfId}:${price}:${seller.locX}:${seller.locY}:${seller.locZ}`;
        if (seen.has(key)) return;
        seen.add(key);
        offers.push({
            sourceType: 'npc',
            sourceId: npcSelfId,
            sourceName: seller.name,
            town,
            locX: Number(seller.locX),
            locY: Number(seller.locY),
            locZ: Number(seller.locZ),
            selfId: Number(selfId),
            itemName: itemName(selfId),
            price,
            count: Infinity,
            available: price > 0
        });
    });
    return offers;
}

function npcOffersAll(selfId) {
    return Object.keys(TownNpcCatalog.sellersByTown()).flatMap((town) => npcOffers(selfId, town));
}

function configuredStoreSession(storeName) {
    const sessions = World.user?.sessions;
    if (!Array.isArray(sessions)) return null;
    return sessions.find((session) => {
        const actor = session?.actor;
        const store = actor?.fetchPrivateStore?.();
        return actor?.fetchName?.() === storeName && Number(store?.storeType) === 1;
    }) || null;
}

function configuredStoreOffers(selfId) {
    return Object.entries(MerchantStoreConfigs)
        .flatMap(([storeName, store]) => {
            if (store?.storeType !== 1 || !store.town) return [];
            const liveSession = configuredStoreSession(storeName);
            const liveStore = liveSession?.actor?.fetchPrivateStore?.();
            // In a running world, a configured offer is valid only when the
            // actual merchant bot is spawned and still has the item.  The
            // config-only fallback keeps lightweight catalog/unit fixtures
            // usable before World.init(), but purchase execution never trusts
            // that fallback as a live source.
            const line = liveStore
                ? (liveStore.items || []).find((entry) => Number(entry.selfId) === Number(selfId) && Number(entry.count) > 0)
                : (Array.isArray(World.user?.sessions) ? null : (store.items || []).find((entry) => Number(entry.selfId) === Number(selfId) && Number(entry.count) > 0));
            if (!line) return [];
            const price = liveStore ? Number(line.price) : TradeService.ratedPrice(selfId, line.priceRate ?? 1);
            if (price <= 0) return [];
            const actor = liveSession?.actor;
            return [{
                sourceType: 'configured_store',
                sourceId: actor ? Number(actor.fetchId?.() || 0) : storeName,
                sourceName: actor?.fetchName?.() || storeName,
                town: store.town,
                selfId: Number(selfId),
                itemName: itemName(selfId),
                price,
                count: Number(line.count),
                available: true,
                live: !!liveStore,
                locX: Number(actor?.fetchLocX?.() ?? store.locX ?? 0),
                locY: Number(actor?.fetchLocY?.() ?? store.locY ?? 0),
                locZ: Number(actor?.fetchLocZ?.() ?? store.locZ ?? 0),
                storeConfig: store,
                session: liveSession || undefined,
                store: liveStore || undefined,
                storeItem: liveStore ? line : undefined
            }];
        });
}

// A live private store's line as an offer: a configured city merchant is
// 'fixed', else a bot's or a player's.
function storeOffer(session, store, item, town) {
    const actor = session.actor;
    const actorName = actor.fetchName?.() || session.name || 'Private Store';
    const sellerKind = MerchantStoreConfigs[actorName]
        ? 'fixed'
        : String(session.accountId || '').startsWith('bot_')
            ? 'bot'
            : 'player';
    return {
        sourceType: 'private_store',
        sourceId: Number(actor.fetchId?.() || 0),
        sourceName: actorName,
        sellerKind,
        town: store.town || town || null,
        selfId: Number(item.selfId),
        itemName: itemName(item.selfId),
        price: Number(item.price),
        count: Number(item.count),
        available: true,
        session,
        store,
        storeItem: item
    };
}

function sellingStore(session) {
    const store = session?.actor?.fetchPrivateStore?.();
    return store && Number(store.storeType) === 1 ? store : null;
}

function privateOffers(selfId, town) {
    return (World.user?.sessions || []).flatMap((session) => {
        const store = sellingStore(session);
        if (!store) return [];
        if (town && store.town && store.town !== town) return [];
        const item = (store.items || []).find((entry) => Number(entry.selfId) === Number(selfId) && Number(entry.count) > 0);
        if (!item || Number(item.price) <= 0) return [];
        return [storeOffer(session, store, item, town)];
    });
}

// Every line of the configured city merchants' live stores, in one pass over
// the sessions (the clan planning worker gets them with its plan).
function fixedStoreOffers() {
    const offers = [];
    for (const session of World.user?.sessions || []) {
        const store = sellingStore(session);
        if (!store) continue;
        for (const item of store.items || []) {
            if (Number(item.count) <= 0 || Number(item.price) <= 0) continue;
            const offer = storeOffer(session, store, item, null);
            if (offer.sellerKind !== 'fixed') break;
            offers.push(offer);
        }
    }
    return offers;
}

// What a cold bot can buy without meeting anyone: board records, NPC shops
// and the configured city merchants. A player's or a bot's live private
// store trades face to face only (E14, E22): a cold bot never buys from it
// remotely.
function sellOfferCandidates(selfId, options = {}) {
    const town = options.town || null;
    return [
        ...AfkTrade.offers(selfId, 1, { town, characterId: options.buyerCharacterId }),
        ...privateOffers(selfId, town).filter((offer) => offer.sellerKind === 'fixed'),
        ...(town ? npcOffers(selfId, town) : [])
    ].filter((offer) => offer.available);
}

// Every candidate in the one order (OfferOrder.compareOffers); options.cost
// is the buyer's trip cost (OfferOrder.tripCost).
function findOffers(selfId, options = {}) {
    return sellOfferCandidates(selfId, options)
        .sort((a, b) => OfferOrder.compareOffers(a, b, options.cost));
}

function hotOffers(selfId, options = {}) {
    const town = options.town || null;
    return [
        ...AfkTrade.offers(selfId, 1, { town, characterId: options.buyerCharacterId }),
        ...privateOffers(selfId, town),
        ...(town ? npcOffers(selfId, town) : [])
    ].filter((offer) => offer.available)
        .sort((left, right) => OfferOrder.compareOffers(left, right, options.cost));
}

// The one offer query (OfferQuery) for a buyer on the main thread: the same
// sources as sellOfferCandidates, in `town`, in each of `towns` or in every
// town (the board and the configured merchants only: an NPC shop is in a
// town), the first in the one order within `budget` that `accept` takes.
function bestOffer(selfId, options = {}) {
    const towns = options.town ? [options.town] : options.towns || null;
    const fixed = privateOffers(selfId, towns?.length === 1 ? towns[0] : null)
        .filter((offer) => offer.sellerKind === 'fixed');
    const npc = towns ? towns.flatMap((town) => npcOffers(selfId, town)) : [];
    return OfferQuery.bestSellOffer(AfkTrade.boardIndex(), selfId, {
        towns,
        excludeOwner: options.buyerCharacterId,
        budget: options.budget,
        cost: options.cost,
        accept: options.accept,
        toOffer: AfkTrade.offerOf,
        others: OfferQuery.othersIn(towns, fixed, npc)
    });
}

// The buy records of the board (escrow held): the budget-backed buy stores
// whose money stayed in the wallet are gone (E24).
function findBuyOffers(selfId, options = {}) {
    const town = options.town || null;
    return AfkTrade.offers(selfId, 3, { town, characterId: options.sellerCharacterId })
        .filter((offer) => offer.available)
        .sort((left, right) => right.price - left.price
            || Number(right.playerPriority === true) - Number(left.playerPriority === true)
            || left.sourceId - right.sourceId);
}

function bestBuyOffer(selfId, options = {}) {
    return findBuyOffers(selfId, options)[0] || null;
}

function activeBuyDemandSelfIds() {
    return AfkTrade.activeDemandSelfIds();
}

// A companion may leave the field for the city that actually sells the
// requested item.  Checking only the geographically nearest town made a
// valid item look impossible whenever its NPC list lived elsewhere.
function bestSupplyOffer(selfId, options = {}) {
    const budget = Number.isFinite(Number(options.budget)) ? Number(options.budget) : Infinity;
    const amount = Math.max(1, Number(options.amount) || 1);
    // A companion supply errand uses a server-owned NPC or configured city
    // merchant. Dynamic private/cold offers remain available to the market
    // planner and are never guessed as a guaranteed supply source.
    const offers = [...npcOffersAll(selfId), ...configuredStoreOffers(selfId)];
    return offers
        .filter((offer) => offer.available && Number(offer.price) <= budget &&
            (offer.sourceType === 'npc' || Number(offer.count) >= amount))
        .sort((a, b) => OfferOrder.compareSupplyOffers(a, b, options.origin))[0] || null;
}

function resolveSupplyItem(value) {
    const requested = normalizeItemLookup(value);
    if (!requested) return null;
    const candidates = [...new Set([
        ...(NpcShopBuyLists.allEntries?.() || []).map((entry) => Number(entry.selfId)),
        ...Object.values(MerchantStoreConfigs)
            .filter((store) => store?.storeType === 1)
            .flatMap((store) => (store.items || []).map((entry) => Number(entry.selfId)))
    ].filter(Boolean))]
        .map((selfId) => ({ selfId, name: itemName(selfId), normalized: normalizeItemLookup(itemName(selfId)) }))
        .filter((entry) => entry.normalized);

    const exact = candidates.find((entry) => entry.normalized === requested);
    if (exact) return exact;

    // Chat often omits punctuation or uses “shots” for the singular item
    // family. Accept a unique token-contained match, but never guess between
    // grades or unrelated items.
    const matches = candidates.filter((entry) => entry.normalized.includes(requested) || requested.includes(entry.normalized));
    return matches.length === 1 ? matches[0] : null;
}

function supplyCatalog(limit = 96, origin = null) {
    const ids = [...new Set([
        ...(NpcShopBuyLists.allEntries?.() || []).map((entry) => Number(entry.selfId)),
        ...Object.values(MerchantStoreConfigs)
            .filter((store) => store?.storeType === 1)
            .flatMap((store) => (store.items || []).map((entry) => Number(entry.selfId)))
    ].filter(Boolean))];
    return ids
        .map((selfId) => {
            const offer = [...npcOffersAll(selfId), ...configuredStoreOffers(selfId)]
                .sort((a, b) => OfferOrder.compareSupplyOffers(a, b, origin))[0];
            return offer ? {
                selfId,
                name: offer.itemName,
                price: Number(offer.price),
                town: offer.town
            } : null;
        })
        .filter(Boolean)
        .sort((a, b) => Number(SHOT_IDS.has(b.selfId)) - Number(SHOT_IDS.has(a.selfId)) || a.name.localeCompare(b.name))
        .slice(0, Math.max(1, Number(limit) || 96));
}

// Where a hot bot goes to deal with an offer: a stall's actor (a shop, a
// live private store), or a board record without a stall (an ad), dealt
// with by record at its place (D6: hot bots take ads by records like cold
// ones). { actorId, recordId, sourceId, name, locX, locY, locZ, town }.
function offerTarget(offer, town = null) {
    const actor = offer?.projection?.actor || offer?.session?.actor || null;
    return {
        actorId: actor ? Number(actor.fetchId()) : null,
        recordId: actor ? null : Number(offer.recordId || 0) || null,
        sourceId: Number(offer.sourceId || 0),
        name: offer.sourceName || actor?.fetchName?.() || 'Trader',
        locX: Number(actor ? actor.fetchLocX() : offer.locX),
        locY: Number(actor ? actor.fetchLocY() : offer.locY),
        locZ: Number(actor ? actor.fetchLocZ() : offer.locZ),
        town: offer.town || town || null
    };
}

function reserve(offer, qty = 1) {
    const count = Math.max(1, Number(qty) || 1);
    if (!offer?.available || Number(offer.price) <= 0) return false;
    if (offer.sourceType === 'npc') return true;
    if (['afk_player_store', 'afk_bot_store'].includes(offer.sourceType)) return Number(offer.count) >= count;
    if (offer.sourceType !== 'private_store' || !offer.storeItem) return false;
    if (Number(offer.storeItem.count) < count || Number(offer.storeItem.price) !== Number(offer.price)) return false;
    offer.storeItem.count -= count;
    offer.count = offer.storeItem.count;
    return true;
}

function release(offer, qty = 1) {
    if (['afk_player_store', 'afk_bot_store'].includes(offer?.sourceType)) return;
    if (offer?.sourceType !== 'private_store' || !offer.storeItem) return;
    offer.storeItem.count += Math.max(1, Number(qty) || 1);
    offer.count = offer.storeItem.count;
}

module.exports = {
    sellOfferCandidates,
    bestOffer,
    bestBuyOffer,
    activeBuyDemandSelfIds,
    bestSupplyOffer,
    findOffers,
    hotOffers,
    findBuyOffers,
    fixedStoreOffers,
    npcOffers,
    npcOffersAll,
    normalizeItemLookup,
    privateOffers,
    resolveSupplyItem,
    supplyCatalog,
    offerTarget,
    release,
    reserve
};

Object.defineProperty(module.exports, 'TOWN_NPC_SELLERS', {
    enumerable: true,
    get: () => TownNpcCatalog.sellersByTown()
});
