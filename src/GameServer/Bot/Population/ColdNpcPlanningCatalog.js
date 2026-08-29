const LOW_TIER_RANKS = new Set(['none', 'd']);
const EMPTY_OFFERS = Object.freeze([]);

function equipmentItemIds(items = []) {
    return new Set((items || [])
        .filter((item) => LOW_TIER_RANKS.has(String(item?.etc?.rank || 'none').toLowerCase()))
        .filter((item) => Number(item?.etc?.slot || 0) > 0)
        .map((item) => Number(item.selfId || 0))
        .filter(Boolean));
}

function buildRows(options = {}) {
    const allowedItems = equipmentItemIds(options.items || []);
    const fetchForNpc = typeof options.fetchForNpc === 'function'
        ? options.fetchForNpc
        : () => [];
    const offers = new Map();

    Object.entries(options.townNpcSellers || {}).forEach(([town, npcIds]) => {
        (npcIds || []).forEach((npcSelfId) => {
            (fetchForNpc(npcSelfId) || []).forEach((entry) => {
                const selfId = Number(entry?.selfId || 0);
                const price = Number(entry?.price || 0);
                if (!allowedItems.has(selfId) || price <= 0) return;
                const key = `${town}:${selfId}`;
                const existing = offers.get(key);
                if (existing && (existing.price < price
                    || existing.price === price && existing.sourceId <= Number(npcSelfId))) return;
                offers.set(key, {
                    sourceType: 'npc',
                    sourceId: Number(npcSelfId),
                    town: String(town),
                    selfId,
                    price,
                    available: true
                });
            });
        });
    });

    return Object.freeze([...offers.values()]
        .sort((left, right) => Number(left.selfId) - Number(right.selfId)
            || Number(left.price) - Number(right.price)
            || String(left.town).localeCompare(String(right.town))
            || Number(left.sourceId) - Number(right.sourceId))
        .map((offer) => Object.freeze(offer)));
}

function createLookup(rows = []) {
    const offersByItem = new Map();
    (rows || []).forEach((row) => {
        const selfId = Number(row?.selfId || 0);
        const price = Number(row?.price || 0);
        if (!selfId || price <= 0 || row?.sourceType !== 'npc' || !row?.town) return;
        const offer = Object.freeze({
            sourceType: 'npc',
            sourceId: Number(row.sourceId || 0),
            town: String(row.town),
            selfId,
            price,
            available: true
        });
        if (!offersByItem.has(selfId)) offersByItem.set(selfId, []);
        offersByItem.get(selfId).push(offer);
    });
    offersByItem.forEach((offers, selfId) => {
        offersByItem.set(selfId, Object.freeze(offers.sort((left, right) => (
            Number(left.price) - Number(right.price)
            || String(left.town).localeCompare(String(right.town))
            || Number(left.sourceId) - Number(right.sourceId)
        ))));
    });

    const offersFor = (target) => offersByItem.get(Number(target?.selfId ?? target)) || EMPTY_OFFERS;
    const bestOffer = (target) => offersFor(target)[0] || null;
    const plannerOptions = Object.freeze({
        findNpcOffer: bestOffer,
        findMarketOffer: bestOffer
    });

    return Object.freeze({
        itemCount: offersByItem.size,
        offerCount: [...offersByItem.values()].reduce((sum, offers) => sum + offers.length, 0),
        offersFor,
        bestOffer,
        plannerOptions
    });
}

module.exports = { buildRows, createLookup };
