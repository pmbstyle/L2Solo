const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const ColdSafeEnchantService = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const { marketStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const MarketBuyerActivity = invoke('GameServer/Bot/Economy/MarketBuyerActivity');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const BotMerchantStoreService = invoke('GameServer/Bot/Economy/BotMerchantStoreService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');

const DEFAULT_LISTING_MS = 20 * 60 * 1000;
const SPECULATIVE_LISTING_MS = 5 * 60 * 1000;
const LISTING_REVIEW_MS = 2 * 60 * 1000;
const SELL_RETRY_DELAY_MS = 30 * 60 * 1000;
const MARKET_TOWN_ROUTING_VERSION = 5;

function marketTown(name) {
    return TownPathfinder.towns.find((town) => town.name === name)
        || MarketTownPolicy.marketTown(name)
        || TownPathfinder.towns.find((town) => town.name === 'Giran')
        || null;
}

const targetMarketTownName = MarketTownPolicy.targetTownForItems;

// A store's place: the next free place of the town's captured square, or,
// in a town without one, the town centre (or the bot's own place).
function marketLocation(town, options) {
    if (ShopPlaces.hasPlaza(town?.name)) {
        return ShopPlaces.take(town.name, options.owner || ShopPlaces.stateOwner(options.state?.characterId));
    }
    return town?.center ? { ...town.center } : { ...(options.state?.loc || {}) };
}

function marketAwareNpcCandidates(state, options = {}) {
    const market = MarketListingPolicy.evaluate(state, {
        unlimited: true,
        allowPreTradeCleanup: options.allowPreTradeCleanup === true
    }).npc;
    const chosen = new Set(market.map((item) => Number(item.selfId)));
    return market.concat(ItemDisposition.npcLiquidationCandidates(state, options).filter((item) => {
        const kind = String(item.kind || '');
        return !kind.startsWith('Weapon.') && !kind.startsWith('Armor.')
            && !chosen.has(Number(item.selfId));
    }));
}

function preTradeNpcCleanup(state, forcedCleanup = {}, timestamp = Date.now()) {
    const candidates = marketAwareNpcCandidates(state, { allowPreTradeCleanup: true });
    const clearedState = {
        ...state,
        stats: {
            ...(state.stats || {}),
            forcedMarketCleanup: null,
            marketSellRetryAfter: null
        }
    };
    if (!candidates.length) {
        return Promise.resolve({
            state: clearedState,
            listed: false,
            cleaned: false,
            reason: 'pre_trade_nothing_to_cleanup',
            cleanup: forcedCleanup
        });
    }
    return LifeState.applyNpcLiquidation(clearedState, candidates, {
        source: 'pre_trade_npc_cleanup',
        cleanupReason: forcedCleanup.cleanupReason || 'inventory_cleanup',
        town: clearedState.currentRegion || null,
        at: timestamp
    }).then((cleanedState) => ({
        state: cleanedState || clearedState,
        listed: false,
        cleaned: !!cleanedState,
        reason: 'pre_trade_npc_cleanup',
        cleanup: forcedCleanup,
        liquidated: candidates
    }));
}

function open(state, options = {}) {
    if (!state || state.phase === 'hot' || state.activity !== 'shopping') {
        return Promise.resolve({ state, listed: false, reason: 'not_shopping' });
    }
    const timestamp = Number(options.now) || Date.now();
    if (Number(state.stats?.marketSellRetryAfter || 0) > timestamp) {
        if (!options.forcedCleanup) return Promise.resolve({ state, listed: false, reason: 'sell_retry_cooldown' });
        // Cleanup may bypass the travel delay, but must not open another WTS.
        // Learn recipes first, as the sale path does: a learnable one is not junk.
        return MarketBuyerActivity.refresh().then(() => LifeState.learnCraftableRecipes(state))
            .then((learnedState) => preTradeNpcCleanup(learnedState || state, options.forcedCleanup, timestamp)).then((cleanup) => (
            BotWarehouse.depositCold({
                ...cleanup.state,
                stats: { ...cleanup.state.stats, marketSellRetryAfter: state.stats.marketSellRetryAfter }
            }).then((warehouse) => ({ ...cleanup, state: warehouse.state, reason: 'sell_retry_cleanup' }))
        ));
    }
    const deferSellRetry = (nextState) => ({
        ...nextState,
        stats: {
            ...(nextState?.stats || {}),
            marketSellRetryAfter: timestamp + SELL_RETRY_DELAY_MS
        }
    });
    return MarketBuyerActivity.refresh().then(() => ColdSafeEnchantService.enchantSafe(state, options))
        .then((enchantResult) => LifeState.learnCraftableRecipes(enchantResult.state || state))
        .then((preparedState) => {
    state = preparedState || state;
    const forcedCleanup = options.forcedCleanup || null;
    if (forcedCleanup && !ItemDisposition.isTradeEligible(state)) {
        return preTradeNpcCleanup(state, forcedCleanup, timestamp);
    }
    const initialItems = ItemDisposition.saleCandidates(state, options);
    if (!initialItems.length) {
        return { state: deferSellRetry(state), listed: false, reason: 'nothing_to_sell' };
    }

    // GoalExecutor chooses the best buyer town before travel. At this stage
    // the bot must trade only with the city it has actually reached.
    const town = marketTown(options.town || state.currentRegion || targetMarketTownName(state, initialItems));
    return BuyStoreService.sellToBestBuyer(state, town?.name).then((dynamicBuyerSale) => StaticBuyerService.sell(dynamicBuyerSale.state || state, town?.name).then((buyerSale) => {
    const saleState = buyerSale.state || dynamicBuyerSale.state || state;
    const initialMarket = MarketListingPolicy.evaluate(saleState, options);
    return LifeState.applyNpcLiquidation(saleState, initialMarket.npc, {
        source: 'pre_market_junk',
        town: town?.name || saleState.currentRegion || null
    }).then((liquidatedState) => {
    const marketState = liquidatedState || saleState;
    const market = MarketListingPolicy.evaluate(marketState, options);
    const requestedDurationMs = Number(options.durationMs) || 0;
    const items = market.listings.map((item) => ({
        ...item,
        marketExpiresAt: timestamp + (requestedDurationMs || (
            item.marketReason === 'speculative_demand' ? SPECULATIVE_LISTING_MS : DEFAULT_LISTING_MS
        ))
    }));
    if (!items.length) {
        return BotWarehouse.depositCold(marketState).then((warehouse) => ({
            state: deferSellRetry(warehouse.state || marketState),
            listed: false,
            reason: buyerSale.sold
                ? 'sold_to_static_buyer'
                : dynamicBuyerSale.sold
                    ? 'sold_to_dynamic_buyer'
                : initialMarket.npc.length
                    ? 'liquidated_junk'
                    : market.warehouse.length
                        ? 'no_market_demand'
                        : 'nothing_to_sell',
            buyerSale,
            dynamicBuyerSale,
            warehouse,
            market
        }));
    }
    const speculative = items.every((item) => item.marketReason === 'speculative_demand');
    const durationMs = requestedDurationMs || Math.max(...items.map((item) => Number(item.marketExpiresAt) - timestamp));
    const earliestSpeculativeExpiry = items
        .filter((item) => item.marketReason === 'speculative_demand')
        .reduce((earliest, item) => Math.min(earliest, Number(item.marketExpiresAt || Infinity)), Infinity);
    const storeLoc = marketLocation(town, { ...options, state });
    if (!storeLoc) return { state: deferSellRetry(marketState), listed: false, reason: ShopPlaces.fullReason(town?.name), buyerSale, market };
    const nextState = {
        ...marketState,
        activity: 'merchant',
        currentRegion: town?.name || marketState.currentRegion,
        // A private store has a stall, not a roaming route. Persist the plaza
        // coordinate so cold ticks and hot materialization use the same spot.
        loc: storeLoc,
        stats: {
            ...(marketState.stats || {}),
            marketStore: {
                id: `${state.characterId}:${timestamp}`,
                storeType: 1,
                sellerCharacterId: Number(marketState.characterId),
                sellerName: marketState.name,
                title: options.title || marketStoreTitle(items),
                autoTitle: !options.title,
                marketTownRoutingVersion: MARKET_TOWN_ROUTING_VERSION,
                town: town?.name || options.town || saleState.currentRegion,
                loc: storeLoc,
                items,
                openedAt: timestamp,
                nextReviewAt: Math.min(timestamp + LISTING_REVIEW_MS, timestamp + durationMs, earliestSpeculativeExpiry),
                expiresAt: timestamp + durationMs
            }
        },
        timing: {
            ...(saleState.timing || {}),
            activityStartedAt: timestamp,
            // Sales settle through the market event path.  A listed store only
            // needs a scheduled wake-up when its offer expires.
            nextResolveAt: timestamp + durationMs
        }
    };
    return LifeState.upsertState(nextState, 'cold_market_listing').then((saved) => {
        if (saved) MarketOpportunity.indexColdStore(saved);
        if (saved) MarketTelemetry.listingOpened({ speculative });
        if (saved) invoke('GameServer/Bot/Economy/BotTradeChat').offer(saved, timestamp);
        return {
            state: saved || marketState,
            listed: !!saved,
            itemCount: items.length,
            buyerSale,
            dynamicBuyerSale,
            market
        };
    });
    });
    }));
    });
}

function stockUnits(store) {
    return (store?.items || []).reduce((sum, item) => sum + Math.max(0, Number(item.count || 0)), 0);
}

function revalidatedItems(state, store, timestamp) {
    const decisions = (store.items || []).map((item) => {
        const speculativeExpired = item.marketReason === 'speculative_demand'
            && Number(item.marketExpiresAt || 0) > 0
            && Number(item.marketExpiresAt) <= timestamp;
        return {
            item,
            decision: speculativeExpired
                ? { action: 'warehouse', reason: 'speculative_expired' }
                : MarketListingPolicy.classify(state, item, { now: timestamp })
        };
    });
    const items = decisions.flatMap(({ item, decision }) => {
        if (decision.action !== 'list') return [];
        const speculative = decision.reason === 'speculative_demand';
        const marketExpiresAt = speculative
            ? item.marketReason === 'speculative_demand' && Number(item.marketExpiresAt || 0) > timestamp
                ? Number(item.marketExpiresAt)
                : Math.min(Number(store.expiresAt || Infinity), timestamp + SPECULATIVE_LISTING_MS)
            : Number(store.expiresAt || item.marketExpiresAt || timestamp + DEFAULT_LISTING_MS);
        return [{
            ...item,
            count: Math.max(1, Math.min(Number(item.count), Number(decision.listCount || item.count))),
            price: MarketListingPolicy.listingPrice(item, decision),
            marketReason: decision.reason,
            marketExpiresAt
        }];
    });
    return { decisions, items };
}

function listingNextReviewAt(items, storeExpiresAt, timestamp) {
    const speculativeExpiry = items
        .filter((item) => item.marketReason === 'speculative_demand')
        .reduce((earliest, item) => Math.min(earliest, Number(item.marketExpiresAt || Infinity)), Infinity);
    return Math.min(Number(storeExpiresAt || timestamp + LISTING_REVIEW_MS), timestamp + LISTING_REVIEW_MS, speculativeExpiry);
}

function pricingAfterReview(state, store, timestamp, expired = false) {
    const pricing = { ...(state.stats?.marketPricing || {}) };
    for (const item of store.items || []) {
        if (Number(item.count || 0) <= 0) continue;
        const speculativeFailed = item.marketReason === 'speculative_demand'
            && (expired || Number(item.marketExpiresAt || store.expiresAt || Infinity) <= timestamp);
        if (!expired && !speculativeFailed) continue;
        const previous = pricing[item.selfId] || {};
        pricing[item.selfId] = {
            ...previous,
            percent: Math.max(50, Number(previous.percent || 100) - 5),
            lastAdjustedAt: timestamp,
            ...(speculativeFailed ? { speculativeFailedAt: timestamp, failedSpeculativePrice: Number(item.price) } : {})
        };
    }
    return pricing;
}

function closeSellStore(state, timestamp, reason) {
    const store = state.stats.marketStore;
    const hasStock = stockUnits(store) > 0;
    const nextState = {
        ...state,
        activity: 'shopping',
        stats: {
            ...(state.stats || {}),
            marketStore: null,
            marketSellRetryAfter: hasStock ? timestamp + SELL_RETRY_DELAY_MS : null,
            marketPricing: pricingAfterReview(state, store, timestamp, reason === 'expired')
        },
        timing: { ...(state.timing || {}), nextResolveAt: timestamp }
    };
    MarketOpportunity.removeColdStore(state.characterId);
    return MarketBuyerActivity.refresh().then(() => (
        hasStock ? BotWarehouse.depositCold(nextState) : Promise.resolve({ state: nextState, count: 0 })))
        .then((warehouse) => {
            const storedState = warehouse.state || nextState;
            const liquidated = hasStock ? marketAwareNpcCandidates(storedState) : [];
            return LifeState.applyNpcLiquidation(storedState, liquidated).then((liquidatedState) => ({
                state: liquidatedState || storedState,
                warehouseCount: warehouse.count || 0,
                liquidated
            }));
        })
        .then(({ state: liquidatedState, warehouseCount, liquidated }) => {
            MarketTelemetry.closed(reason, stockUnits(store));
            // A closed cold WTS has no remaining town action. Persist the
            // return trip at the same durable boundary, matching the WTB
            // close path, instead of leaving an immediately-due shopping row
            // for a later scheduler command.
            const returning = reason === 'sold_out'
                ? liquidatedState
                : GoalExecutor.finishMarketVisit(liquidatedState, timestamp, { recoverMissingReturn: true }) || liquidatedState;
            return LifeState.upsertState(returning, `cold_market_${reason}`)
                .then((saved) => ({
                    state: saved || returning,
                    closed: true,
                    reason,
                    warehouseCount,
                    liquidatedCount: liquidated.reduce((sum, item) => sum + Number(item.count || 0), 0)
                }));
        });
}

function revalidateListing(state, timestamp) {
    const store = state.stats.marketStore;
    const { items } = revalidatedItems(state, store, timestamp);
    const prunedItems = Math.max(0, stockUnits(store) - items.reduce((sum, item) => sum + Number(item.count || 0), 0));
    if (!items.length) return closeSellStore(state, timestamp, 'no_actionable_demand');

    const nextState = {
        ...state,
        stats: {
            ...(state.stats || {}),
            marketPricing: pricingAfterReview(state, store, timestamp),
            marketStore: {
                ...store,
                items,
                title: store.autoTitle === false ? store.title : marketStoreTitle(items),
                nextReviewAt: listingNextReviewAt(items, store.expiresAt, timestamp)
            }
        }
    };
    return LifeState.upsertState(nextState, 'cold_market_demand_revalidated').then((saved) => {
        const resolved = saved || nextState;
        MarketOpportunity.indexColdStore(resolved);
        if (prunedItems > 0) MarketTelemetry.demandPruned(prunedItems);
        return { state: resolved, closed: false, revalidated: true, prunedItems };
    });
}

function hotClosedState(state, store, timestamp, reason) {
    const hasStock = stockUnits(store) > 0;
    return {
        ...state,
        phase: 'hot',
        activity: 'shopping',
        stats: {
            ...(state.stats || {}),
            marketStore: null,
            marketSellRetryAfter: hasStock ? timestamp + SELL_RETRY_DELAY_MS : null,
            marketPricing: pricingAfterReview(state, store, timestamp, reason === 'expired')
        },
        timing: { ...(state.timing || {}), nextResolveAt: timestamp }
    };
}

async function resolveHotSession(session, timestamp = Date.now()) {
    const state = session?.coldMarketState;
    const persistedStore = state?.stats?.marketStore;
    const liveStore = session?.actor?.fetchPrivateStore?.();
    if (!state || !persistedStore || !liveStore || Number(persistedStore.storeType || 1) !== 1) {
        return { state, closed: false, maintained: false };
    }
    if (liveStore.repricing === true || Number(liveStore.activePurchases || 0) > 0) {
        return { state, closed: false, maintained: false, reason: 'store_busy' };
    }

    const persistedById = new Map((persistedStore.items || []).map((item) => [Number(item.selfId), item]));
    const store = {
        ...persistedStore,
        items: (liveStore.items || []).map((item) => ({
            ...(persistedById.get(Number(item.selfId)) || {}),
            ...item,
            selfId: Number(item.selfId),
            count: Number(item.count),
            price: Number(item.price)
        }))
    };
    const runtimeState = {
        ...state,
        phase: 'hot',
        stats: { ...(state.stats || {}), marketStore: store }
    };
    const hasStock = stockUnits(store) > 0;
    const active = hasStock && Number(store.expiresAt || 0) > timestamp;

    if (!active) {
        const reason = hasStock ? 'expired' : 'sold_out';
        const nextState = hotClosedState(runtimeState, store, timestamp, reason);
        const applied = await BotMerchantStoreService.applyLifecycle(session, nextState, `hot_market_${reason}`);
        if (!applied.ok) return { state, closed: false, maintained: false, reason: applied.reason };
        MarketOpportunity.removeColdStore(state.characterId);
        MarketTelemetry.closed(reason, stockUnits(store));
        return { state: applied.state, closed: true, maintained: true, reason };
    }
    if (Number(store.nextReviewAt || 0) > timestamp) {
        return { state: runtimeState, closed: false, maintained: false };
    }

    const { items } = revalidatedItems(runtimeState, store, timestamp);
    const prunedItems = Math.max(0, stockUnits(store) - items.reduce((sum, item) => sum + Number(item.count || 0), 0));
    if (!items.length) {
        const reason = 'no_actionable_demand';
        const nextState = hotClosedState(runtimeState, store, timestamp, reason);
        const applied = await BotMerchantStoreService.applyLifecycle(session, nextState, `hot_market_${reason}`);
        if (!applied.ok) return { state, closed: false, maintained: false, reason: applied.reason };
        MarketOpportunity.removeColdStore(state.characterId);
        MarketTelemetry.closed(reason, stockUnits(store));
        return { state: applied.state, closed: true, maintained: true, reason };
    }

    const nextStore = {
        ...store,
        items,
        title: store.autoTitle === false ? store.title : marketStoreTitle(items),
        nextReviewAt: listingNextReviewAt(items, store.expiresAt, timestamp)
    };
    const nextState = {
        ...runtimeState,
        stats: { ...(runtimeState.stats || {}), marketStore: nextStore,
            marketPricing: pricingAfterReview(runtimeState, store, timestamp) }
    };
    const applied = await BotMerchantStoreService.applyLifecycle(session, nextState, 'hot_market_demand_revalidated');
    if (!applied.ok) return { state, closed: false, maintained: false, reason: applied.reason };
    if (prunedItems > 0) MarketTelemetry.demandPruned(prunedItems);
    return { state: applied.state, closed: false, maintained: true, revalidated: true, prunedItems };
}

function maintainHotMarketStores(sessions = [], limit = 10, timestamp = Date.now()) {
    const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
    const candidates = sessions.filter((session) => {
        const store = session?.coldMarketState?.stats?.marketStore;
        if (!session?.actor || !store || Number(store.storeType || 1) !== 1) return false;
        return Number(store.expiresAt || 0) <= timestamp || Number(store.nextReviewAt || 0) <= timestamp;
    }).slice(0, safeLimit);
    return candidates.reduce((chain, session) => chain.then(async (maintained) => {
        const result = await resolveHotSession(session, timestamp);
        if (result.maintained) maintained.push(result);
        return maintained;
    }), Promise.resolve([]));
}

function resolve(state, timestamp = Date.now()) {
    const store = state?.stats?.marketStore;
    if (!state || state.activity !== 'merchant') return Promise.resolve({ state, closed: false });
    if (!store) {
        if (invoke('GameServer/Bot/AI/BotServiceIdentity').isStaticService(state)) {
            return Promise.resolve({ state, closed: false });
        }
        // Historical store cleanup can leave an adventurer in merchant mode
        // without a shop. There is then no expiry event to release the bot.
        const recovered = { ...state, activity: state.stats?.marketReturn ? 'shopping' : 'hunting',
            timing: { ...(state.timing || {}), nextResolveAt: timestamp } };
        return LifeState.upsertState(recovered, 'orphaned_market_recovery').then(saved => {
            if (!saved) return { state, closed: false };
            MarketOpportunity.removeColdStore(state.characterId);
            return { state: saved, closed: true, reason: 'orphaned_market_recovery' };
        });
    }
    if (Number(store.storeType || 1) === 3) {
        const hasDemand = (store.items || []).some((item) => Number(item.count || 0) > 0);
        if (hasDemand && Number(store.expiresAt || 0) > timestamp) {
            MarketOpportunity.indexColdStore(state);
            return Promise.resolve({ state, closed: false });
        }
        const recovered = hasDemand
            ? invoke('GameServer/Bot/AI/GearAcquisitionPlanner').abandonAcquisition(
                state, store.items.find((item) => Number(item.count) > 0)?.selfId, timestamp)
            : state;
        const cleared = {
            ...recovered,
            activity: 'shopping',
            stats: {
                ...(recovered.stats || {}),
                marketStore: null,
                marketRetryAfter: hasDemand ? timestamp + SELL_RETRY_DELAY_MS : null,
                marketWanted: null
            },
            timing: { ...(state.timing || {}), nextResolveAt: timestamp }
        };
        const returning = GoalExecutor.finishMarketVisit(cleared, timestamp) || { ...cleared, activity: 'hunting' };
        MarketOpportunity.removeColdStore(state.characterId);
        return LifeState.upsertState(returning, hasDemand ? 'cold_market_buy_expired' : 'cold_market_buy_filled').then(async (saved) => {
            if (saved && hasDemand && recovered !== state) await invoke('GameServer/Bot/Goals/GoalState').clear(state.characterId, 'abandoned');
            return {
                state: saved || returning,
                closed: true,
                reason: hasDemand ? 'buy_expired' : 'buy_filled'
            };
        });
    }
    const hasStock = (store.items || []).some((item) => Number(item.count) > 0);
    const isActive = hasStock && Number(store.expiresAt || 0) > timestamp;
    if (isActive) {
        if (Number(store.nextReviewAt || 0) <= timestamp) {
            // Revalidation is the maintenance action for this pass. Do not
            // recursively resolve the returned snapshot: an ownership race or
            // stale persisted deadline can otherwise keep the promise chain
            // growing until V8 reports "Invalid string length". A still-due
            // snapshot is safe to retry in the next bounded maintenance pass.
            return revalidateListing(state, timestamp);
        }
        const targetTownName = targetMarketTownName(state, store.items || []);
        if (store.town !== targetTownName) {
            const town = marketTown(targetTownName);
            const loc = marketLocation(town, { state });
            if (!loc) return Promise.resolve({ state, closed: false, reason: ShopPlaces.fullReason(town.name) });
            const relocated = {
                ...state,
                currentRegion: town.name,
                loc,
                stats: {
                    ...(state.stats || {}),
                    marketStore: { ...store, marketTownRoutingVersion: MARKET_TOWN_ROUTING_VERSION, town: town.name, loc }
                }
            };
            return LifeState.upsertState(relocated, 'cold_market_town_rebalanced').then((saved) => {
                if (saved) MarketOpportunity.indexColdStore(saved);
                return { state: saved || relocated, closed: false, relocated: true };
            });
        }
        MarketOpportunity.indexColdStore(state);
        return Promise.resolve({ state, closed: false });
    }

    return closeSellStore(state, timestamp, hasStock ? 'expired' : 'sold_out');
}

// Stores created before town-based routing all lived in Giran.  Move that
// bounded legacy set outside the normal cold-resolve queue, which prioritises
// finite travel transitions and may otherwise starve passive merchant states.
function legacyMarketTownCandidates(states = [], limit = 10) {
    const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
    return states
        .filter((state) => state.phase === 'cold' && state.activity === 'merchant')
        .filter((state) => state.stats?.marketStore)
        .filter((state) => Number(state.stats.marketStore.marketTownRoutingVersion || 0) < MARKET_TOWN_ROUTING_VERSION)
        .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
        .slice(0, safeLimit);
}

function migrateLegacyMarketTowns(limit = 10) {
    return LifeState.legacyMarketTownCandidates(limit, MARKET_TOWN_ROUTING_VERSION).then((states) => {
        const candidates = legacyMarketTownCandidates(states, limit);
        return candidates.reduce((chain, state) => chain.then((migrated) => {
        const store = state.stats.marketStore;
        const targetTownName = targetMarketTownName(state, store.items || []);
        if (store.town === targetTownName) {
            const checked = {
                ...state,
                stats: {
                    ...(state.stats || {}),
                    marketStore: { ...store, marketTownRoutingVersion: MARKET_TOWN_ROUTING_VERSION }
                }
            };
            return LifeState.upsertState(checked, 'cold_market_town_migration_checked').then((saved) => {
                migrated.push({ state: saved || checked, relocated: false });
                return migrated;
            });
        }

        const town = marketTown(targetTownName);
        const loc = marketLocation(town, { state });
        if (!loc) return migrated;
        const relocated = {
            ...state,
            currentRegion: town.name,
            loc,
            stats: {
                ...(state.stats || {}),
                marketStore: { ...store, marketTownRoutingVersion: MARKET_TOWN_ROUTING_VERSION, town: town.name, loc }
            }
        };
        return LifeState.upsertState(relocated, 'cold_market_town_rebalanced').then((saved) => {
            const resolved = saved || relocated;
            MarketOpportunity.indexColdStore(resolved);
            migrated.push({ state: resolved, relocated: true });
            return migrated;
        });
        }), Promise.resolve([]));
    });
}

function expireStaleMarketStores(limit = 10, timestamp = Date.now()) {
    const candidates = typeof LifeState.marketStoreMaintenanceCandidates === 'function'
        ? LifeState.marketStoreMaintenanceCandidates(limit, timestamp)
        : LifeState.expiredMarketStoreCandidates(limit, timestamp);
    return candidates.then((states) => states.reduce((chain, state) => (
        chain.then((maintained) => resolve(state, timestamp).then((result) => {
            if (result.closed || result.revalidated || result.relocated) maintained.push(result);
            return maintained;
        }))
    ), Promise.resolve([])));
}

function reconcileInventory(state) {
    const store = state?.stats?.marketStore;
    if (!state || state.activity !== 'merchant' || !store) return Promise.resolve({ state, reconciled: false });
    if (Number(store.storeType || 1) === 3) {
        MarketOpportunity.indexColdStore(state);
        return Promise.resolve({ state, reconciled: false, closed: false });
    }

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
        timing: { ...(state.timing || {}), nextResolveAt: Date.now() }
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
        if (!saved) return null;
        const hasStock = (saved.stats?.marketStore?.items || []).some((item) => Number(item.count) > 0);
        // Empty stock is a transaction event too; close immediately instead
        // of keeping a dead merchant until the original listing expiry.
        if (!hasStock) return resolve(saved).then((result) => result.state || saved);
        MarketOpportunity.indexColdStore(saved);
        return saved;
    });
}

