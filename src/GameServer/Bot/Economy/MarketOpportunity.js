const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const TradeService = invoke('GameServer/Bot/TradeService');

const TOWN_NPC_SELLERS = {
    Giran: [7081, 7082, 7084, 7085, 7087, 7088, 7090, 7091, 7093, 7094, 7829],
    Oren: [7178, 7179, 7180, 7181],
    Gludio: [7313, 7314, 7315],
    Gludin: [7060, 7061, 7062, 7063, 7207, 7208, 7209, 7321],
    'Talking Island': [7001, 7002, 7003, 7004],
    Aden: [7837, 7838, 7839, 7840, 7841, 7842, 7831, 7869],
    'Hunter\'s Village': [7230, 7231, 7235, 7301, 7684],
    'Dwarven Village': [7516, 7517, 7518, 7519],
    'Elven Village': [7135, 7136, 7137, 7138],
    'Dark Elven Village': [7147, 7148, 7149, 7150],
    'Floran Village': [7078, 7436, 7437],
    Cema: [7834],
    Goddard: [8256],
    Rune: [8300],
    'Orc Village': [7558, 7559, 7560, 7561],
    'Dion': [7253, 7254, 7294],
    'Heine': [7731, 7827, 7828, 7830]
};
const coldStoreIndex = new Map();
const SHOT_IDS = new Set([
    1835, 1463, 1464, 1465, 1466, 1467,
    2509, 2510, 2511, 2512, 2513, 2514,
    3947, 3948, 3949, 3950, 3951, 3952
]);

