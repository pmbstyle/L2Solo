const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const ColdSafeEnchantService = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const { marketStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');

const SELL_RETRY_DELAY_MS = 30 * 60 * 1000;

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

// The centre of a market town: the place of a board ad, which stands nowhere.
function townCenter(name) {
    const town = marketTown(name);
    return town?.center ? { ...town.center } : null;
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
        return LifeState.learnCraftableRecipes(state)
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
    return ColdSafeEnchantService.enchantSafe(state, options)
        .then((enchantResult) => LifeState.learnCraftableRecipes(enchantResult.state || state))
        .then((preparedState) => storedAmounts(preparedState || state).then((stored) => ({ preparedState, stored })))
        .then(({ preparedState, stored }) => {
    // The warehouse room of each item, and one decision point for the visit.
    options = { ...options, stored, now: timestamp };
    state = preparedState || state;
    const forcedCleanup = options.forcedCleanup || null;
    if (forcedCleanup?.cleanupReason === 'npc_only_inventory') {
        return preTradeNpcCleanup(state, forcedCleanup, timestamp);
    }
    const initialItems = ItemDisposition.saleCandidates(state, options);
    if (!initialItems.length) {
        return { state: deferSellRetry(state), listed: false, reason: 'nothing_to_sell' };
    }

    // GoalExecutor chooses the best buyer town before travel. At this stage
    // the bot must trade only with the city it has actually reached.
    const town = marketTown(options.town || state.currentRegion || targetMarketTownName(state, initialItems));
    // One sale decision for the visit (one decision point, evaluated once):
    // the buy ads it answers here, the NPC sale, the board's listings.
    const market = invoke('GameServer/Bot/Economy/BotAfkMarketService').saleDecision(state, options);
    const initialMarket = market;
    return BuyStoreService.sellToBestBuyer(state, town?.name, { answers: market.answers }).then((dynamicBuyerSale) => StaticBuyerService.sell(dynamicBuyerSale.state || state, town?.name).then((buyerSale) => {
    const saleState = buyerSale.state || dynamicBuyerSale.state || state;
    return LifeState.applyNpcLiquidation(saleState, market.npc, {
        source: 'pre_market_junk',
        town: town?.name || saleState.currentRegion || null
    }).then((liquidatedState) => {
    const marketState = liquidatedState || saleState;
    const items = market.listings;
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
    // The board replaced the stall (step 3.3): the listings go to the bot's
    // shop and, past its lines, to sell ads; their items leave the bag into
    // the records. The bot then goes back to its hunt.
    return invoke('GameServer/Bot/Economy/BotAfkMarketService').listOnBoard(marketState, { ...options, decided: market }).then((board) => {
        const boardState = board.state || marketState;
        if (board.shopTown) return travelToShopTown(boardState, board, timestamp);
        if (!board.listed) {
            return BotWarehouse.depositCold(boardState).then((warehouse) => ({
                state: deferSellRetry(warehouse.state || boardState),
                listed: false,
                reason: board.reason || 'board_refused',
                buyerSale,
                dynamicBuyerSale,
                warehouse,
                market
            }));
        }
        MarketTelemetry.listingOpened({ speculative: false });
        return BotWarehouse.depositCold(boardState).then((warehouse) => {
            const deposited = warehouse.state || boardState;
            const stored = deferSellRetry(deposited);
            const returning = GoalExecutor.finishMarketVisit(stored, timestamp, { recoverMissingReturn: true }) || stored;
            return LifeState.upsertState(returning, 'cold_market_board_listing').then((saved) => ({
                state: saved || returning,
                listed: true,
                itemCount: board.listed,
                buyerSale,
                dynamicBuyerSale,
                warehouse,
                market
            }));
        });
    });
    });
    }));
    });
}

// The bot's shop opens in another town than the one it sold in (its one
// roll, MarketTownPolicy.openingTown): it travels there with its lines and
// keeps its way back to its spot; the visit there opens the shop. When it
// cannot travel, its lines wait in the bag for the next visit.
function travelToShopTown(state, board, timestamp) {
    const stats = { ...(state.stats || {}), shopTown: state.stats?.shopTown || { town: board.shopTown, at: timestamp } };
    const goal = { type: 'sell_inventory', status: 'active',
        plan: { expectedBenefit: 'market_sale_inventory', marketTown: board.shopTown } };
    const travel = GoalExecutor.beginMarketTravel({ ...state, activity: 'hunting', stats }, goal, timestamp);
    if (travel) travel.stats.marketReturn = state.stats?.marketReturn || travel.stats.marketReturn;
    const next = travel || GoalExecutor.finishMarketVisit({ ...state, stats }, timestamp, { recoverMissingReturn: true })
        || { ...state, stats };
    return LifeState.upsertState(next, travel ? 'cold_market_shop_town_trip' : 'cold_market_shop_town_unreached')
        .then((saved) => ({ state: saved || next, listed: board.listed > 0, itemCount: board.listed,
            reason: travel ? 'shop_town_trip' : 'shop_town_unreached', shopTown: board.shopTown }));
}

// A merchant without a stall: the board replaced the stalls (step 3.3), and
// an old state, or historical cleanup, can still say merchant. There is no
// expiry event to release it: it goes back to its trip or its hunt.
function resolve(state, timestamp = Date.now()) {
    if (!state || state.activity !== 'merchant') return Promise.resolve({ state, closed: false });
    if (invoke('GameServer/Bot/AI/BotServiceIdentity').isStaticService(state)) {
        return Promise.resolve({ state, closed: false });
    }
    const recovered = { ...state, activity: state.stats?.marketReturn ? 'shopping' : 'hunting',
        stats: { ...(state.stats || {}), marketStore: null },
        timing: { ...(state.timing || {}), nextResolveAt: timestamp } };
    return LifeState.upsertState(recovered, 'orphaned_market_recovery').then(saved => {
        if (!saved) return { state, closed: false };
        return { state: saved, closed: true, reason: 'orphaned_market_recovery' };
    });
}

// What the bot keeps in its warehouse, by item: its room to keep more.
function storedAmounts(state) {
    if (!state?.characterId) return Promise.resolve(new Map());
    return invoke('Database').fetchWarehouseItems(state.characterId).then((rows) => {
        const stored = new Map();
        for (const row of rows || []) stored.set(Number(row.selfId), Number(stored.get(Number(row.selfId)) || 0) + Number(row.amount || 0));
        return stored;
    }).catch(() => new Map());
}

module.exports = {
    SELL_RETRY_DELAY_MS,
    marketStoreTitle,
    marketLocation,
    targetMarketTownName,
    townCenter,
    open,
    resolve
};