function withdrawForParty(state, timestamp = Date.now()) {
    const store = state?.stats?.marketStore;
    if (!state || (!store && state.activity !== 'merchant')) {
        return Promise.resolve({ state, withdrawn: false });
    }

    const marketReturn = state.stats?.marketReturn;
    const nextState = {
        ...state,
        activity: 'hunting',
        currentRegion: marketReturn?.regionName || state.currentRegion,
        spotId: marketReturn?.spotId || state.spotId,
        loc: marketReturn?.loc ? { ...marketReturn.loc } : state.loc,
        stats: {
            ...(state.stats || {}),
            marketStore: null,
            marketReturn: null,
            travel: null
        },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp
        }
    };

    // A const-party invitation has priority over the current market shift.
    // Persist the transition before removing market discovery so a failed
    // write leaves the existing offer and store intact.
    return LifeState.upsertState(nextState, 'party_market_withdrawal').then((saved) => ({
        state: saved || nextState,
        previousState: state,
        withdrawn: !!store
    })).then((result) => {
        MarketOpportunity.removeColdStore(state.characterId);
        return result;
    });
}

function restoreAfterPartyFailure(state) {
    const store = state?.stats?.marketStore;
    if (!state || !store) return Promise.resolve({ state, restored: false });
    return LifeState.upsertState(state, 'party_market_withdrawal_rollback').then((saved) => {
        const restored = saved || state;
        MarketOpportunity.indexColdStore(restored);
        return { state: restored, restored: true };
    });
}

module.exports = {
    DEFAULT_LISTING_MS,
    SPECULATIVE_LISTING_MS,
    LISTING_REVIEW_MS,
    SELL_RETRY_DELAY_MS,
    MARKET_TOWN_ROUTING_VERSION,
    marketStoreTitle,
    marketLocation,
    pricingAfterReview,
    targetMarketTownName,
    legacyMarketTownCandidates,
    migrateLegacyMarketTowns,
    expireStaleMarketStores,
    maintainHotMarketStores,
    resolveHotSession,
    open,
    reconcileInventory,
    resolve,
    restoreAfterPartyFailure,
    settle,
    withdrawForParty
};
