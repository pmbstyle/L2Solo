'use strict';

// One public half-hour demand window, not a lifetime recipe multiplier.
// This projects a finite, fully financed series. Native commands retain
// their own MP/quantity limits and recheck every subsequent purchase.
const HOURS = .5;

function projectState(state, recipe, context) {
    const mp = Number(state.vitals?.mp), capacity = Number(state.vitals?.maxMp ?? context.mpCapacity);
    const regen = Number(context.mpPerHour), cost = Number(recipe.mpCost);
    if (![mp, capacity, regen, cost].every(Number.isFinite) || mp < cost || capacity < cost || regen <= 0 || cost <= 0) return null;
    // Refinance all spent MP inside the window. Stored MP still bounds the
    // next command; it does not give one recipe extra free forecast time.
    // Thus existing native MP bands also remain exact for this projection.
    return { ...state, vitals: { ...state.vitals,
        mp: Math.min(require('./WealthCraftPolicy').MAX_BATCHES * cost, regen * HOURS) } };
}

function sameSource(left, right) {
    if (!left || !right) return left == null && right == null;
    if (Number(left.selfId) !== Number(right.selfId) || left.source !== right.source || left.town !== right.town) return false;
    if (left.source === 'afk') return Number(left.offer?.lineId ?? left.lineId) === Number(right.offer?.lineId ?? right.lineId)
        && Number(left.offer?.recordId ?? left.recordId) === Number(right.offer?.recordId ?? right.recordId);
    return left.source !== 'craft' || Number(left.recipe?.recipeId) === Number(right.recipe?.recipeId);
}

function sameExit(left, right) {
    if (!left || !right || left.type !== right.type || left.town !== right.town) return false;
    if (left.type === 'listing') return left.forecast?.origin === right.forecast?.origin;
    if (left.type === 'afk') return ['recordId', 'lineId'].every(key => Number(left.offer?.[key]) === Number(right.offer?.[key]))
        && Number(left.offer?.revision ?? left.offer?.expectedRevision) === Number(right.offer?.revision ?? right.offer?.expectedRevision)
        && Number(left.price) === Number(right.price);
    return left.type === 'static' && left.buyerName === right.buyerName && Number(left.price) === Number(right.price);
}

// Keep only the remaining inputs of an accepted finite series. A public
// buyer's withdrawal frees them immediately, including during town cleanup.
function retainedBatches(state, board, timestamp = Date.now()) {
    const series = state.stats?.shotCraft?.series;
    if (!series || !Number.isSafeInteger(series.batches) || series.batches < 1 || series.batches > 64
        || !Number.isFinite(series.at) || timestamp >= series.at + HOURS * 3600000
        || !Array.isArray(series.exit) || series.exit.length !== 4) return 0;
    const recipe = require('../../Items/C4RecipeItems').resolveByRecipeId(Number(series.recipeId));
    if (!recipe || !require('./ProductionPolicy').GRADED_SHOTS.has(Number(recipe.productId))) return 0;
    const [recordId,lineId,price] = series.exit;
    let units = 0;
    if (recordId > 0) {
        const bid = board?.list(recipe.productId,3).find(row => Number(row.recordId) === recordId
            && Number(row.lineId) === lineId && Number(row.ownerId) !== Number(state.characterId));
        if (bid && Number(bid.price) >= price) units = Number(bid.count);
    } else if (recordId === -2 || recordId === -3) {
        const town = require('./ShotCraftPolicy').townForCode(lineId);
        const demand = require('./MarketDemand').forecast(recipe.productId,town,
            {board,ownerId:state.characterId,timestamp});
        const origin = recordId === -2 ? 'public_item_trades' : 'public_buy_interest';
        const source = (demand?.alternatives || [demand]).find(row => row?.origin === origin);
        units = Number((source?.atPrice?.(price) || source)?.applicableUnits || 0);
    }
    const owned = Number(state.inventory?.[recipe.productId]?.amount || 0)
        + Number(state.acceptedIncoming?.[recipe.productId] || 0);
    const reserve = Number.isSafeInteger(series.ownReserve) && series.ownReserve > 0 ? series.ownReserve : 0;
    const personalMissing = Math.max(0,reserve-owned);
    let marketStock = Math.max(0,owned-reserve);
    for (const line of board?.ownerLines(Number(state.characterId)) || [])
        if (line.storeType === 1 && line.custodyPolicy !== 1 && Number(line.selfId) === Number(recipe.productId))
            marketStock += Number(line.count || 0);
    return Number.isFinite(units) ? Math.min(series.batches,
        Math.ceil((personalMissing+Math.max(0,units-marketStock))/Number(recipe.productCount))) : 0;
}

function value(route, state, first, context) {
    if (!route || Number(route.recipe.successRate) !== 100 || route.batches <= first.batches
        || !sameExit(route.exit, first.exit)) return null;
    const regen = Number(context.mpPerHour), price = Number(context.moneyPrice);
    const capacity = Math.floor(Number(state.vitals?.maxMp ?? context.mpCapacity) / Number(route.recipe.mpCost));
    if (!(regen > 0 && price > 0 && capacity > 0)) return null;
    const cycles = 1 + Math.ceil(Math.max(0, route.batches - first.batches) / capacity);
    // Gear is broken once; ready crystals are bought per physical command.
    // One town shared by replenishment and delivery is charged once.
    const oneOffGear = first.gear && first.gear.source !== 'crystals';
    const towns = new Set(route.basket.purchases.filter(row => (!oneOffGear
        || Number(row.selfId) !== Number(first.crystalId)) && row.town).map(row => row.town));
    if (route.exit.town) towns.add(route.exit.town);
    let tripHours = 0, tripFees = 0;
    for (const town of towns) {
        const trip = context.trip?.details?.(town);
        if (!trip?.known || ![trip.hours, trip.fees].every(n => Number.isFinite(n) && n >= 0)) return null;
        tripHours += trip.hours; tripFees += trip.fees;
    }
    const extraHours = (cycles - 1) * tripHours, extraFees = (cycles - 1) * tripFees;
    const hours = route.hours + extraHours;
    const readyHours = hours;
    if (!Number.isFinite(readyHours) || readyHours > HOURS + 1e-9) return null;
    const valueHours = route.valueHours - extraHours - extraFees * price;
    if (!(valueHours > 0)) return null;
    const profit = valueHours / price;
    return { ...route, valueHours, expectedProfit: profit, profit, hours,
        basket: { ...route.basket, actualCashFees: route.basket.actualCashFees + extraFees,
            cost: route.basket.cost + extraFees },
        valuation: { ...route.valuation, valueHours, cashNow: route.valuation.cashNow + extraFees, cycleHours: hours },
        margin: { ...route.margin, profit, hours, cycleHours: hours,
            netCash: route.margin.netCash - extraFees, labour: route.margin.labour + extraHours / price },
        horizon: { hours: HOURS, readyHours: Math.max(0, readyHours), cycles, batches: route.batches,
            units: route.batches * Number(route.recipe.productCount), extraHours, extraFees } };
}

module.exports = { HOURS, projectState, sameSource, sameExit, retainedBatches, value };
