const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');

const TOWN_NPC_SELLERS = {
    Giran: [7081, 7082, 7084, 7085, 7087, 7088, 7090, 7091, 7093, 7094, 7829],
    Oren: [7178, 7179, 7180, 7181],
    Gludio: [7313, 7314, 7315],
    Gludin: [7060, 7061, 7062, 7063, 7207, 7208, 7209],
    'Talking Island': [7001, 7002, 7003, 7004]
};

function itemName(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId))?.template?.name || `Item ${selfId}`;
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

function findOffers(selfId, options = {}) {
    const town = options.town || null;
    return [
        ...privateOffers(selfId, town),
        ...(town ? npcOffers(selfId, town) : [])
    ].filter((offer) => offer.available)
        .sort((a, b) => a.price - b.price || (a.sourceType === 'private_store' ? -1 : 1));
}

function bestOffer(selfId, options = {}) {
    const budget = Number.isFinite(Number(options.budget)) ? Number(options.budget) : Infinity;
    return findOffers(selfId, options).find((offer) => offer.price <= budget) || null;
}

function reserve(offer, qty = 1) {
    const count = Math.max(1, Number(qty) || 1);
    if (!offer?.available || Number(offer.price) <= 0) return false;
    if (offer.sourceType === 'npc') return true;
    if (offer.sourceType !== 'private_store' || !offer.storeItem) return false;
    if (Number(offer.storeItem.count) < count || Number(offer.storeItem.price) !== Number(offer.price)) return false;
    offer.storeItem.count -= count;
    offer.count = offer.storeItem.count;
    return true;
}

function release(offer, qty = 1) {
    if (offer?.sourceType !== 'private_store' || !offer.storeItem) return;
    offer.storeItem.count += Math.max(1, Number(qty) || 1);
    offer.count = offer.storeItem.count;
}

module.exports = {
    TOWN_NPC_SELLERS,
    bestOffer,
    findOffers,
    npcOffers,
    privateOffers,
    release,
    reserve
};
