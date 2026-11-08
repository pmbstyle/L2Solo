const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const DecisionEvents = invoke('GameServer/Bot/AI/DecisionEvents');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const BotErrands = invoke('GameServer/Bot/Population/BotErrands');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const TravelRoutes = invoke('GameServer/Bot/Travel/TravelRoutes');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const CombinedErrands = require('../Population/CombinedErrandPolicy');
// Other errands are excluded by the activity check and the goal planner.
const MARKET_TRIP_BUSY_FLAGS = ['partyMarketReturn'];

function marketTown(name = 'Giran') {
    const town = Object.values(TownRespawn.towns).find((candidate) => candidate.name === name);
    return TownPathfinder.towns.find((town) => town.name === name)
        || MarketTownPolicy.marketTown(name)
        || (town && { name: town.name, center: { locX: town.locX, locY: town.locY, locZ: town.locZ } })
        || null;
}

// A bot with karma travels only to Floran: ColdTrip.townPlan refuses the
// other towns. The plan's step or errand travels as its decision weighed it
// (EconomicValuation.visitPays, ColdMarketService.acquire; situations step 4
// C9): who sells what is read at the market, on arrival (decision 11-02).
function beginMarketTravel(state, goal, timestamp = Date.now()) {
    if (!state || !goal || ['traveling', 'shopping', 'merchant', 'crafting'].includes(state.activity)) return null;
    const ticket = state.stats?.partyMarketReturn;
    if (Number(ticket?.until) > 0 && Number(ticket.until) <= timestamp)
        state = { ...state, stats: { ...state.stats, partyMarketReturn: null } };
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
    if (sellingInventory && !forcedInventoryCleanup
        && invoke('GameServer/Bot/Economy/ItemDisposition').saleRetryHolds(state)) return null;

    // A sale goes where its goal says (the town the shop opens in), else to
    // the sale town; a new decision of the shop town travels with the bot.
    const sale = sellingInventory && !goal.plan?.marketTown ? MarketTownPolicy.saleTown(state, timestamp) : null;
    const town = marketTown(sale?.town || goal.plan?.marketTown || 'Giran');
    if (!town) return null;
    const from = { ...state.loc };
    const nearestTown = TownRespawn.getClosestTown(from.locX, from.locY, from.locZ);
    const visitStats = shopTown => ({
        marketReturn: { loc: from, regionName: state.currentRegion || null, spotId: state.spotId || null },
        ...(shopTown ? { shopTown } : {})
    });
    const trip = (destination, shopTown = null) => {
        const visit = CombinedErrands.visit(state, destination.name, timestamp, goal.type);
        // A bot already in that town (ColdTrip.townPlan: resting there after a visit with no
        // return) does the step there: no trip across the town, no second arrival (arrived_town).
        if (ColdTrip.townPlan(state, destination.center)?.here) return { ...visit, activity: 'shopping', currentRegion: destination.name,
            stats: { ...visit.stats, ...visitStats(shopTown) },
            timing: { ...(state.timing || {}), activityStartedAt: timestamp, nextResolveAt: timestamp } };
        return ColdTrip.toTown(visit, {
            reason: buyingGear || buyingMaterial || buyingErrand || improving ? goal.plan.expectedBenefit : 'market_sale_inventory',
            from,
            to: { ...destination.center },
            townName: destination.name,
            viaTown: nearestTown.name,
            arrivalActivity: 'shopping',
            arrivalEvent: 'arrived_town'
        }, timestamp, visitStats(shopTown));
    };
    const travel = trip(town, sale?.shopTown);
    // A gear purchase's visit claims the board lines it goes for (BoardClaims), as an errand
    // does, once the bot's write holds the trip.
    if (buyingGear && travel) invoke('GameServer/Bot/Economy/BoardClaims').claimVisit(travel, goal,
        invoke('GameServer/AfkTrade/AfkTradeService').boardIndex());
    if (travel || !sellingInventory) return travel;
    // A bot that cannot pay the gatekeeper to its sale town sells in the town
    // its Scroll of Escape reaches, as a player short of Adena would.
    const local = marketTown(TravelRoutes.landingTown(from).name);
    return local && local.name !== town.name ? trip(local) : null;
}

// A finished visit, far or near, is the bot's look at the market: the board reviews
// its buy ads on it through the shared hot/cold BoardLook. `n` counts visits; the
// existing bounded look owner consumes each new observation once.
function townLooked(stats, timestamp = Date.now()) {
    return { ...(stats || {}), townLook: { at: timestamp, n: Number(stats?.townLook?.n || 0) + 1 } };
}
function finishMarketVisit(state, timestamp = Date.now(), options = {}) {
    const next = finishVisit(state, timestamp, options);
    return next && { ...next, stats: townLooked(next.stats, timestamp) };
}

