const DataCache = invoke('GameServer/DataCache');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');

const DEFAULT_BUY_STORE_MS = 20 * 60 * 1000;
const WALLET_RESERVE_PERCENT = 10;

function templateFor(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function cloneState(state) {
    return state ? JSON.parse(JSON.stringify(state)) : null;
}

function buyTitle(item, count) {
    const suffix = count > 1 ? ` x${count}` : '';
    const text = `WTB ${item?.template?.name || `Item ${item?.selfId || '?'}`}${suffix}`;
    return text.length <= 28 ? text : `${text.slice(0, 25).trimEnd()}...`;
}

function bidFor(state, goal) {
    const selfId = Number(goal?.target?.itemId || 0);
    const template = templateFor(selfId);
    const basePrice = Number(template?.template?.price || 0);
    const adena = Math.max(0, Number(state?.adena || 0));
    if (!selfId || !template || basePrice <= 0 || adena <= 0) return null;

    const reserve = Math.max(100, Math.floor(adena * WALLET_RESERVE_PERCENT / 100));
    const spendable = Math.max(0, adena - reserve);
    const fairPrice = BotEconomyPricing.scalePrice(basePrice * 0.85);
    const requestedPrice = Math.max(0, Number(goal.target.adena || goal.plan?.estimatedCost || 0));
    const price = Math.floor(Math.min(fairPrice, requestedPrice || fairPrice, spendable));
    if (price <= 0) return null;

    const requestedCount = goal.type === 'buy_craft_material'
        ? Math.max(1, Math.floor(Number(goal.target.amount) || 1))
        : 1;
    const count = Math.min(requestedCount, Math.floor(spendable / price));
    if (count <= 0) return null;
    return {
        selfId,
        name: goal.target.itemName || template.template?.name || `Item ${selfId}`,
        kind: template.template?.kind || '',
        rank: template.etc?.rank || 'none',
        price,
        count
    };
}

function open(state, goal, options = {}) {
    if (!state || state.phase === 'hot' || state.activity !== 'shopping') {
        return Promise.resolve({ state, opened: false, reason: 'not_shopping' });
    }
    const item = bidFor(state, goal);
    if (!item) return Promise.resolve({ state, opened: false, reason: 'insufficient_budget' });

    const timestamp = Number(options.now) || Date.now();
    const durationMs = Math.max(60000, Number(options.durationMs) || DEFAULT_BUY_STORE_MS);
    const town = state.currentRegion || goal.plan?.marketTown || 'Giran';
    let loc = { ...(state.loc || {}) };
    let marketTownRoutingVersion = 1;
    try {
        const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
        loc = ListingService.marketLocation({ name: town, center: loc }, { state }) || loc;
        marketTownRoutingVersion = Number(ListingService.MARKET_TOWN_ROUTING_VERSION || 1);
    } catch (_) {}
    const store = {
        id: `${state.characterId}:buy:${timestamp}`,
        storeType: 3,
        budgetBacked: true,
        buyerCharacterId: Number(state.characterId),
        buyerName: state.name,
        title: options.title || buyTitle(templateFor(item.selfId), item.count),
        autoTitle: false,
        marketTownRoutingVersion,
        town,
        loc,
        goalType: goal.type,
        items: [item],
        openedAt: timestamp,
        expiresAt: timestamp + durationMs
    };
    const nextState = {
        ...state,
        activity: 'merchant',
        currentRegion: town,
        loc,
        stats: {
            ...(state.stats || {}),
            marketWanted: {
                itemId: item.selfId,
                itemName: item.name,
                amount: item.count,
                maxPrice: item.price,
                lastMissingAt: timestamp
            },
            marketStore: store
        },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + durationMs
        }
    };
    return LifeState.upsertState(nextState, 'cold_market_buy_store').then((saved) => {
        if (saved) {
            MarketOpportunity.indexColdStore(saved);
            MarketTelemetry.buyStoreOpened?.();
        }
        return { state: saved || state, opened: !!saved, item, store: saved?.stats?.marketStore || store };
    });
}

function finishBuyer(buyer) {
    const store = buyer.stats?.marketStore;
    const hasDemand = (store?.items || []).some((item) => Number(item.count || 0) > 0);
    if (hasDemand) {
        const line = store.items.find((item) => Number(item.count || 0) > 0);
        const nextState = {
            ...buyer,
            activity: 'merchant',
            stats: {
                ...(buyer.stats || {}),
                marketStore: store,
                marketWanted: {
                    ...(buyer.stats?.marketWanted || {}),
                    itemId: Number(line?.selfId || 0),
                    itemName: line?.name || `Item ${line?.selfId || '?'}`,
                    amount: Number(line?.count || 0),
                    lastMissingAt: Date.now()
                }
            },
            timing: {
                ...(buyer.timing || {}),
                nextResolveAt: Number(store.expiresAt || 0) || Date.now() + DEFAULT_BUY_STORE_MS
            }
        };
        return LifeState.upsertState(nextState, 'cold_market_buy_partial').then((saved) => {
            const resolved = saved || nextState;
            MarketOpportunity.indexColdStore(resolved);
            return resolved;
        });
    }

    const cleared = {
        ...buyer,
        activity: 'shopping',
        stats: { ...(buyer.stats || {}), marketStore: null, marketWanted: null },
        timing: { ...(buyer.timing || {}), nextResolveAt: Date.now() }
    };
    const returning = invoke('GameServer/Bot/Goals/GoalExecutor').finishMarketVisit(cleared) || cleared;
    MarketOpportunity.removeColdStore(buyer.characterId);
    return LifeState.upsertState(returning, 'cold_market_buy_filled').then((saved) => {
        GoalState.clear(buyer.characterId, 'completed').catch(() => null);
        return saved || returning;
    });
}

