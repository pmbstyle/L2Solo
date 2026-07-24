const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');

const MARKET_TRAVEL_MS = 25 * 1000;
const GATEKEEPER_SPOT_TRAVEL_MS = 25 * 1000;

function marketTown(name = 'Giran') {
    return TownPathfinder.towns.find((town) => town.name === name)
        || MarketTownPolicy.marketTown(name)
        || TownPathfinder.towns.find((town) => town.name === 'Giran')
        || null;
}

function beginMarketTravel(state, goal, timestamp = Date.now()) {
    if (!state || !goal || ['traveling', 'shopping', 'merchant', 'crafting'].includes(state.activity)) return null;
    const buyingGear = goal.type === 'upgrade_gear'
        && ['market_search_for_weapon', 'market_search_for_gear'].includes(goal.plan?.expectedBenefit);
    const buyingMaterial = goal.type === 'buy_craft_material' && goal.plan?.expectedBenefit === 'market_buy_craft_material';
    const sellingInventory = goal.type === 'sell_inventory' && goal.plan?.expectedBenefit === 'market_sale_inventory';
    if (!buyingGear && !buyingMaterial && !sellingInventory) return null;
    if ((buyingGear || buyingMaterial) && Number(state.stats?.marketRetryAfter || 0) > timestamp) return null;
    if (sellingInventory && Number(state.stats?.marketSellRetryAfter || 0) > timestamp) return null;

    const town = sellingInventory
        ? marketTown(MarketTownPolicy.targetTownForSale(state))
        : marketTown(goal.plan?.marketTown || 'Giran');
    if (!town) return null;
    const from = { ...state.loc };
    const nearestTown = TownRespawn.getClosestTown(from.locX, from.locY);
    const to = { ...town.center };
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
                reason: buyingGear || buyingMaterial ? goal.plan.expectedBenefit : 'market_sale_inventory',
                from,
                to,
                townName: town.name,
                viaTown: nearestTown.name,
                method: 'soe_gatekeeper',
                startedAt: timestamp,
                arrivalAt: timestamp + MARKET_TRAVEL_MS
            }
        },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            // Travel is a finite transition.  There is no state to simulate
            // while a cold bot is casting SoE / waiting for gatekeeper travel.
            nextResolveAt: timestamp + MARKET_TRAVEL_MS
        }
    };
}

function finishMarketVisit(state, timestamp = Date.now()) {
    if (!state || !['shopping', 'merchant'].includes(state.activity)) return null;
    const destination = state.stats?.marketReturn;
    if (!destination?.loc) return null;

    const from = { ...state.loc };
    const to = { ...destination.loc };
    const destinationTown = TownRespawn.getClosestTown(to.locX, to.locY);
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
                townName: destinationTown?.name || destination.regionName || 'Hunting Ground',
                viaTown: destinationTown?.name || null,
                method: 'gatekeeper_spot',
                arrivalActivity: 'hunting',
                arrivalEvent: 'returned_to_spot',
                clearMarketReturn: true,
                startedAt: timestamp,
                arrivalAt: timestamp + GATEKEEPER_SPOT_TRAVEL_MS
            }
        },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + GATEKEEPER_SPOT_TRAVEL_MS
        }
    };
}

module.exports = { MARKET_TRAVEL_MS, GATEKEEPER_SPOT_TRAVEL_MS, beginMarketTravel, finishMarketVisit, marketTownForSale: MarketTownPolicy.targetTownForSale };
