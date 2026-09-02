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

function currentAfkStore(ownerId, storeType) {
    const projection = invoke('GameServer/AfkTrade/AfkTradeService').findOwnerProjection(ownerId);
    const store = projection?.actor?.fetchPrivateStore?.();
    return Number(store?.storeType) === Number(storeType) ? store : null;
}

function syncLiveBuyerSession(offer, buyer) {
    if (!offer?.session) return;
    offer.session.coldMarketState = buyer;
    const liveStore = offer.session.actor?.fetchPrivateStore?.();
    if (liveStore) liveStore.items = (buyer.stats?.marketStore?.items || []).map((item) => ({ ...item }));
    if (!buyer.stats?.marketStore) offer.session.actor?.setPrivateStoreType?.(0);
}

async function syncSellerStoreAfterSale(sellerState, selfId, qty, session = null) {
    const store = sellerState?.stats?.marketStore;
    if (Number(store?.storeType || 1) !== 1) return sellerState;
    const items = (store.items || []).map((item) => (
        Number(item.selfId) === Number(selfId)
            ? { ...item, count: Math.max(0, Number(item.count || 0) - Number(qty || 0)) }
            : { ...item }
    )).filter((item) => Number(item.count || 0) > 0);
    let nextState = {
        ...sellerState,
        stats: {
            ...(sellerState.stats || {}),
            marketStore: items.length ? { ...store, items } : null
        }
    };
    if (!items.length) {
        const shoppingState = {
            ...nextState,
            activity: 'shopping',
            timing: { ...(nextState.timing || {}), nextResolveAt: Date.now() }
        };
        const returning = invoke('GameServer/Bot/Goals/GoalExecutor').finishMarketVisit(shoppingState);
        nextState = returning || shoppingState;
        nextState = { ...nextState, stats: { ...(nextState.stats || {}), marketStore: null } };
        MarketOpportunity.removeColdStore(nextState.characterId);
        MarketTelemetry.closed?.('sold_out', 0);
    }
    const saved = await LifeState.upsertState(nextState, items.length
        ? 'afk_trade_sell_store_partial'
        : 'afk_trade_sell_store_filled');
    const resolved = saved || nextState;
    if (items.length) MarketOpportunity.indexColdStore(resolved);
    if (session) {
        session.coldMarketState = resolved;
        const liveStore = session.actor?.fetchPrivateStore?.();
        if (liveStore) liveStore.items = items.map((item) => ({ ...item }));
        if (!items.length) {
            session.plan = 'shopping';
            session.actor?.setPrivateStore?.(null);
            session.actor?.setPrivateStoreType?.(0);
            session.actor?.state?.setSeated?.(false);
        }
    }
    return resolved;
}

