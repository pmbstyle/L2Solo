'use strict';
const Profit = require('./CraftProfitPolicy');
const Valuation = require('./EconomicValuation');
const Price = require('./PriceDecision');
const MAX_BATCHES = 64;
const count = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : NaN;

// Canonical requirements prevent two ingredient rows allocating the same stock.
function requirements(recipe, batches = 1) {
    if (!Number.isSafeInteger(batches) || batches < 0 || batches > MAX_BATCHES) return null;
    const result = new Map();
    for (const row of recipe?.materials || []) {
        const id = Number(row.selfId), amount = Number(row.amount);
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(amount) || amount <= 0) return null;
        const total = (result.get(id) || 0) + amount * batches;
        if (!Number.isSafeInteger(total)) return null;
        result.set(id, total);
    }
    return result;
}
function* prepareBasket(recipe, planFor, ownedFor = () => null, batches = 1, context = {}) {
    const required = new Map();
    // Learning consumes one scroll for this whole decision, never one per
    // manufactured batch. Its purchase joins the same town/fee allocation.
    const entry = Number(context.recipeInput || 0);
    if (entry > 0) required.set(entry, 1);
    for (const row of recipe?.materials || []) {
        const id = Number(row.selfId), amount = Number(row.amount);
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(amount) || amount <= 0
            || !Number.isSafeInteger(amount * batches + (required.get(id) || 0))) return null;
        required.set(id, amount * batches + (required.get(id) || 0));
        yield 'ingredient';
    }
    const purchases = [], owned = [], trips = new Map(), allocated = new Map();
    let cashCost = 0, ownedValue = 0, actualCashFees = 0, travelHours = 0, processingHours = 0,
        extraMp = 0, residualValue = 0, unknownTrip = false, repeatableInputs = true;
    for (const [selfId, needed] of required) {
        let missing = needed;
        const stock = (selfId === entry ? context.recipeStock : ownedFor(selfId)) || {};
        const available = count(Math.max(0, Number(stock.count ?? 0) - Number(allocated.get(selfId) || 0)));
        if (!Number.isFinite(available)) return null;
        const ownCount = Math.min(missing, available);
        if (ownCount) {
            const unitValue = Number(stock.unitValue);
            if (!Number.isFinite(unitValue) || unitValue < 0) return null;
            owned.push({ selfId, count: ownCount, unitValue });
            allocated.set(selfId, Number(allocated.get(selfId) || 0) + ownCount);
            ownedValue += ownCount * unitValue;
            missing -= ownCount;
            if (stock.repeatableReplacement !== true) repeatableInputs = false;
        }
        yield 'owned';
        if (!missing) continue;
        const plan = context.preparePurchase ? yield* context.preparePurchase(selfId, missing, { allocated })
            : planFor(selfId, missing);
        if (!context.preparePurchase) yield 'quote';
        if (!plan?.whole || Number(plan.units ?? missing) < missing || !Number.isFinite(Number(plan.cost))
            || Number(plan.cost) < 0 || !Number.isFinite(Number(plan.landed))) return null;
        for (const input of plan.ownedInputs || []) {
            const inputId = Number(input.selfId), used = Number(input.count), stock = ownedFor(inputId);
            const total = Number(allocated.get(inputId) || 0) + used;
            if (!Number.isSafeInteger(used) || used <= 0 || total > Number(stock?.count || 0)) return null;
            allocated.set(inputId, total); owned.push({ selfId: inputId, count: used, unitValue: Number(input.unitValue) });
            yield 'owned';
        }
        purchases.push({ selfId, count: missing, town: plan.town, cost: Number(plan.cost),
            landed: Number(plan.landed), lines: plan.lines, npc: plan.npc, npcPrice: plan.npcPrice, source: plan.gear });
        cashCost += Number(plan.cost);
        ownedValue += Number(plan.ownedValue || 0);
        processingHours += Number(plan.processingHours || 0);
        extraMp += Number(plan.extraMp || 0);
        residualValue += Number(plan.residualValue || 0);
        if (plan.repeatable !== true && Number(plan.npc || 0) < missing) repeatableInputs = false;
        const details = plan.tripDetails || context.trip?.details?.(plan.town);
        const key = plan.routeKey ?? plan.town ?? `input:${selfId}`;
        const trip = Math.max(0, Number(plan.landed) - Number(plan.cost));
        if (!trips.has(key)) trips.set(key, { trip, details });
        else if (trip > trips.get(key).trip) trips.set(key, { trip, details });
        if (trips.size > 8) return null;
    }
    let tripEquivalent = 0;
    for (const { trip, details } of trips.values()) {
        if (details && Number.isFinite(details.hours) && Number.isFinite(details.fees)) {
            actualCashFees += Math.max(0, details.fees); travelHours += Math.max(0, details.hours);
            tripEquivalent += Math.max(0, details.fees) + Math.max(0, details.hours) * Number(context.hourAdena || 0);
        } else if (!trip) { /* same town */ }
        else if (Number(context.hourAdena) > 0) {
            travelHours += trip / Number(context.hourAdena); tripEquivalent += trip; unknownTrip = true;
        } else return null;
        yield 'trip';
    }
    if (entry) processingHours += Number(context.learningHours || 0);
    const cost = cashCost + ownedValue + tripEquivalent;
    return Number.isFinite(cost) ? { purchases, owned, cashCost, ownedValue, actualCashFees, travelHours,
        processingHours, extraMp, residualValue, tripTowns: trips, unknownTrip, repeatableInputs, cost: Math.ceil(cost), batches } : null;
}
function drain(iterator) { let step; do { step = iterator.next(); } while (!step.done); return step.value; }
function basketFor(recipe, planFor, ownedFor = () => null, batches = 1, context = {}) {
    if (!Number.isSafeInteger(batches) || batches < 0 || batches > MAX_BATCHES) return null;
    return drain(prepareBasket(recipe, planFor, ownedFor, batches, context));
}
function craftMargin(recipe, productPrice, basketCost) { return Profit.revenue(recipe, productPrice) - Number(basketCost); }
function saleInput(exit, units, context) {
    const conditional = exit.conditional || exit.offer?.conditional;
    const snapshot = exit.prospective, authority = snapshot?.authority, offer = exit.offer;
    const prospective = conditional && exit.trial === true && exit.repeatable !== true
        && snapshot?.known === true && snapshot.origin === 'public_bid'
        && authority?.recordId === Number(offer?.recordId) && authority?.lineId === Number(offer?.lineId)
        && authority?.revision === (offer?.revision ?? offer?.expectedRevision)
        && snapshot.applicableUnits === Number(exit.count) && Number(offer?.count) === Number(exit.count)
        && Number(offer?.price) === Number(exit.price)
        && Number.isFinite(snapshot.willingUnits) && snapshot.willingUnits >= 0
        && snapshot.willingUnits <= snapshot.applicableUnits;
    return { units, applicableUnits: conditional ? prospective ? Number(exit.applicableUnits ?? snapshot.applicableUnits) : 0
        : Number(exit.applicableUnits ?? exit.count),
        willingUnits: prospective ? snapshot.willingUnits : Number(exit.willingUnits ?? exit.count), cheaperUnits: Number(exit.cheaperUnits || 0),
        price: Number(exit.price), residualUnitValue: Number(exit.residualUnitValue ?? context.residualUnitValue ?? 0) };
}
function* evaluatePrepared({ state, recipe, batches = 1, basket, exit, ownedFor = () => null, context = {} }) {
    const successRate = Number(recipe?.successRate) / 100;
    const productCount = Number(recipe?.productCount) * batches;
    const mp = Number(recipe?.mpCost || 0) * batches;
    if (!recipe || exit.unknownJoint || !Number.isSafeInteger(batches) || batches < 1 || batches > MAX_BATCHES
        || exit.trial === true && batches !== 1
        || !Number.isSafeInteger(productCount) || productCount <= 0 || !(successRate > 0 && successRate <= 1)
        || !Number.isFinite(mp) || mp < 0 || !basket || mp + Number(basket.extraMp || 0) > Number(state?.vitals?.mp || 0)
        || basket.cashCost + basket.actualCashFees > Number(state?.adena || 0)
        || productCount > Number(context.destinationCapacity ?? Infinity)
        || productCount > Number(context.assignedCapacity ?? Infinity)) return null;
    const hourAdena = Number(context.hourAdena ?? context.hunt?.perHour);
    const moneyPrice = Number(context.moneyPrice ?? (hourAdena > 0 ? 1 / hourAdena : NaN));
    if (!Number.isFinite(moneyPrice) || moneyPrice <= 0) return null;
    const mpHours = mp ? mp / Number(context.mpPerHour) : 0;
    if (!Number.isFinite(mpHours) || mpHours < 0) return null;
    const activeHours = Number(context.activeCraftHours || 0) * batches + Number(basket.processingHours || 0);
    const shopHours = Number(exit.shopHours || 0), exitDetails = exit.tripDetails || context.trip?.details?.(exit.town);
    const exitTrip = Number(exit.trip || 0);
    const sameVisit = !!exit.town && basket.tripTowns?.has(exit.town);
    const exitHours = sameVisit ? 0 : exitDetails ? Number(exitDetails.hours) : exitTrip ? exitTrip / hourAdena : 0;
    const exitFees = sameVisit ? 0 : exitDetails ? Number(exitDetails.fees) : 0;
    const cycleHours = mpHours + activeHours + basket.travelHours + exitHours + shopHours;
    if (!Number.isFinite(cycleHours) || cycleHours < 0 || !Number.isFinite(exitFees) || exitFees < 0) return null;
    const oldCount = count(context.existingOutput ?? ownedFor(Number(recipe.productId))?.count ?? 0);
    if (!Number.isFinite(oldCount) || !Number.isSafeInteger(oldCount + productCount)) return null;
    const without = Price.saleOutcome(saleInput(exit, oldCount, context));
    yield 'without';
    if (!without.known) return null;
    const full = Price.saleOutcome(saleInput(exit, oldCount + productCount, context));
    yield 'success';
    if (!full.known) return null;
    if (exit.trial === true && !(full.sold > without.sold)) return null;
    // One native command draws once, including a multi-batch command. Cap each
    // physical outcome before mixing, so 100 output at 60% against 10 sells 6.
    const receipts = full.receipts - without.receipts;
    const residual = full.residualValue - without.residualValue;
    const ownUse = Math.min(Math.max(0, full.residual - without.residual), Math.max(0, Number(exit.ownUseUnits || 0)));
    const ownBenefit = ownUse * Number(exit.ownUseUnitHours || 0);
    const base = { cashNow: basket.cashCost, ownInputOpportunityValue: basket.ownedValue,
        actualCashFees: basket.actualCashFees + exitFees,
        foregoneBenefitHours: mpHours + activeHours + basket.travelHours + exitHours
            + (exit.concurrentAlternative === true ? 0 : shopHours),
        riskHours: Number(context.riskHours || 0), delayHours: Number(exit.delayHours || 0), cycleHours };
    const monetaryResidual = residual - ownUse * Number(exit.residualUnitValue ?? context.residualUnitValue ?? 0)
        + Number(basket.residualValue || 0);
    const outcomes = [{ ...base, probability: successRate, receipts, monetaryResidual,
        ownBenefitHours: ownBenefit }];
    if (successRate < 1) outcomes.push({ ...base, probability: 1 - successRate, receipts: 0,
        monetaryResidual: Number(basket.residualValue || 0), ownBenefitHours: 0 });
    const accumulator = Valuation.createOpportunity({ ...context, moneyPrice });
    for (const outcome of outcomes) {
        Valuation.addOutcome(accumulator, outcome);
        yield 'utility';
    }
    const value = Valuation.finishOpportunity(accumulator);
    if (!value.known) return null;
    const rawProfit = value.valueHours / moneyPrice;
    const expectedProfit = Math.abs(rawProfit - Math.round(rawProfit)) < 1e-7 ? Math.round(rawProfit) : rawProfit;
    const expectedRevenue = successRate * receipts;
    const labour = (mpHours + activeHours + basket.travelHours + exitHours + shopHours) / moneyPrice;
    const netCash = expectedRevenue + successRate * (monetaryResidual - Number(basket.residualValue || 0))
        + Number(basket.residualValue || 0)
        - basket.cashCost - basket.ownedValue - basket.actualCashFees - exitFees;
    return { recipe, basket, exit, batches, revenue: Number(exit.price) * productCount,
        expectedProfit, successRate, hours: cycleHours, valueHours: value.valueHours, valuation: value,
        expectedSold: successRate * (full.sold - without.sold),
        margin: { expectedRevenue, inputs: basket.cost, labour, hours: cycleHours, profit: expectedProfit,
            netCash, cycleHours, repeatable: exit.repeatable === true && basket.repeatableInputs && !basket.unknownTrip },
        repeatable: exit.repeatable === true && basket.repeatableInputs && !basket.unknownTrip,
        incomePerHour: exit.repeatable === true && basket.repeatableInputs && !basket.unknownTrip && cycleHours > 0 ? netCash / cycleHours : NaN };
}
function evaluateBasket(args, recipe, planFor, exit, ownedFor, context, batches = 1) {
    const input = arguments.length === 1 ? args : { state: args, recipe, planFor, exit, ownedFor, context, batches };
    const basket = input.basket || basketFor(input.recipe, input.planFor, input.ownedFor, input.batches ?? 1, input.context);
    return drain(evaluatePrepared({ ...input, basket }));
}
function* searchQuantity({ state, recipe, planFor, exits = [], ownedFor = () => null, context = {}, mode = 'action' }) {
    let best = null;
    // Complete bounded search also handles discontinuous quote/fee breakpoints.
    // Zero is the without-case; never force production when every value is <=0.
    const mp = Number(recipe?.mpCost || 0);
    const limit = Math.min(MAX_BATCHES, mp > 0 ? Math.floor(Number(state?.vitals?.mp || 0) / mp) : MAX_BATCHES,
        Math.max(0, Math.floor(Number(context.maxBatches ?? MAX_BATCHES))));
    const first = context.fixedBatches === undefined ? 1 : Number(context.fixedBatches);
    const end = context.fixedBatches === undefined ? limit : Math.min(limit, first);
    if (!Number.isSafeInteger(first) || first < 1 || first > MAX_BATCHES) return null;
    for (let batches = first; batches <= end; batches++) {
        // A repeated occupation needs a supported replenishment route. The
        // finite owned bag may fund today's action, but cannot make its future
        // input supply infinite. Price the actual replenished cycle separately.
        const inputsFor = mode === 'occupation' ? () => null : ownedFor;
        const basket = yield* prepareBasket(recipe, planFor, inputsFor, batches, context);
        if (!basket) continue;
        for (const exit of exits) {
            yield 'exit';
            if (mode === 'occupation' && exit.repeatable !== true) continue;
            // Unsupported external demand permits only an explicitly valued
            // minimum trial, never a speculative larger production command.
            if (exit.trial === true && batches > 1) continue;
            const candidate = yield* evaluatePrepared({ state, recipe, batches, basket, exit, ownedFor, context });
            const score = mode === 'occupation' ? candidate?.incomePerHour : candidate?.valueHours;
            if (candidate && score > 0 && (!best || score > (mode === 'occupation' ? best.incomePerHour : best.valueHours))) best = candidate;
        }
        yield 'candidate';
    }
    return best;
}
function chooseQuantity(input) { return drain(searchQuantity(input)); }
function opportunityFor(state, recipe, planFor, exits = [], ownedFor = () => null, context = {}) {
    if (recipe?.type !== 'dwarven') return null;
    return chooseQuantity({ state, recipe, planFor, exits, ownedFor, context });
}
module.exports = { MAX_BATCHES, requirements, basketFor, craftMargin, evaluateBasket, chooseQuantity,
    opportunityFor, prepareBasket, evaluatePrepared, searchQuantity, drain };
