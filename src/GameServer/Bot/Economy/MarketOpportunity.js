const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const TownNpcCatalog = require('./TownNpcCatalog');
const OfferOrder = require('./OfferOrder');
const OfferQuery = require('./OfferQuery');
const SHOT_IDS = new Set([
    1835, 1463, 1464, 1465, 1466, 1467,
    2509, 2510, 2511, 2512, 2513, 2514,
    3947, 3948, 3949, 3950, 3951, 3952
]);
// These offers are bot purchase plans. The shared accessor only needs this
// price context; resolving a buyer actor here would add a world lookup.
const BOT_PRICE_CONTEXT = Object.freeze({ session: Object.freeze({ botSession: true }) });

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

// NPC stock is catalogue data. Keep a bounded per-item projection rather
// than rescanning every town during each listing/warehouse decision. Prices
// follow the current progression multiplier; actor funds and public offers
// are still read by their own admission paths.
const NPC_OFFER_LIMIT = 256;
const npcOfferItems = new Map();
let npcOfferInputs = null;
let npcOfferTowns = null;
function npcOfferCache(selfId) {
    const inputs = [DataCache.npcSpawns, DataCache.npcs, DataCache.items,
        invoke('GameServer/ProgressionRates').profile().multiplier,
        TownNpcCatalog.rowsForTown, TownNpcCatalog.sellersByTown, NpcShopBuyLists.rowForNpc];
    if (!npcOfferInputs || !inputs.every((value, at) => value === npcOfferInputs[at])) {
        npcOfferInputs = inputs;
        npcOfferItems.clear();
        npcOfferTowns = Object.keys(TownNpcCatalog.sellersByTown());
    }
    const id = Number(selfId);
    let held = npcOfferItems.get(id);
    if (!held) {
        held = { towns: new Map(), all: null };
        if (npcOfferItems.size >= NPC_OFFER_LIMIT) npcOfferItems.delete(npcOfferItems.keys().next().value);
    } else npcOfferItems.delete(id);
    npcOfferItems.set(id, held);
    return held;
}

function npcTownOffers(selfId, town, held) {
    if (held.towns.has(town)) return held.towns.get(town);
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
    for (const offer of offers) Object.freeze(offer);
    Object.freeze(offers);
    if (npcOfferTowns.includes(town)) held.towns.set(town, offers);
    return offers;
}

function npcOffers(selfId, town) {
    if (!require('./ProductionPolicy').allowsNpcShot(selfId)) return [];
    return npcTownOffers(selfId, town, npcOfferCache(selfId)).map(offer => ({ ...offer }));
}

function npcOffersAll(selfId) {
    if (!require('./ProductionPolicy').allowsNpcShot(selfId)) return [];
    const held = npcOfferCache(selfId);
    held.all ||= Object.freeze(npcOfferTowns.flatMap(town => npcTownOffers(selfId, town, held)));
    // Preserve callers' ownership of the returned array and rows.
    return held.all.map(offer => ({ ...offer }));
}

// Group F: ordinary NPC shops stay; configured city supply remains only for
// shots until the dwarves' production chain replaces it in 3.6. Also used at
// execution, so a saved non-shot offer cannot bypass the new routing rule.
function botCanBuy(offer) {
    if (!offer) return false;
    const fixed = offer.sourceType === 'configured_store' || offer.sellerKind === 'fixed'
        || (offer.sourceType === 'private_store' && MerchantStoreConfigs[offer.sourceName]);
    if (offer.sourceType === 'npc' && !require('./ProductionPolicy').allowsNpcShot(offer.selfId)) return false;
    return !fixed || (SHOT_IDS.has(Number(offer.selfId)) && require('./ProductionPolicy').allowsFixedShot(offer.selfId));
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
        price: sellerKind === 'fixed' && SHOT_IDS.has(Number(item.selfId))
            ? invoke('GameServer/Bot/TradeService').storeItemPrice(store, item, BOT_PRICE_CONTEXT)
            : Number(item.price),
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
        const offer = storeOffer(session, store, item, town);
        return botCanBuy(offer) ? [offer] : [];
    });
}