async function settleLine(sellerState, line, town, options = {}) {
    const offer = options.offer || MarketOpportunity.bestBuyOffer(line.selfId, {
        town,
        sellerCharacterId: sellerState.characterId
    });
    if (!offer) return { state: sellerState, sold: false };
    const qty = Math.min(
        Number(line.count || 0),
        Number(offer.count || 0),
        Math.max(1, Number(options.maxQty || Infinity))
    );
    if (offer.sourceType === 'afk_player_buy_store') {
        if (qty <= 0) return { state: sellerState, sold: false };
        let trade;
        try {
            trade = await invoke('GameServer/AfkTrade/AfkTradeService').sellToShop(
                sellerState.characterId,
                offer.store,
                line.selfId,
                qty,
                { objectId: line.objectId || line.id, expectedPrice: offer.price, coldState: sellerState }
            );
            if (!trade.coldState) return { state: sellerState, sold: false, reason: 'cold_state_sync_failed' };
        } catch (error) {
            utils.infoWarn('BotMarket', 'AFK buy-store sale failed for %s: %s', sellerState.name, error.message);
            return { state: sellerState, sold: false, reason: 'offer_changed' };
        }
        let syncedSeller = trade.coldState;
        try {
            syncedSeller = await syncSellerStoreAfterSale(
                trade.coldState,
                line.selfId,
                qty,
                options.sellerSession || null
            );
        } catch (error) {
            utils.infoWarn('BotMarket', 'AFK buy-store seller finalization failed after commit for %s: %s', sellerState.name, error.message);
        }
        MarketTelemetry.dynamicBuyerSale?.(offer, qty, {
            sellerCharacterId: syncedSeller.characterId,
            sellerName: syncedSeller.name,
            town
        });
        return {
            state: syncedSeller,
            sold: true,
            buyer: null,
            offer,
            qty,
            adena: Number(offer.price) * qty
        };
    }
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

async function buyFromAfkPlayerStore(offer, store, line) {
    if (!offer || !store || !line || Number(offer.price) < Number(line.price)) {
        return { state: offer?.buyerState || null, purchased: false, reason: 'price_not_crossed' };
    }
    const buyerState = LifeState.snapshot(offer.sourceId) || offer.buyerState;
    if (!buyerState) return { state: null, purchased: false, reason: 'buyer_missing' };
    offer.buyerState = buyerState;
    const affordable = Math.floor(Number(buyerState.adena || 0) / Math.max(1, Number(line.price)));
    const qty = Math.min(Number(line.count || 0), Number(offer.count || 0), affordable);
    if (qty <= 0 || !MarketOpportunity.reserveBuy(offer, qty)) {
        return { state: buyerState, purchased: false, reason: 'buyer_changed' };
    }
    let trade;
    try {
        trade = await invoke('GameServer/AfkTrade/AfkTradeService').buyFromShop(
            buyerState.characterId,
            store,
            line.selfId,
            qty,
            { lineId: line.afkTradeLineId, expectedPrice: line.price, coldState: buyerState }
        );
        if (!trade.coldState) throw new Error('cold_state_sync_failed');
    } catch (error) {
        MarketOpportunity.releaseBuy(offer, qty);
        utils.infoWarn('BotMarket', 'AFK sell-store match failed for %s: %s', buyerState.name, error.message);
        return { state: buyerState, purchased: false, reason: 'offer_changed' };
    }
    MarketOpportunity.commitBuy(offer, qty, trade.coldState);
    let buyer = trade.coldState;
    try {
        buyer = await finishBuyer(trade.coldState);
    } catch (error) {
        utils.infoWarn('BotMarket', 'AFK sell-store buyer finalization failed after commit for %s: %s', buyerState.name, error.message);
    }
    syncLiveBuyerSession(offer, buyer);
    MarketTelemetry.purchase({
        sourceType: 'afk_player_store',
        sourceId: Number(store.ownerId),
        sourceName: offer.playerStoreName || 'AFK player',
        sellerKind: 'player',
        playerPriority: true,
        town: store.town,
        selfId: Number(line.selfId),
        itemName: line.name,
        price: Number(line.price)
    }, qty, {
        buyerCharacterId: buyer.characterId,
        buyerName: buyer.name,
        town: store.town
    });
    return { state: buyer, purchased: true, qty, adena: Number(line.price) * qty };
}

function sellerInventoryLine(state, selfId, maximum) {
    const item = state?.inventory?.[String(Number(selfId))] || state?.inventory?.[Number(selfId)];
    const count = Math.min(Number(item?.amount || item?.count || 0), Number(maximum || Infinity));
    return item && count > 0 ? { ...item, selfId: Number(selfId), count } : null;
}

async function matchAfkSellStore(ownerId, maxTrades) {
    const trades = [];
    while (trades.length < maxTrades) {
        const store = currentAfkStore(ownerId, 1);
        if (!store) break;
        let matched = false;
        for (const line of store.items || []) {
            const offer = MarketOpportunity.findBuyOffers(line.selfId, {
                town: store.town,
                sellerCharacterId: ownerId
            }).find((candidate) => (
                ['cold_buy_store', 'private_buy_store'].includes(candidate.sourceType)
                && Number(candidate.price) >= Number(line.price)
            ));
            if (!offer) continue;
            offer.playerStoreName = invoke('GameServer/AfkTrade/AfkTradeService')
                .findOwnerProjection(ownerId)?.actor?.fetchName?.();
            const result = await buyFromAfkPlayerStore(offer, store, line);
            if (!result.purchased) continue;
            trades.push(result);
            matched = true;
            break;
        }
        if (!matched) break;
    }
    return trades;
}

async function matchAfkBuyStore(ownerId, maxTrades) {
    const trades = [];
    while (trades.length < maxTrades) {
        const store = currentAfkStore(ownerId, 3);
        if (!store) break;
        let matched = false;
        for (const demand of store.items || []) {
            const sellerOffer = MarketOpportunity.findOffers(demand.selfId, {
                town: store.town,
                buyerCharacterId: ownerId
            }).find((candidate) => (
                (candidate.sourceType === 'cold_store'
                    || (candidate.sourceType === 'private_store' && candidate.sellerKind === 'bot'))
                && Number(candidate.price) <= Number(demand.price)
            ));
            if (!sellerOffer) continue;
            const sellerState = LifeState.snapshot(sellerOffer.sourceId)
                || sellerOffer.sellerState
                || sellerOffer.session?.coldMarketState;
            const line = sellerInventoryLine(sellerState, demand.selfId, sellerOffer.count);
            if (!sellerState || !line) continue;
            const playerOffer = invoke('GameServer/AfkTrade/AfkTradeService').offers(demand.selfId, 3, {
                town: store.town,
                characterId: sellerState.characterId
            }).find((candidate) => Number(candidate.sourceId) === Number(ownerId));
            if (!playerOffer || Number(playerOffer.price) < Number(sellerOffer.price)) continue;
            const result = await settleLine(sellerState, line, store.town, {
                offer: playerOffer,
                maxQty: sellerOffer.count,
                sellerSession: sellerOffer.session || null
            });
            if (!result.sold) continue;
            trades.push(result);
            matched = true;
            break;
        }
        if (!matched) break;
    }
    return trades;
}

async function matchAfkPlayerShop(ownerId, options = {}) {
    const store = currentAfkStore(ownerId, 1) || currentAfkStore(ownerId, 3);
    if (!store) return { matched: false, trades: [] };
    const maxTrades = Math.max(1, Math.min(64, Number(options.maxTrades) || 64));
    const trades = Number(store.storeType) === 1
        ? await matchAfkSellStore(ownerId, maxTrades)
        : await matchAfkBuyStore(ownerId, maxTrades);
    return {
        matched: trades.length > 0,
        trades,
        itemCount: trades.reduce((sum, trade) => sum + Number(trade.qty || 0), 0),
        adena: trades.reduce((sum, trade) => sum + Number(trade.adena || 0), 0)
    };
}

async function sellToBestBuyer(state, town = state?.currentRegion) {
    let seller = state;
    const sales = [];
    const peerMarketLines = ItemDisposition.saleCandidates(state, { limit: 20 })
        .filter((line) => !ItemDisposition.isNpcOnlyItem(line));
    for (const line of peerMarketLines) {
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
    const candidates = ItemDisposition.saleCandidates(state, { limit: 20 })
        .filter((item) => !ItemDisposition.isNpcOnlyItem(item));
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
    matchAfkPlayerShop,
    open,
    sellToBestBuyer
};
