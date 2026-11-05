'use strict';

const WalkBack = require('./WalkBack');
const PkDropPolicy = require('../../PkDropPolicy');

const positive = value => Math.max(0, Number(value) || 0);
const trait = (persona, key) => Math.max(0, Math.min(1, Number(persona?.traits?.[key] ?? 0.5)));

const OUTCOME_LIMIT = 8;
function unknownOpportunity() {
    return { known: false, valueHours: NaN, expectedReceipts: NaN, expectedResidual: NaN,
        cashNow: NaN, cycleHours: NaN };
}
// One scalar physical outcome is one planner unit. No source reads, rolls,
// goods allocation or demand clipping are hidden in this accumulator.
function createOpportunity(context = {}) {
    const moneyPrice = Number(context.moneyPrice);
    const discountRate = Number(context.discountRate ?? context.wait ?? 0);
    const risk = Number(context.riskWeight ?? 1);
    return { known: context.known !== false && Number.isFinite(moneyPrice) && moneyPrice >= 0
        && Number.isFinite(discountRate) && discountRate >= 0 && Number.isFinite(risk) && risk >= 0,
    moneyPrice, discountRate, risk, probability: 0, count: 0, valueHours: 0,
    expectedReceipts: 0, expectedResidual: 0, cashNow: 0, cycleHours: 0 };
}
function addOutcome(acc, outcome = {}) {
    if (!acc?.known) return false;
    const probability = Number(outcome.probability);
    const fields = ['ownBenefitHours', 'receipts', 'monetaryResidual', 'ownInputOpportunityValue',
        'cashNow', 'actualCashFees', 'foregoneBenefitHours', 'riskHours', 'delayHours', 'cycleHours'];
    const values = fields.map(field => Number(outcome[field] ?? 0));
    const rate = Number(outcome.discountRate ?? acc.discountRate);
    if (outcome.known === false || !Number.isFinite(probability) || probability < 0 || probability > 1
        || !Number.isFinite(rate) || rate < 0 || values.some((value, at) => !Number.isFinite(value)
            || value < 0 && at !== 0 && at !== 2)
        || ++acc.count > OUTCOME_LIMIT) { acc.known = false; return false; }
    const [ownBenefit, receipts, residual, inputValue, cash, fees, foregone, risk, delay, cycle] = values;
    const discounted = receipts * Math.exp(-rate * delay);
    // Residual own use belongs in ownBenefitHours, monetary residual in the
    // independent remaining-goods exit. A caller never counts both for one unit.
    const value = ownBenefit + acc.moneyPrice * (discounted + residual - cash - inputValue - fees)
        - foregone - acc.risk * risk;
    acc.probability += probability;
    acc.valueHours += probability * value;
    acc.expectedReceipts += probability * discounted;
    acc.expectedResidual += probability * residual;
    acc.cashNow += probability * (cash + fees);
    acc.cycleHours += probability * cycle;
    if (![acc.valueHours, acc.expectedReceipts, acc.expectedResidual, acc.cashNow, acc.cycleHours]
        .every(Number.isFinite)) acc.known = false;
    return acc.known;
}
function finishOpportunity(acc) {
    if (!acc?.known || !acc.count || Math.abs(acc.probability - 1) > 1e-9) return unknownOpportunity();
    return { known: true, valueHours: acc.valueHours, expectedReceipts: acc.expectedReceipts,
        expectedResidual: acc.expectedResidual, cashNow: acc.cashNow, cycleHours: acc.cycleHours };
}
function opportunity(context, outcomes) {
    const acc = createOpportunity(context);
    for (const outcome of outcomes || []) if (!addOutcome(acc, outcome)) break;
    return finishOpportunity(acc);
}

// Value only the executable quantity. Route time is the additional journey
// over the current activity, supplied by the shared EconomicTrip reader.
function acquisition(context, plan, route) {
    const units = Number(plan?.units), itemId = Number(plan?.selfId);
    const usefulness = Number(context?.itemUsefulness?.(itemId));
    return opportunity({ moneyPrice: context?.moneyPrice, riskWeight: context?.riskWeight,
        known: route?.known === true && Number.isFinite(units) && units > 0
            && Number.isFinite(usefulness) }, [{ probability: 1,
        ownBenefitHours: usefulness * units, cashNow: Number(plan?.cost),
        actualCashFees: Number(route?.fees), foregoneBenefitHours: Number(route?.hours),
        cycleHours: Number(route?.hours) }]);
}