// Fixed bot supply is a shot-only game-data table, built once per rate and
// indexed by item. Player-facing live stores keep their own trade path.
let fixedRate = null;
let fixedRows = null;
let fixedByItem = new Map();
const EMPTY_OFFERS = Object.freeze([]);
function fixedStoreOffers(selfId = null) {
    if (require('./ProductionPolicy').shotsDisabled()) return EMPTY_OFFERS;
    const rate = invoke('GameServer/Bot/Economy/BotEconomyPricing').economyRate();
    if (!fixedRows || fixedRate !== rate) {
        fixedRate = rate;
        fixedByItem = new Map();
        const rows = [];
        const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
        for (const id of SHOT_IDS) {
            const offers = Pricing.sellersOf(id).filter((row) => Number(row.price) > 0).map((row) => {
                const store = MerchantStoreConfigs[row.sourceName];
                return Object.freeze({ ...row, sourceType: 'configured_store', sourceId: row.sourceName,
                    sellerKind: 'fixed', selfId: id, itemName: itemName(id), count: Infinity, available: true,
                    locX: Number(store?.locX || 0), locY: Number(store?.locY || 0), locZ: Number(store?.locZ || 0) });
            });
            fixedByItem.set(id, Object.freeze(offers));
            rows.push(...offers);
        }
        fixedRows = Object.freeze(rows);
    }
    return selfId === null ? fixedRows : fixedByItem.get(Number(selfId)) || EMPTY_OFFERS;
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

// The one offer query (OfferQuery) for a buyer on the main thread: what a
// cold bot can buy without meeting anyone (board records, NPC shops and the
// configured shot merchants; a player's or a bot's live private store trades
// face to face only, E14, E22), in `town`, in each of `towns` or in every
// town (the board and the configured merchants only: an NPC shop is in a
// town), the first in the one order within `budget` that `accept` takes.
function bestOffer(selfId, options = {}) {
    const towns = options.town ? [options.town] : options.towns || null;
    const fixed = fixedStoreOffers(selfId);
    const npc = towns ? towns.flatMap((town) => npcOffers(selfId, town)) : [];
    return OfferQuery.bestSellOffer(AfkTrade.boardIndex(), selfId, {
        towns,
        excludeOwner: options.buyerCharacterId,
        budget: options.budget,
        cost: options.cost,
        accept: (offer) => botCanBuy(offer) && (!options.accept || options.accept(offer)),
        toOffer: AfkTrade.offerOf,
        others: OfferQuery.othersIn(towns, fixed, npc)
    });
}

// The buy records of the board (escrow held), best first in the board's own
// order (BoardIndex.compareLines: the bid, a player before a bot, the record):
// the budget-backed buy stores whose money stayed in the wallet are gone (E24).
function findBuyOffers(selfId, options = {}) {
    const town = options.town || null;
    return AfkTrade.offers(selfId, 3, { town, characterId: options.sellerCharacterId })
        .filter((offer) => offer.available);
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
    const amount = Math.max(1, Number(options.amount) || 1);
    const towns = options.towns || [...new Set([...Object.keys(TownNpcCatalog.sellersByTown()),
        ...fixedStoreOffers(selfId).map((offer) => offer.town), ...AfkTrade.boardIndex().towns(selfId, AfkTrade.SELL)])];
    const cost = options.cost || OfferOrder.tripCost(options.state || { loc: options.origin }, { origin: options.origin });
    return bestOffer(selfId, { ...options, towns,
        cost: cost ? (town) => cost(town) / amount : null,
        accept: (offer) => Number(offer.count) >= amount && Number(offer.price) > 0
            && (!options.accept || options.accept(offer)) });
}

let supplyIds = null;
function supplyItemIds() {
    supplyIds ||= [...new Set([...(NpcShopBuyLists.allEntries?.() || []).map((entry) => Number(entry.selfId)), ...SHOT_IDS]
        .filter(Boolean))];
    return [...new Set([...supplyIds, ...AfkTrade.boardIndex().selfIds(AfkTrade.SELL)])];
}

function resolveSupplyItem(value) {
    const requested = normalizeItemLookup(value);
    if (!requested) return null;
    const candidates = supplyItemIds()
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
    const state = { loc: origin };
    const cost = OfferOrder.tripCost(state, { origin });
    return supplyItemIds()
        .map((selfId) => {
            const offer = bestSupplyOffer(selfId, { origin, state, cost });
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
    if (offer.sourceType === 'configured_store') return botCanBuy(offer);
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
    botCanBuy,
    bestOffer,
    bestBuyOffer,
    activeBuyDemandSelfIds,
    bestSupplyOffer,
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
