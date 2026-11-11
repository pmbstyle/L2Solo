const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
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
const PartyMarketBreak = require('../Population/PartyMarketBreak');
// Other errands are excluded by the activity check and the goal planner.
const MARKET_TRIP_BUSY_FLAGS = ['partyMarketReturn'];

function marketTown(name = 'Giran') {
    const town = Object.values(TownRespawn.towns).find((candidate) => candidate.name === name);
    return TownPathfinder.towns.find((town) => town.name === name)
        || MarketTownPolicy.marketTown(name)
        || (town && { name: town.name, center: { locX: town.locX, locY: town.locY, locZ: town.locZ } })
        || null;
}

// The visit of a bot standing in its town already (ColdTrip.townPlan: here), done where it
// stands: no trip across the town, no second arrival (arrived_town); due now, its way back
// `marketReturn`. Null when it stands in no town or in another one. Cold (beginMarketTravel)
// and a body cooled in town on its trip (BotLifeState.writeColdRow) build the visit here.
function visitHere(state, townName, marketReturn, timestamp = Date.now(), reason = null, extraStats = {}) {
    const town = marketTown(townName);
    if (!town || !ColdTrip.townPlan(state, town.center)?.here) return null;
    const visit = CombinedErrands.visit(state, town.name, timestamp, reason);
    return { ...visit, activity: 'shopping', currentRegion: town.name,
        stats: { ...visit.stats, marketReturn, ...extraStats },
        timing: { ...(state.timing || {}), activityStartedAt: timestamp, nextResolveAt: timestamp } };
}

// A bot with karma travels only to Floran: ColdTrip.townPlan refuses the
// other towns. The plan's step or errand travels as its decision weighed it
// (EconomicValuation.visitPays, ColdMarketService.acquire): who sells what
// is read at the market, on arrival.
function beginMarketTravel(state, goal, timestamp = Date.now()) {
    if (!state || !goal || ['traveling', 'shopping', 'merchant', 'crafting'].includes(state.activity)) return null;
    const ticket = state.stats?.partyMarketReturn;
    if (ticket && !PartyMarketBreak.held(ticket, timestamp))
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
        // A bot already in that town (resting there after a visit with no return) does the
        // step there.
        const { marketReturn, ...extraStats } = visitStats(shopTown);
        const here = visitHere(state, destination.name, marketReturn, timestamp, goal.type, extraStats);
        if (here) return here;
        return ColdTrip.toTown(CombinedErrands.visit(state, destination.name, timestamp, goal.type), {
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
    const returningParty = state.stats?.partyMarketReturn
        ? invoke('GameServer/Bot/Population/BackgroundPartyState').find(state.stats.partyMarketReturn.partyId) : null;
    // A solo bot's visit (its party return gone with its party, too) hands it back to the
    // worker: it rests in town, due now; the worker's next step ends the rest, due now again
    // (BackgroundResolver.resolveRest), and the one after sends it to the spot of its one
    // choice (BotRoute.huntSpot). Main never picks where it hunts. It stands on no
    // spot in town (a town trip keeps the field it left as its spot: read as standing
    // there, the worker would start no trip).
    // A visit with no way back saved ends only where its caller asks (recoverMissingReturn).
    if (!state.party?.partyId && !state.partyId && !returningParty) return !state.stats?.marketReturn?.loc && !options.recoverMissingReturn ? null : {
        ...state, activity: 'resting', spotId: null,
        stats: { ...state.stats, marketReturn: null, partyMarketReturn: null, shopTown: null, restUntil: timestamp },
        timing: { ...state.timing, activityStartedAt: timestamp, nextResolveAt: timestamp }
    };
    let destination = state.stats?.marketReturn;
    let clanReturn = !!state.stats?.partyMarketReturn;
    if (returningParty?.status === 'active') {
        const leader = BotLifeState.cachedState(returningParty.leaderId);
        if (leader?.loc) destination = { loc: leader.loc, spotId: returningParty.spotId, regionName: leader.currentRegion };
    }
    if (!destination?.loc && options.recoverMissingReturn) {
        // No saved return: a party member's is its party's (temporary: until the party
        // holds its spot as a decision; the party's objective spot, else the spot it
        // hunts), when its marks allow it. With none it rests in town until the worker's
        // next step.
        const party = state.party?.partyId ? invoke('GameServer/Bot/Population/BackgroundPartyState').find(state.party.partyId) : null;
        const partySpot = party?.stats?.objective?.spotId ?? party?.spotId ?? null;
        const heldId = partySpot != null && !SpotRiskPolicy.excludedSpotIdsForStates([state]).has(String(partySpot)) ? partySpot : null;
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
    // A party member goes back to its party: the clan's waiting point, else its party's spot.
    const to = clanReturn || !savedSpot ? { ...destination.loc }
        : SpotService.arrivalPointForState(state, savedSpot) || { ...destination.loc };
    const regionName = savedSpot?.name || destination.regionName;
    const destinationTown = TownRespawn.getClosestTown(to.locX, to.locY, to.locZ);
    return ColdTrip.toSpot(state, {
        reason: 'return_after_market',
        from,
        to,
        regionName,
        spotId: savedSpot?.id || destination.spotId,
        townName: destinationTown?.name || regionName || 'Hunting Ground',
        viaTown: destinationTown?.name || null,
        arrivalActivity: clanReturn ? 'party_wait' : 'hunting',
        arrivalEvent: 'returned_to_spot',
        clearMarketReturn: true
    }, timestamp, { extraStats: clanReturn ? { shopTown: null } : { partyMarketReturn: null, shopTown: null } });
}

module.exports = { beginMarketTravel, visitHere, finishMarketVisit, townLooked, marketTownForSale: MarketTownPolicy.targetTownForSale };
