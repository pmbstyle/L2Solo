const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');

const DEFAULT_LISTING_MS = 20 * 60 * 1000;
const SELL_RETRY_DELAY_MS = 30 * 60 * 1000;
// Captured in-game from the Giran trading square. The inner rectangle is the
// central column: it is walkable around, but a private store cannot sit there.
const GIRAN_MARKET_PLAZA = Object.freeze({
    outer: Object.freeze({ minX: 80911, maxX: 82947, minY: 147662, maxY: 149550 }),
    column: Object.freeze({ minX: 81667, maxX: 82174, minY: 148354, maxY: 148857 }),
    locZ: -3466
});
const GIRAN_STALL_EDGE_PADDING = 60;
const GIRAN_COLUMN_CLEARANCE = 80;

function marketTown(name) {
    return TownPathfinder.towns.find((town) => town.name === name)
        || TownPathfinder.towns.find((town) => town.name === 'Giran')
        || null;
}

function isInRect(loc, rect) {
    return Number(loc?.locX) >= rect.minX && Number(loc?.locX) <= rect.maxX
        && Number(loc?.locY) >= rect.minY && Number(loc?.locY) <= rect.maxY;
}

function isGiranPlazaStallLocation(loc) {
    const { outer, column } = GIRAN_MARKET_PLAZA;
    const safeOuter = {
        minX: outer.minX + GIRAN_STALL_EDGE_PADDING,
        maxX: outer.maxX - GIRAN_STALL_EDGE_PADDING,
        minY: outer.minY + GIRAN_STALL_EDGE_PADDING,
        maxY: outer.maxY - GIRAN_STALL_EDGE_PADDING
    };
    const blockedColumn = {
        minX: column.minX - GIRAN_COLUMN_CLEARANCE,
        maxX: column.maxX + GIRAN_COLUMN_CLEARANCE,
        minY: column.minY - GIRAN_COLUMN_CLEARANCE,
        maxY: column.maxY + GIRAN_COLUMN_CLEARANCE
    };
    return isInRect(loc, safeOuter) && !isInRect(loc, blockedColumn);
}

function randomGiranPlazaStall(random = Math.random) {
    const { outer, locZ } = GIRAN_MARKET_PLAZA;
    const minX = outer.minX + GIRAN_STALL_EDGE_PADDING;
    const maxX = outer.maxX - GIRAN_STALL_EDGE_PADDING;
    const minY = outer.minY + GIRAN_STALL_EDGE_PADDING;
    const maxY = outer.maxY - GIRAN_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 24; attempt++) {
        const loc = {
            locX: Math.round(minX + random() * (maxX - minX)),
            locY: Math.round(minY + random() * (maxY - minY)),
            locZ
        };
        if (isGiranPlazaStallLocation(loc)) return loc;
    }

    // The northwest corner is always clear of the column, including if a
    // deterministic test source keeps proposing a blocked point.
    return { locX: minX, locY: minY, locZ };
}

function marketLocation(town, options) {
    if (town?.name === 'Giran') return randomGiranPlazaStall(options.random);
    return town?.center ? { ...town.center } : { ...(options.state?.loc || {}) };
}

function open(state, options = {}) {
    if (!state || state.phase === 'hot' || state.activity !== 'shopping') {
        return Promise.resolve({ state, listed: false, reason: 'not_shopping' });
    }
    const items = ItemDisposition.saleCandidates(state, options);
    if (!items.length) return Promise.resolve({ state, listed: false, reason: 'nothing_to_sell' });

    const timestamp = Number(options.now) || Date.now();
    const town = marketTown(options.town || state.currentRegion || 'Giran');
    const storeLoc = marketLocation(town, { ...options, state });
    const nextState = {
        ...state,
        activity: 'merchant',
        currentRegion: town?.name || state.currentRegion,
        // A private store has a stall, not a roaming route. Persist the plaza
        // coordinate so cold ticks and hot materialization use the same spot.
        loc: storeLoc,
        stats: {
            ...(state.stats || {}),
            marketStore: {
                id: `${state.characterId}:${timestamp}`,
                storeType: 1,
                sellerCharacterId: Number(state.characterId),
                sellerName: state.name,
                title: options.title || 'Useful loot and old gear',
                town: town?.name || options.town || state.currentRegion,
                loc: storeLoc,
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
    if (!state || state.activity !== 'merchant' || !store) return Promise.resolve({ state, closed: false });
    const hasStock = (store.items || []).some((item) => Number(item.count) > 0);
    if (hasStock && Number(store.expiresAt || 0) > timestamp) {
        MarketOpportunity.indexColdStore(state);
        return Promise.resolve({ state, closed: false });
    }

    const nextState = {
        ...state,
        activity: 'shopping',
        stats: {
            ...(state.stats || {}),
            marketStore: null,
            marketSellRetryAfter: hasStock ? timestamp + SELL_RETRY_DELAY_MS : null,
            marketPricing: hasStock ? (store.items || []).reduce((pricing, item) => {
                if (Number(item.count || 0) <= 0) return pricing;
                const previous = Number(pricing[item.selfId]?.percent || 100);
                pricing[item.selfId] = { percent: Math.max(50, previous - 5), lastAdjustedAt: timestamp };
                return pricing;
            }, { ...(state.stats?.marketPricing || {}) }) : state.stats?.marketPricing || {}
        },
        timing: { ...(state.timing || {}), nextResolveAt: timestamp + 30000 }
    };
    MarketOpportunity.removeColdStore(state.characterId);
    const liquidated = hasStock ? ItemDisposition.npcLiquidationCandidates(nextState) : [];
    return LifeState.applyNpcLiquidation(nextState, liquidated)
        .then((liquidatedState) => LifeState.upsertState(liquidatedState || nextState, hasStock ? 'cold_market_expired' : 'cold_market_sold_out'))
        .then((saved) => ({
            state: saved || nextState,
            closed: true,
            reason: hasStock ? 'expired' : 'sold_out',
            liquidatedCount: liquidated.reduce((sum, item) => sum + Number(item.count || 0), 0)
        }));
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

module.exports = {
    DEFAULT_LISTING_MS,
    SELL_RETRY_DELAY_MS,
    GIRAN_MARKET_PLAZA,
    isGiranPlazaStallLocation,
    open,
    resolve,
    settle
};
