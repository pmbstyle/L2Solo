const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');

function distance2d(a, b) {
    const dx = Number(a?.locX || 0) - Number(b?.locX || 0);
    const dy = Number(a?.locY || 0) - Number(b?.locY || 0);
    return Math.sqrt((dx * dx) + (dy * dy));
}

function marketTown() {
    return TownPathfinder.towns.find((town) => town.name === 'Giran') || null;
}

function beginMarketTravel(state, goal, timestamp = Date.now()) {
    if (!state || !goal || ['traveling', 'shopping', 'merchant'].includes(state.activity)) return null;
    const buyingGear = goal.type === 'upgrade_gear' && goal.plan?.expectedBenefit === 'market_search_for_weapon';
    const sellingInventory = goal.type === 'sell_inventory' && goal.plan?.expectedBenefit === 'market_sale_inventory';
    if (!buyingGear && !sellingInventory) return null;
    if (buyingGear && Number(state.stats?.marketRetryAfter || 0) > timestamp) return null;
    if (sellingInventory && Number(state.stats?.marketSellRetryAfter || 0) > timestamp) return null;

    const town = marketTown();
    if (!town) return null;
    const from = { ...state.loc };
    const to = { ...town.center };
    const durationMs = Math.max(30000, Math.min(20 * 60 * 1000, Math.round((distance2d(from, to) / 180) * 1000)));
    return {
        ...state,
        activity: 'traveling',
        stats: {
            ...(state.stats || {}),
            marketReturn: {
                loc: from,
                regionName: state.currentRegion || null,
                spotId: state.spotId || null
            },
            travel: {
                reason: buyingGear ? 'market_search_for_weapon' : 'market_sale_inventory',
                from,
                to,
                townName: town.name,
                startedAt: timestamp,
                arrivalAt: timestamp + durationMs
            }
        },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + 30000
        }
    };
}

function finishMarketVisit(state, timestamp = Date.now()) {
    if (!state || !['shopping', 'merchant'].includes(state.activity)) return null;
    const destination = state.stats?.marketReturn;
    if (!destination?.loc) return null;

    const from = { ...state.loc };
    const to = { ...destination.loc };
    const durationMs = Math.max(30000, Math.min(20 * 60 * 1000, Math.round((distance2d(from, to) / 180) * 1000)));
    return {
        ...state,
        activity: 'traveling',
        stats: {
            ...(state.stats || {}),
            travel: {
                reason: 'return_after_market',
                from,
                to,
                regionName: destination.regionName,
                spotId: destination.spotId,
                arrivalActivity: 'hunting',
                arrivalEvent: 'returned_to_spot',
                clearMarketReturn: true,
                startedAt: timestamp,
                arrivalAt: timestamp + durationMs
            }
        },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + 30000
        }
    };
}

module.exports = { beginMarketTravel, finishMarketVisit };