function itemName(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId))?.template?.name || `Item ${selfId}`;
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
    (TOWN_NPC_SELLERS[town] || []).forEach((npcSelfId) => {
        const row = NpcShopBuyLists.fetchForNpc(npcSelfId).find((item) => Number(item.selfId) === Number(selfId));
        if (!row) return;
        const price = Number(row.price || 0);
        const key = `${npcSelfId}:${price}`;
        if (seen.has(key)) return;
        seen.add(key);
        offers.push({
            sourceType: 'npc',
            sourceId: npcSelfId,
            sourceName: `NPC ${npcSelfId}`,
            town,
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
    return Object.keys(TOWN_NPC_SELLERS).flatMap((town) => npcOffers(selfId, town));
}

function configuredStoreOffers(selfId) {
    return Object.entries(MerchantStoreConfigs)
        .flatMap(([storeName, store]) => {
            if (store?.storeType !== 1 || !store.town) return [];
            const line = (store.items || []).find((entry) => Number(entry.selfId) === Number(selfId) && Number(entry.count) > 0);
            if (!line) return [];
            const price = TradeService.ratedPrice(selfId, line.priceRate ?? 1);
            if (price <= 0) return [];
            return [{
                sourceType: 'configured_store',
                sourceId: storeName,
                sourceName: storeName,
                town: store.town,
                selfId: Number(selfId),
                itemName: itemName(selfId),
                price,
                count: Number(line.count),
                available: true,
                storeConfig: store
            }];
        });
}

function privateOffers(selfId, town) {
    return (World.user?.sessions || []).flatMap((session) => {
        const actor = session?.actor;
        const store = actor?.fetchPrivateStore?.();
        if (!actor || !store || Number(store.storeType) !== 1) return [];
        if (town && store.town && store.town !== town) return [];
        const item = (store.items || []).find((entry) => Number(entry.selfId) === Number(selfId) && Number(entry.count) > 0);
        if (!item || Number(item.price) <= 0) return [];
        return [{
            sourceType: 'private_store',
            sourceId: Number(actor.fetchId?.() || 0),
            sourceName: actor.fetchName?.() || 'Private Store',
            town: store.town || town || null,
            selfId: Number(selfId),
            itemName: itemName(selfId),
            price: Number(item.price),
            count: Number(item.count),
            available: true,
            session,
            store,
            storeItem: item
        }];
    });
}

function coldOffers(selfId, town, buyerCharacterId = null) {
    return Array.from(coldStoreIndex.values()).flatMap((state) => {
        const store = state?.stats?.marketStore;
        if (!store || state.activity !== 'merchant' || Number(state.characterId) === Number(buyerCharacterId)) return [];
        if (town && store.town !== town) return [];
        const item = (store.items || []).find((entry) => Number(entry.selfId) === Number(selfId) && Number(entry.count) > 0);
        if (!item || Number(item.price) <= 0) return [];
        return [{
            sourceType: 'cold_store',
            sourceId: Number(state.characterId),
            sourceName: state.name || store.sellerName || 'Cold Seller',
            town: store.town || town || null,
            selfId: Number(selfId),
            itemName: item.name || itemName(selfId),
            price: Number(item.price),
            count: Number(item.count),
            available: true,
            sellerState: state,
            store,
            storeItem: item
        }];
    });
}

function indexColdStore(state) {
    const characterId = Number(state?.characterId || 0);
    const store = state?.stats?.marketStore;
    if (!characterId || state.activity !== 'merchant' || !store) {
        if (characterId) coldStoreIndex.delete(characterId);
        return false;
    }
    coldStoreIndex.set(characterId, state);
    return true;
}

function removeColdStore(characterId) {
    coldStoreIndex.delete(Number(characterId));
}

function resetColdStores() {
    coldStoreIndex.clear();
}

function findOffers(selfId, options = {}) {
    const town = options.town || null;
    return [
        ...privateOffers(selfId, town),
        ...coldOffers(selfId, town, options.buyerCharacterId),
        ...(town ? npcOffers(selfId, town) : [])
    ].filter((offer) => offer.available)
        .sort((a, b) => a.price - b.price || (a.sourceType === 'npc' ? 1 : -1));
}

function bestOffer(selfId, options = {}) {
    const budget = Number.isFinite(Number(options.budget)) ? Number(options.budget) : Infinity;
    return findOffers(selfId, options).find((offer) => offer.price <= budget) || null;
}

// A companion may leave the field for the city that actually sells the
// requested item.  Checking only the geographically nearest town made a
// valid item look impossible whenever its NPC list lived elsewhere.
function bestSupplyOffer(selfId, options = {}) {
    const budget = Number.isFinite(Number(options.budget)) ? Number(options.budget) : Infinity;
    // A companion supply errand uses a server-owned NPC or configured city
    // merchant. Dynamic private/cold offers remain available to the market
    // planner and are never guessed as a guaranteed supply source.
    const offers = [...npcOffersAll(selfId), ...configuredStoreOffers(selfId)];
    return offers
        .filter((offer) => offer.available && Number(offer.price) <= budget)
        .sort((a, b) => Number(a.sourceType !== 'npc') - Number(b.sourceType !== 'npc') || a.price - b.price)[0] || null;
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

function supplyCatalog(limit = 96) {
    const ids = [...new Set([
        ...(NpcShopBuyLists.allEntries?.() || []).map((entry) => Number(entry.selfId)),
        ...Object.values(MerchantStoreConfigs)
            .filter((store) => store?.storeType === 1)
            .flatMap((store) => (store.items || []).map((entry) => Number(entry.selfId)))
    ].filter(Boolean))];
    return ids
        .map((selfId) => {
            const offer = [...npcOffersAll(selfId), ...configuredStoreOffers(selfId)].sort((a, b) => a.price - b.price)[0];
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

function reserve(offer, qty = 1) {
    const count = Math.max(1, Number(qty) || 1);
    if (!offer?.available || Number(offer.price) <= 0) return false;
    if (offer.sourceType === 'npc') return true;
    if (!['private_store', 'cold_store'].includes(offer.sourceType) || !offer.storeItem) return false;
    if (Number(offer.storeItem.count) < count || Number(offer.storeItem.price) !== Number(offer.price)) return false;
    offer.storeItem.count -= count;
    offer.count = offer.storeItem.count;
    return true;
}

function release(offer, qty = 1) {
    if (!['private_store', 'cold_store'].includes(offer?.sourceType) || !offer.storeItem) return;
    offer.storeItem.count += Math.max(1, Number(qty) || 1);
    offer.count = offer.storeItem.count;
}

module.exports = {
    TOWN_NPC_SELLERS,
    bestOffer,
    bestSupplyOffer,
    coldOffers,
    findOffers,
    indexColdStore,
    npcOffers,
    npcOffersAll,
    normalizeItemLookup,
    privateOffers,
    resolveSupplyItem,
    removeColdStore,
    resetColdStores,
    supplyCatalog,
    release,
    reserve
};
