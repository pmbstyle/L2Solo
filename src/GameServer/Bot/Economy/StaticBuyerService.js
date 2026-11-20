const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const ProductionPolicy = invoke('GameServer/Bot/Economy/ProductionPolicy');

// Fixed buy stores are an intentionally unlimited Adena source for the
// background economy. Only materials and drop resources they explicitly ask
// for go through this path; equipment still has a chance to reach players via
// a private store.
//
// The buy stores are static game data: town -> its buy stores, built once at
// load (15 stores, about 2 KB). BUYER_TOWNS keeps the config order, the
// tie-break of bestTownFor.
const BUYERS_BY_TOWN = new Map();
for (const [name, store] of Object.entries(MerchantStoreConfigs)) {
    if (store?.storeType !== 3) continue;
    if (!BUYERS_BY_TOWN.has(store.town)) BUYERS_BY_TOWN.set(store.town, []);
    BUYERS_BY_TOWN.get(store.town).push(Object.freeze({ name, ...store }));
}
const BUYER_TOWNS = Object.freeze([...BUYERS_BY_TOWN.keys()].filter(Boolean));
const NO_BUYERS = Object.freeze([]);
BUYERS_BY_TOWN.forEach((buyers) => Object.freeze(buyers));

// The shared rows of the town; callers only read them.
function buyersInTown(town) {
    if (ProductionPolicy.buyersDisabled()) return NO_BUYERS;
    return BUYERS_BY_TOWN.get(town) || NO_BUYERS;
}

function candidatesFor(state, town) {
    const buyers = buyersInTown(town);
    if (!buyers.length) return [];
    return ItemDisposition.saleCandidates(state, { limit: 20 }).flatMap((item) => {
        if (!ProductionPolicy.sellsToFixedBuyer(state, item.kind)) return [];
        const offer = buyers.reduce((best, buyer) => {
            const line = (buyer.items || []).find((entry) => Number(entry.selfId) === Number(item.selfId));
            if (!line) return best;
            const price = StaticMerchantPricing.botPriceFor(buyer, line);
            return !best || price > best.price ? { buyer, price } : best;
        }, null);
        if (!offer || offer.price <= 0) return [];
        return [{
            ...item,
            count: Math.min(Number(item.count || 0), Number((offer.buyer.items || []).find((entry) => Number(entry.selfId) === Number(item.selfId))?.count || 0)),
            npcPrice: offer.price,
            buyerName: offer.buyer.name,
            buyerTown: offer.buyer.town
        }];
    }).filter((item) => Number(item.count) > 0);
}

function bestTownFor(state) {
    const origin = state?.stats?.marketReturn?.loc || state?.loc || {};
    const hasOrigin = Number.isFinite(Number(origin.locX)) && Number.isFinite(Number(origin.locY))
        && (Number(origin.locX) !== 0 || Number(origin.locY) !== 0);
    return BUYER_TOWNS.map((town, order) => {
            const candidates = candidatesFor(state, town);
            const buyers = buyersInTown(town);
            return {
                town,
                order,
                candidates,
                value: candidates.reduce((sum, item) => sum + Number(item.count || 0) * Number(item.npcPrice || 0), 0),
                distance: hasOrigin ? buyers.reduce((minimum, buyer) => Math.min(minimum, Math.hypot(
                    Number(origin.locX) - Number(buyer.locX || 0),
                    Number(origin.locY) - Number(buyer.locY || 0)
                )), Infinity) : Infinity
            };
        })
        .filter((result) => result.value > 0)
        .sort((left, right) => right.value - left.value || left.distance - right.distance || left.order - right.order)[0] || null;
}

function sell(state, town) {
    const candidates = candidatesFor(state, town);
    if (!candidates.length) return Promise.resolve({ state, sold: false, candidates: [] });
    const itemCount = candidates.reduce((sum, item) => sum + Number(item.count || 0), 0);
    const adena = candidates.reduce((sum, item) => sum + Number(item.count || 0) * Number(item.npcPrice || 0), 0);
    return LifeState.applyNpcLiquidation(state, candidates, {
        source: 'static_buyer',
        town,
        buyers: [...new Set(candidates.map((item) => item.buyerName))]
    }).then((saved) => {
        if (saved) MarketTelemetry.staticBuyerSale(candidates, adena, {
            sellerCharacterId: state.characterId,
            sellerName: state.name,
            town
        });
        return { state: saved || state, sold: !!saved, candidates, itemCount, adena };
    });
}

module.exports = { bestTownFor, buyersInTown, candidatesFor, sell };
