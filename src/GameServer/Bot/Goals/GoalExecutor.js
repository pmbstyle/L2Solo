const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const BotErrands = invoke('GameServer/Bot/Population/BotErrands');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const TravelRoutes = invoke('GameServer/Bot/Travel/TravelRoutes');
const CombinedErrands = require('../Population/CombinedErrandPolicy');
// Other errands are excluded by the activity check and the goal planner.
const MARKET_TRIP_BUSY_FLAGS = ['partyMarketReturn'];

const MARKET_TRAVEL_MS = ColdTrip.AUTHOR_TRIP_MS;
const GATEKEEPER_SPOT_TRAVEL_MS = ColdTrip.AUTHOR_TRIP_MS;

function marketTown(name = 'Giran') {
    const town = Object.values(TownRespawn.towns).find((candidate) => candidate.name === name);
    return TownPathfinder.towns.find((town) => town.name === name)
        || MarketTownPolicy.marketTown(name)
        || (town && { name: town.name, center: { locX: town.locX, locY: town.locY, locZ: town.locZ } })
        || null;
}

// A bot with karma travels only to Floran: ColdTrip.townPlan refuses the
// other towns.
function beginMarketTravel(state, goal, timestamp = Date.now()) {
    if (!state || !goal || ['traveling', 'shopping', 'merchant', 'crafting'].includes(state.activity)) return null;
    if (BotErrands.busyWith(state, MARKET_TRIP_BUSY_FLAGS)) return null;
    const buyingGear = goal.type === 'upgrade_gear'
        && ['market_search_for_weapon', 'market_search_for_gear'].includes(goal.plan?.expectedBenefit);
    const buyingMaterial = goal.type === 'buy_craft_material' && goal.plan?.expectedBenefit === 'market_buy_craft_material';
    // An errand: a purchase another job planned in its town (ColdMarketService.acquire).
    const buyingErrand = goal.type === 'market_errand' && !!goal.plan?.marketTown;
    const sellingInventory = goal.type === 'sell_inventory' && goal.plan?.expectedBenefit === 'market_sale_inventory';
    const cleanupReason = goal.target?.cleanupReason || goal.plan?.cleanupReason;
    const forcedInventoryCleanup = sellingInventory && !!cleanupReason && cleanupReason !== 'inventory_half_full';
    const improving = goal.type === 'improving' && goal.target?.improvement?.kind !== 'enchant';
    if (!buyingGear && !buyingMaterial && !buyingErrand && !sellingInventory && !improving) return null;
    if (!improving && invoke('GameServer/Bot/Economy/BotAfkMarketService').canTradeRemotely(state, goal)) return null;
    if ((buyingGear || buyingMaterial) && Number(state.stats?.marketRetryAfter || 0) > timestamp) return null;
    if (sellingInventory && !forcedInventoryCleanup && Number(state.stats?.marketSellRetryAfter || 0) > timestamp) return null;

    // A sale goes where its goal says (the town the shop opens in), else to
    // the sale town; a new decision of the shop town travels with the bot.
    const sale = sellingInventory && !goal.plan?.marketTown ? MarketTownPolicy.saleTown(state, timestamp) : null;
    const town = marketTown(sale?.town || goal.plan?.marketTown || 'Giran');
    if (!town) return null;
    const from = { ...state.loc };
    const nearestTown = TownRespawn.getClosestTown(from.locX, from.locY, from.locZ);
    const trip = (destination, shopTown = null) => ColdTrip.toTown(CombinedErrands.visit(state, destination.name, timestamp, goal.type), {
        reason: buyingGear || buyingMaterial || buyingErrand || improving ? goal.plan.expectedBenefit : 'market_sale_inventory',
        from,
        to: { ...destination.center },
        townName: destination.name,
        viaTown: nearestTown.name,
        arrivalActivity: 'shopping',
        arrivalEvent: 'arrived_town'
    }, timestamp, {
        marketReturn: { loc: from, regionName: state.currentRegion || null, spotId: state.spotId || null },
        ...(shopTown ? { shopTown } : {})
    });
    const travel = trip(town, sale?.shopTown);
    if (travel || !sellingInventory) return travel;
    // A bot that cannot pay the gatekeeper to its sale town sells in the town
    // its Scroll of Escape reaches, as a player short of Adena would.
    const local = marketTown(TravelRoutes.landingTown(from).name);
    return local && local.name !== town.name ? trip(local) : null;
}