// A required purchase (kit, survival stock: a funded required root's step) is bought
// whatever its value: the money queue funds its price, fees in it, and the solver
// chose its source with the road. Its road needs no value of its own on a full fill.
// A part fill leaves a road to make again for the rest: it carries its road while its
// share of the benefit beats that, share x benefit > (1 - share) x road (valueHours:
// the part's own value, the share of the benefit). No road dearer than the goods it
// brings (fees and hours at the money price over their cost): a far seller of a cheap
// need is no reason to cross the map.
// step: what one seller fills, as a visit's step reads it: unitPrice × amount (else
// price) its goods, amount of wanted (the whole need still to buy) its share,
// valueHours its own value. One reading for the visit, the trip and the network's
// tier (WishNetwork roadless), so their answers cannot drift.
function roadCarried(context, step, route) {
    const amount = positive(step.amount);
    const cost = positive(step.unitPrice) > 0 ? positive(step.unitPrice) * amount : positive(step.price);
    const share = Math.min(1, amount / (positive(step.wanted) || amount || 1));
    const moneyPrice = positive(context.moneyPrice);
    const road = moneyPrice * positive(route.fees) + positive(route.hours);
    if (!(road <= moneyPrice * cost)) return false;
    return share >= 1 || positive(step.valueHours) > (1 - share) * road;
}
// One new-purchase journey question: the quantity pays its trip. The originating
// finite utility is for the requested quantity: a partial feasible fill gets
// only its proportional value, never all of it; no value given: its place in
// the money queue (r), else the reader's own usefulness. required: a required
// purchase (roadCarried), its share of wanted (the root's whole need still to
// buy, as a visit's step reads it; else the requested amount).
function tripPays(context, plan, route, { valueHours, r, required, wanted } = {}) {
    if (!route?.known) return false;
    if (route.hours === 0 && route.fees === 0) return true;
    if (required === true) {
        const units = positive(plan.units);
        if (roadCarried(context, { price: plan.cost, amount: units, wanted: positive(wanted) || positive(plan.amount),
            valueHours: positive(valueHours) * Math.min(1, units / Math.max(1, positive(plan.amount))) }, route)) return true;
    }
    const total = Number(valueHours), rate = Number(r);
    const valuation = valueHours !== undefined && Number.isFinite(total) && total >= 0
        ? { ...context, itemUsefulness: () => total / Math.max(1, Number(plan.amount)) }
        : r !== undefined && Number.isFinite(rate) && rate >= 0
            ? { ...context, itemUsefulness: () => rate * plan.cost / plan.units } : context;
    const result = acquisition(valuation, plan, route);
    return result.known && result.valueHours > 0;
}

// A town visit pays its one trip: the plan's steps there, their value against
// their cost, the road's hours and fees; a required step there carries the road
// (roadCarried), the others ride along. Asked by the build of the step it chooses
// and by the agenda of the step it moves to (Situations, one look a visit).
function visitPays(context, steps, route) {
    if (!route?.known) return false;
    let cost = 0, valueHours = 0, carried = false;
    for (const step of steps) {
        cost += positive(step.unitPrice) > 0 ? positive(step.unitPrice) * positive(step.amount) : positive(step.price);
        valueHours += positive(step.valueHours);
        carried ||= step.required === true && roadCarried(context, step, route);
    }
    return carried || tripPays(context, { selfId: Number(steps[0]?.itemId), units: 1, amount: 1, cost }, route, { valueHours });
}

// MVP-4: hours spent earning a cash shortfall at the net income rate. No
// shortfall waits nothing even without income; a shortfall without income is
// unknown (null), never free time.
function fundingDelay({ requiredCash = 0, spendableCash = 0, incomePerHour = 0 } = {}) {
    const shortfall = positive(requiredCash) - positive(spendableCash);
    if (!(shortfall > 0)) return 0;
    const income = Number(incomePerHour);
    return Number.isFinite(income) && income > 0 && Number.isFinite(shortfall) ? shortfall / income : null;
}
// A benefit earned per hour over the horizon H starts only when the goal is
// ready: the part lost to the delay is benefitPerHour x min(H, delay).
function readyBenefit({ valueHours = 0, benefitPerHour = 0, horizonHours = Infinity, delayHours = 0, notBeforeHours = 0 } = {}) {
    const delay = Number(delayHours);
    if (delayHours === null || !Number.isFinite(delay) || delay < 0) return null;
    const horizon = Number(horizonHours);
    return Math.max(0, positive(valueHours) - positive(benefitPerHour)
        * Math.max(0, Math.min(Number.isFinite(horizon) && horizon >= 0 ? horizon : Infinity, delay)
            - positive(notBeforeHours)));
}