// The held card's purchase when its town is another one, else null.
function purchaseElsewhere(state, timestamp) {
    // lazy: cycle NeedsEvaluator reads ColdMarketService, which loads this module.
    const goal = invoke('GameServer/Bot/Goals/NeedsEvaluator').goal(state, { now: timestamp });
    return ['upgrade_gear', 'buy_craft_material'].includes(goal?.type) && goal.plan?.marketTown
        && goal.plan.marketTown !== state.currentRegion ? goal : null;
}

function finishVisit(state, timestamp, options) {
    if (!state || !['shopping', 'merchant'].includes(state.activity)) return null;
    if (CombinedErrands.pending(state, timestamp, state.currentRegion).length
        || (state.stats?.townVisit && state.stats.townVisit.completed !== true)) return null;
    // An errand its job decided during the visit for another town (ColdMarketService.acquire:
    // a bot in a visit leaves at its end), else the held step's purchase in another town (the
    // visit deferred it, ColdMarketService.tryPurchase), is the visit's next trip, before the
    // way back: a C4 player done in one town goes on to the next for what he still has to buy
    // there, then back to hunt.
    const solo = !state.stats?.partyMarketReturn && !state.party?.partyId && !state.partyId;
    const errand = solo ? CombinedErrands.pending(state, timestamp).find(pending => pending.town !== state.currentRegion) : null;
    // lazy: cycle ColdMarketService loads this module.
    const next = errand ? invoke('GameServer/Bot/Economy/ColdMarketService').errandGoal(errand)
        : solo ? purchaseElsewhere(state, timestamp) : null;
    const onward = next && beginMarketTravel({ ...state, activity: 'hunting' }, next, timestamp);
    if (onward) return { ...onward, stats: { ...onward.stats, marketReturn: state.stats?.marketReturn || onward.stats.marketReturn } };
    let destination = state.stats?.marketReturn;
    const returningParty = state.stats?.partyMarketReturn
        ? invoke('GameServer/Bot/Population/BackgroundPartyState').find(state.stats.partyMarketReturn.partyId) : null;
    let clanReturn = !!state.stats?.partyMarketReturn;
    if (returningParty?.status === 'active') {
        const leader = BotLifeState.cachedState(returningParty.leaderId);
        if (leader?.loc) destination = { loc: leader.loc, spotId: returningParty.spotId, regionName: leader.currentRegion };
    }
    if (!destination?.loc && options.recoverMissingReturn) {
        // No saved return: the spot it goes to when sent to hunt (the worker's
        // choice, DecisionEvents.heldSpotOf; main never chooses one). A party
        // member's is its party's (temporary: until the party holds its spot as a
        // decision; the party's objective spot, else the spot it hunts), when its
        // marks allow it. With none it rests in town: its next step publishes the
        // choice (no earning answer yet: woken, Situations.woken, decided there)
        // and the worker routes it (BotRoute).
        const party = state.party?.partyId ? invoke('GameServer/Bot/Population/BackgroundPartyState').find(state.party.partyId) : null;
        const partySpot = party?.stats?.objective?.spotId ?? party?.spotId ?? null;
        const heldId = !state.party?.partyId ? DecisionEvents.heldSpotOf(state)
            : partySpot != null && !SpotRiskPolicy.excludedSpotIdsForStates([state]).has(String(partySpot)) ? partySpot : null;
        const fallback = heldId != null ? SpotProfiles.findById(heldId) : null;
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
    // Where the bot hunts next is the worker's decision, read here: the spot it goes
    // to when sent to hunt (DecisionEvents.heldSpotOf: the worker's route choice, none
    // its exclusions rule out),
    // else only then the spot it hunted before the trip, unless it died there
    // (spotBackoff). Main never searches. A full spot is met at arrival
    // (ROUTE-ROOM-4) and a spot the bot may no longer hunt by the worker's next
    // trip start: one trip there before the worker moves it.
    let selectedSpot = clanReturn ? savedSpot : null;
    if (returnState && !clanReturn) {
        const heldId = DecisionEvents.heldSpotOf(returnState);
        selectedSpot = (heldId != null ? SpotProfiles.findById(heldId) : null) || (spotBackoff ? null : savedSpot);
    }
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

module.exports = { beginMarketTravel, finishMarketVisit, townLooked, marketTownForSale: MarketTownPolicy.targetTownForSale };
