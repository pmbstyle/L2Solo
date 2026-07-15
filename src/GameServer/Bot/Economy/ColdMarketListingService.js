const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');

const DEFAULT_LISTING_MS = 20 * 60 * 1000;

function open(state, options = {}) {
    if (!state || state.phase === 'hot' || state.activity !== 'shopping') {
        return Promise.resolve({ state, listed: false, reason: 'not_shopping' });
    }
    const items = ItemDisposition.saleCandidates(state, options);
    if (!items.length) return Promise.resolve({ state, listed: false, reason: 'nothing_to_sell' });

    const timestamp = Number(options.now) || Date.now();
    const nextState = {
        ...state,
        activity: 'merchant',
        stats: {
            ...(state.stats || {}),
            marketStore: {
                id: `${state.characterId}:${timestamp}`,
                storeType: 1,
                sellerCharacterId: Number(state.characterId),
                sellerName: state.name,
                title: options.title || 'Useful loot and old gear',
                town: options.town || state.currentRegion,
                items,
                openedAt: timestamp,
                expiresAt: timestamp + (Number(options.durationMs) || DEFAULT_LISTING_MS)
            }
        },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + 60000
        }
    };
    return LifeState.upsertState(nextState, 'cold_market_listing').then((saved) => {
        if (saved) MarketOpportunity.indexColdStore(saved);
        return {
            state: saved || state,
            listed: !!saved,
            itemCount: items.length
        };
    });
}

function resolve(state, timestamp = Date.now()) {
    const store = state?.stats?.marketStore;
    if (!state || state.activity !== 'merchant' || !store) return Promise.resolve(state);
    const hasStock = (store.items || []).some((item) => Number(item.count) > 0);
    if (hasStock && Number(store.expiresAt || 0) > timestamp) {
        MarketOpportunity.indexColdStore(state);
        return Promise.resolve(state);
    }

    const nextState = {
        ...state,
        activity: 'shopping',
        stats: { ...(state.stats || {}), marketStore: null },
        timing: { ...(state.timing || {}), nextResolveAt: timestamp + 30000 }
    };
    MarketOpportunity.removeColdStore(state.characterId);
    return LifeState.upsertState(nextState, hasStock ? 'cold_market_expired' : 'cold_market_sold_out')
        .then((saved) => saved || nextState);
}

function settle(offer, qty = 1) {
    if (offer?.sourceType !== 'cold_store') return Promise.resolve(null);
    const seller = LifeState.snapshot(offer.sourceId) || offer.sellerState;
    if (!seller) return Promise.resolve(null);
    return LifeState.applyMarketSale(seller, offer, qty).then((saved) => {
        if (saved) MarketOpportunity.indexColdStore(saved);
        return saved;
    });
}

module.exports = { DEFAULT_LISTING_MS, open, resolve, settle };