function riskWeight(state, persona) {
    return (1 + trait(persona, 'caution')) / (0.5 + trait(persona, 'resilience'))
        * (1 + positive(state.stats?.frustration));
}
// What an hour of a bot's progress is worth to it, in hours (the level wish's
// value, its spot value's side against money).
function powerWeight(persona) {
    return (persona?.primaryDrive === 'progression' ? 1 : 0.5) + trait(persona, 'caution');
}
function stageHours(state, expPerHour, persona) {
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    const Data = invoke('GameServer/DataCache');
    const Cap = invoke('GameServer/Progression/ProgressionCap');
    const level = positive(state.level) || 1;
    const stage = Learning.stages().find(row => row.grade === Learning.gradeOfLevel(level));
    const cap = Cap.effectiveLevelCap();
    if (level >= cap) return 1 + 24 * trait(persona, 'commitment');
    const end = Math.min(cap, stage.maxLevel + 1);
    const remaining = Math.max(0, Number(Data.experience[end - 1]) - positive(state.stats?.exp ?? state.exp));
    return expPerHour > 0 ? remaining / expPerHour : 0;
}
function decisionHorizon(state, context) {
    return Number.isFinite(context.horizonHours) ? context.horizonHours
        : stageHours(state, context.hunt.expPerHour, context.persona);
}
// The respawn wait of a death (BackgroundResolver.resolveDeathRecovery: 90 s).
const RESPAWN_HOURS = 90 / 3600;
// A death's price in hours: the exp it loses, the walk back, the gear it may
// drop. A table row's deaths (spot and hunt tables, read by SpotEconomics and
// EconomyContext) already cost their kills the respawn wait (the generator
// runs the real respawn, T126); a live death adds it (liveDeathHours).
function deathHours(state, { expPerHour = 0, walkBackHours, returnHours, lostGearHours = 0, spotId } = {}) {
    const Death = invoke('GameServer/Progression/DeathExperience');
    const loss = Death.calculateLoss({ ...state, exp: state.stats?.exp ?? state.exp ?? 0 });
    const downtime = walkBackHours ?? returnHours ?? WalkBack.hours(spotId || state.spotId, state);
    return (expPerHour > 0 ? loss.expLost / expPerHour : 0) + positive(downtime) + positive(lostGearHours);
}
// The price of one live death (a kill, a death in a fight, a PvP risk) from a
// table row's (deathHours, EconomyContext.basics' deathHours): it also waits
// for its respawn.
function liveDeathHours(tableDeathHours) {
    return positive(tableDeathHours) + RESPAWN_HOURS;
}
function karmaHours(state, { expPerHour = 0, lostGearHours = 0, exposureHours = 0, deathsPerHour = 0 } = {}) {
    const karma = positive(state.stats?.karma);
    if (!karma) return 0;
    const wash = expPerHour > 0 ? karma * invoke('GameServer/Karma').XP_DIVIDER / expPerHour : Infinity;
    return wash + positive(lostGearHours) * positive(deathsPerHour) * Math.max(wash, positive(exposureHours));
}
function pkDropValue(state, priceOf) {
    return PkDropPolicy.expectedValue(state.physicalInventory
        ? { ...state, inventory: state.physicalInventory } : state, priceOf);
}
function resale(price, { trend = 0, hours = 0, understanding = 0.3, assertiveness = 0.5,
    caution = 0.5, nextBuyerUse = price, npcFloor = 0 } = {}) {
    const forecast = positive(price) * Math.exp(Math.max(-20, Math.min(20,
        Number(trend || 0) * positive(hours) * positive(understanding) * (1 + assertiveness - caution))));
    return Math.max(positive(npcFloor), Math.min(forecast, positive(nextBuyerUse)));
}
function progressStats(state, { timestamp = Date.now(), startedAt = 0, kills = 0, losses = 0,
    lossHours = 0, risky = false, persona = {}, knowledgeEnabled = true } = {}) {
    const stats = state.stats || {};
    const at = Number(stats.economyClock || state.timing?.lastResolvedAt || 0);
    const elapsed = at >= startedAt && timestamp > at ? (timestamp - at) / 3600000 : 0;
    const frustration = positive(stats.frustration) * Math.exp(-elapsed)
        + positive(losses) * positive(lossHours) * (1 - trait(persona, 'resilience')) * (risky ? 0.5 : 1);
    return { playedHours: positive(stats.playedHours) + elapsed, economyClock: timestamp,
        frustration: Math.max(0, frustration - positive(kills) / Math.max(1, positive(stats.lifelongKills) + positive(kills))),
        lifelongKills: positive(stats.lifelongKills) + (knowledgeEnabled ? positive(kills) : 0) };
}
module.exports = { riskWeight, powerWeight, stageHours, decisionHorizon, deathHours, liveDeathHours, karmaHours, pkDropValue, resale, progressStats, trait,
    opportunity, acquisition, tripPays, visitPays, roadCarried, createOpportunity, addOutcome, finishOpportunity, OUTCOME_LIMIT, fundingDelay, readyBenefit };