async function settleLine(sellerState, line, town) {
    const offer = MarketOpportunity.bestBuyOffer(line.selfId, {
        town,
        sellerCharacterId: sellerState.characterId
    });
    if (!offer) return { state: sellerState, sold: false };
    const qty = Math.min(Number(line.count || 0), Number(offer.count || 0));
    const buyerState = LifeState.snapshot(offer.sourceId) || offer.buyerState;
    if (!buyerState || qty <= 0) return { state: sellerState, sold: false };
    const buyerBefore = cloneState(buyerState);
    offer.buyerState = buyerState;
    if (!MarketOpportunity.reserveBuy(offer, qty)) return { state: sellerState, sold: false };

    offer.buyerCharacterId = Number(buyerState.characterId);
    const purchased = await LifeState.applyMarketPurchase(buyerState, offer, qty);
    if (!purchased) {
        MarketOpportunity.releaseBuy(offer, qty);
        return { state: sellerState, sold: false };
    }
    const seller = await LifeState.applyMarketSale(sellerState, offer, qty);
    if (!seller) {
        utils.infoWarn('BotMarket', 'dynamic WTB seller persistence failed after buyer %s filled %s', buyerState.name, line.name);
        const restoredBuyer = await LifeState.restoreMarketState(buyerBefore, 'cold_market_buy_seller_rollback');
        if (!restoredBuyer) {
            utils.infoWarn('BotMarket', 'dynamic WTB buyer rollback failed for %s after seller persistence failure', buyerState.name);
            return { state: sellerState, sold: false, buyer: purchased, reason: 'buyer_rollback_failed' };
        }
        MarketOpportunity.releaseBuy(offer, qty);
        MarketOpportunity.indexColdStore(restoredBuyer);
        if (offer.session) offer.session.coldMarketState = restoredBuyer;
        return { state: sellerState, sold: false, buyer: restoredBuyer, reason: 'seller_persist_failed' };
    }
    MarketOpportunity.commitBuy(offer, qty, purchased);
    let buyer = purchased;
    try {
        buyer = await finishBuyer(purchased);
    } catch (error) {
        utils.infoWarn('BotMarket', 'dynamic WTB finalization failed after committed trade for %s: %s', buyerState.name, error?.message || String(error));
    }
    if (offer.session) {
        offer.session.coldMarketState = buyer;
        const liveStore = offer.session.actor?.fetchPrivateStore?.();
        if (liveStore) liveStore.items = (buyer.stats?.marketStore?.items || []).map((item) => ({ ...item }));
        if (!buyer.stats?.marketStore) offer.session.actor?.setPrivateStoreType?.(0);
    }
    MarketTelemetry.dynamicBuyerSale?.(offer, qty, {
        sellerCharacterId: seller.characterId,
        sellerName: seller.name,
        town
    });
    return { state: seller, sold: true, buyer, offer, qty, adena: Number(offer.price) * qty };
}

async function sellToBestBuyer(state, town = state?.currentRegion) {
    let seller = state;
    const sales = [];
    for (const line of ItemDisposition.saleCandidates(state, { limit: 20 })) {
        const result = await settleLine(seller, line, town);
        seller = result.state || seller;
        if (result.sold) sales.push(result);
    }
    return {
        state: seller,
        sold: sales.length > 0,
        sales,
        itemCount: sales.reduce((sum, sale) => sum + sale.qty, 0),
        adena: sales.reduce((sum, sale) => sum + sale.adena, 0)
    };
}

function bestTownFor(state) {
    const candidates = ItemDisposition.saleCandidates(state, { limit: 20 });
    const towns = [...new Set(candidates.flatMap((item) => MarketOpportunity.findBuyOffers(item.selfId, {
        sellerCharacterId: state.characterId
    }).map((offer) => offer.town)).filter(Boolean))];
    return towns.map((town) => {
        const value = candidates.reduce((sum, item) => {
            const offer = MarketOpportunity.bestBuyOffer(item.selfId, { town, sellerCharacterId: state.characterId });
            return sum + (offer ? Math.min(Number(item.count), Number(offer.count)) * Number(offer.price) : 0);
        }, 0);
        return { town, value };
    }).filter((entry) => entry.value > 0)
        .sort((left, right) => right.value - left.value || left.town.localeCompare(right.town))[0] || null;
}

module.exports = {
    DEFAULT_BUY_STORE_MS,
    WALLET_RESERVE_PERCENT,
    bestTownFor,
    bidFor,
    open,
    sellToBestBuyer
};
