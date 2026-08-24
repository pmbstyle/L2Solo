const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');

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
    const forcedInventoryCleanup = sellingInventory && !!(goal.target?.cleanupReason || goal.plan?.cleanupReason);
    if (!buyingGear && !buyingMaterial && !sellingInventory) return null;
    if ((buyingGear || buyingMaterial) && Number(state.stats?.marketRetryAfter || 0) > timestamp) return null;
    if (sellingInventory && !forcedInventoryCleanup && Number(state.stats?.marketSellRetryAfter || 0) > timestamp) return null;

    const town = sellingInventory
        ? marketTown(MarketTownPolicy.targetTownForSale(state))
        : marketTown(goal.plan?.marketTown || 'Giran');
    if (!town) return null;
    const from = { ...state.loc };
    const nearestTown = TownRespawn.getClosestTown(from.locX, from.locY, from.locZ);
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
                arrivalActivity: 'shopping',
                arrivalEvent: 'arrived_town',
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
    const savedSpot = destination.spotId ? SpotService.findById(destination.spotId) : null;
    const returnState = savedSpot
        ? {
            ...state,
            activity: 'hunting',
            currentRegion: destination.regionName || state.currentRegion,
            loc: { ...destination.loc },
            spotId: destination.spotId
        }
        : null;
    const spotBackoff = returnState
        ? SpotRiskPolicy.backoffForStates([returnState], destination.spotId, timestamp)
        : null;
    const selectedSpot = returnState
        ? invoke('GameServer/Bot/Population/SpotProfiles').findForState(returnState, { timestamp })
            || (spotBackoff ? null : savedSpot)
        : null;
    // Remaining in town is safer than silently returning to a spot that is
    // already over the death threshold. A later lifecycle pass can retry
    // once another suitable route becomes available.
    if (spotBackoff && !selectedSpot) return null;
    const to = selectedSpot
        ? SpotService.arrivalPointForState(state, selectedSpot) || { ...destination.loc }
        : { ...destination.loc };
    const regionName = selectedSpot?.name || destination.regionName;
    const spotId = selectedSpot?.id || destination.spotId;
    const destinationTown = TownRespawn.getClosestTown(to.locX, to.locY, to.locZ);
    const routedState = spotBackoff
        ? SpotRiskPolicy.withBackoff(state, spotBackoff, timestamp)
        : state;
    return {
        ...routedState,
        activity: 'traveling',
        stats: {
            ...(routedState.stats || {}),
            travel: {
                reason: spotBackoff ? 'death_pressure_replan' : 'return_after_market',
                from,
                to,
                regionName,
                spotId,
                townName: destinationTown?.name || regionName || 'Hunting Ground',
                viaTown: destinationTown?.name || null,
                method: 'gatekeeper_spot',
                arrivalActivity: 'hunting',
                arrivalEvent: spotBackoff ? 'arrived_hunting_ground' : 'returned_to_spot',
                ...(spotBackoff ? { cause: 'death_pressure' } : {}),
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