// A finished visit is the bot's look at the market: the board reviews its
// buy ads on it through the shared hot/cold BoardLook. `n` counts visits;
// the existing bounded look owner consumes each new observation once.
function finishMarketVisit(state, timestamp = Date.now(), options = {}) {
    const next = finishVisit(state, timestamp, options);
    if (!next) return next;
    return { ...next, stats: { ...(next.stats || {}),
        townLook: { at: timestamp, n: Number(state.stats?.townLook?.n || 0) + 1 } } };
}

function finishVisit(state, timestamp, options) {
    if (!state || !['shopping', 'merchant'].includes(state.activity)) return null;
    if (CombinedErrands.pending(state, timestamp, state.currentRegion).length
        || (state.stats?.townVisit && state.stats.townVisit.completed !== true)) return null;
    let destination = state.stats?.marketReturn;
    const returningParty = state.stats?.partyMarketReturn
        ? invoke('GameServer/Bot/Population/BackgroundPartyState').find(state.stats.partyMarketReturn.partyId) : null;
    let clanReturn = !!state.stats?.partyMarketReturn;
    if (returningParty?.status === 'active') {
        const leader = invoke('GameServer/Bot/Population/BotLifeState').cachedState(returningParty.leaderId);
        if (leader?.loc) destination = { loc: leader.loc, spotId: returningParty.spotId, regionName: leader.currentRegion };
    }
    if (!destination?.loc && options.recoverMissingReturn) {
        const fallback = invoke('GameServer/Bot/Population/SpotProfiles').findForState({
            ...state, activity: 'hunting'
        }, { timestamp });
        const loc = fallback && SpotService.arrivalPointForState(state, fallback);
        if (loc) {
            destination = { loc, spotId: fallback.id, regionName: fallback.name };
            clanReturn = false;
        }
        else return {
            ...state, activity: 'resting',
            stats: { ...state.stats, marketReturn: null, partyMarketReturn: null, restUntil: timestamp + 30000 },
            timing: { ...state.timing, activityStartedAt: timestamp, nextResolveAt: timestamp + 30000 }
        };
    }
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
    const spotBackoff = returnState && !clanReturn
        ? SpotRiskPolicy.backoffForStates([returnState], destination.spotId, timestamp)
        : null;
    const selectedSpot = clanReturn ? savedSpot : returnState
        ? invoke('GameServer/Bot/Population/SpotProfiles').findForState(returnState, { timestamp })
            || (spotBackoff ? null : savedSpot)
        : null;
    // Remaining in town is safer than silently returning to a spot that is
    // already over the death threshold. A later lifecycle pass can retry
    // once another suitable route becomes available.
    if (spotBackoff && !selectedSpot) return null;
    const to = clanReturn ? { ...destination.loc } : selectedSpot
        ? SpotService.arrivalPointForState(state, selectedSpot) || { ...destination.loc }
        : { ...destination.loc };
    const regionName = selectedSpot?.name || destination.regionName;
    const spotId = selectedSpot?.id || destination.spotId;
    const destinationTown = TownRespawn.getClosestTown(to.locX, to.locY, to.locZ);
    const routedState = spotBackoff
        ? SpotRiskPolicy.withBackoff(state, spotBackoff, timestamp)
        : state;
    return ColdTrip.toSpot(routedState, {
        reason: spotBackoff ? 'death_pressure_replan' : 'return_after_market',
        from,
        to,
        regionName,
        spotId,
        townName: destinationTown?.name || regionName || 'Hunting Ground',
        viaTown: destinationTown?.name || null,
        arrivalActivity: clanReturn ? 'party_wait' : 'hunting',
        arrivalEvent: spotBackoff ? 'arrived_hunting_ground' : 'returned_to_spot',
        ...(spotBackoff ? { cause: 'death_pressure' } : {}),
        clearMarketReturn: true
    }, timestamp, { extraStats: clanReturn ? { shopTown: null } : { partyMarketReturn: null, shopTown: null } });
}

module.exports = { MARKET_TRAVEL_MS, GATEKEEPER_SPOT_TRAVEL_MS, beginMarketTravel, finishMarketVisit, marketTownForSale: MarketTownPolicy.targetTownForSale };
