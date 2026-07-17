const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const { marketStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');
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
const GIRAN_STALL_MIN_DISTANCE = 40;

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

function distance2d(a, b) {
    const dx = Number(a?.locX || 0) - Number(b?.locX || 0);
    const dy = Number(a?.locY || 0) - Number(b?.locY || 0);
    return Math.sqrt(dx * dx + dy * dy);
}

function isFreeGiranPlazaStall(loc, occupied) {
    return isGiranPlazaStallLocation(loc)
        && !occupied.some((other) => distance2d(loc, other) < GIRAN_STALL_MIN_DISTANCE);
}

function occupiedGiranPlazaStalls(characterId) {
    return LifeState.allStates(2000)
        .filter((state) => Number(state.characterId) !== Number(characterId)
            && state.activity === 'merchant'
            && state.stats?.marketStore?.town === 'Giran'
            && isGiranPlazaStallLocation(state.stats.marketStore.loc || state.loc))
        .map((state) => state.stats.marketStore.loc || state.loc);
}

function chooseGiranPlazaStall(random = Math.random, occupied = []) {
    const { outer, locZ } = GIRAN_MARKET_PLAZA;
    const minX = outer.minX + GIRAN_STALL_EDGE_PADDING;
    const maxX = outer.maxX - GIRAN_STALL_EDGE_PADDING;
    const minY = outer.minY + GIRAN_STALL_EDGE_PADDING;
    const maxY = outer.maxY - GIRAN_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 96; attempt++) {
        const loc = {
            locX: Math.round(minX + random() * (maxX - minX)),
            locY: Math.round(minY + random() * (maxY - minY)),
            locZ
        };
        if (isFreeGiranPlazaStall(loc, occupied)) return loc;
    }

    // A deterministic grid is the overflow path: it keeps a dense, readable
    // market rather than allowing two stores to occupy one stall.
    for (let locX = minX; locX <= maxX; locX += GIRAN_STALL_MIN_DISTANCE) {
        for (let locY = minY; locY <= maxY; locY += GIRAN_STALL_MIN_DISTANCE) {
            const loc = { locX, locY, locZ };
            if (isFreeGiranPlazaStall(loc, occupied)) return loc;
        }
    }
    return null;
}

function marketLocation(town, options) {
    if (town?.name === 'Giran') return chooseGiranPlazaStall(options.random, occupiedGiranPlazaStalls(options.state?.characterId));
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
    if (!storeLoc) return Promise.resolve({ state, listed: false, reason: 'giran_plaza_full' });
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
                title: options.title || marketStoreTitle(items),
                autoTitle: !options.title,
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
    return (hasStock ? BotWarehouse.depositCold(nextState) : Promise.resolve({ state: nextState, count: 0 }))
        .then((warehouse) => {
            const storedState = warehouse.state || nextState;
            const liquidated = hasStock ? ItemDisposition.npcLiquidationCandidates(storedState) : [];
            return LifeState.applyNpcLiquidation(storedState, liquidated).then((liquidatedState) => ({
                state: liquidatedState || storedState,
                warehouseCount: warehouse.count || 0,
                liquidated
            }));
        })
        .then(({ state: liquidatedState, warehouseCount, liquidated }) => LifeState.upsertState(liquidatedState, hasStock ? 'cold_market_expired' : 'cold_market_sold_out')
            .then((saved) => ({
                state: saved || liquidatedState,
                closed: true,
                reason: hasStock ? 'expired' : 'sold_out',
                warehouseCount,
                liquidatedCount: liquidated.reduce((sum, item) => sum + Number(item.count || 0), 0)
            })));
}

function reconcileInventory(state) {
    const store = state?.stats?.marketStore;
    if (!state || state.activity !== 'merchant' || !store) return Promise.resolve({ state, reconciled: false });

    const items = ItemDisposition.saleCandidates(state);
    if (items.length) {
        const nextState = {
            ...state,
            stats: {
                ...(state.stats || {}),
                marketStore: {
                    ...store,
                    items,
                    // Existing listings predate inventory-backed titles; they
                    // are upgraded on their next cold-state reconciliation.
                    title: store.autoTitle === false ? store.title : marketStoreTitle(items)
                }
            }
        };
        return LifeState.upsertState(nextState, 'cold_market_inventory_reconciled').then((saved) => {
            if (saved) MarketOpportunity.indexColdStore(saved);
            return { state: saved || nextState, reconciled: true, closed: false };
        });
    }

    const nextState = {
        ...state,
        activity: 'shopping',
        stats: { ...(state.stats || {}), marketStore: null },
        timing: { ...(state.timing || {}), nextResolveAt: Date.now() + 30000 }
    };
    MarketOpportunity.removeColdStore(state.characterId);
    return LifeState.upsertState(nextState, 'cold_market_inventory_empty').then((saved) => ({
        state: saved || nextState,
        reconciled: true,
        closed: true,
        reason: 'inventory_empty'
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
    GIRAN_STALL_MIN_DISTANCE,
    marketStoreTitle,
    chooseGiranPlazaStall,
    isGiranPlazaStallLocation,
    open,
    reconcileInventory,
    resolve,
    settle
};
