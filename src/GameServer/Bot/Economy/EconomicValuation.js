'use strict';

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
function readyBenefit({ valueHours = 0, benefitPerHour = 0, horizonHours = Infinity, delayHours = 0 } = {}) {
    const delay = Number(delayHours);
    if (delayHours === null || !Number.isFinite(delay) || delay < 0) return null;
    const horizon = Number(horizonHours);
    return Math.max(0, positive(valueHours) - positive(benefitPerHour)
        * Math.min(Number.isFinite(horizon) && horizon >= 0 ? horizon : Infinity, delay));
}

function riskWeight(state, persona) {
    return (1 + trait(persona, 'caution')) / (0.5 + trait(persona, 'resilience'))
        * (1 + positive(state.stats?.frustration));
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
function deathHours(state, { expPerHour = 0, walkBackHours, returnHours, lostGearHours = 0, spotId } = {}) {
    const Death = invoke('GameServer/Progression/DeathExperience');
    const loss = Death.calculateLoss({ ...state, exp: state.stats?.exp ?? state.exp ?? 0 });
    const downtime = walkBackHours ?? returnHours ?? require('./WalkBack').hours(spotId || state.spotId, state);
    return (expPerHour > 0 ? loss.expLost / expPerHour : 0) + 90 / 3600 + positive(downtime) + positive(lostGearHours);
}
function karmaHours(state, { expPerHour = 0, lostGearHours = 0, exposureHours = 0, deathsPerHour = 0 } = {}) {
    const karma = positive(state.stats?.karma);
    if (!karma) return 0;
    const wash = expPerHour > 0 ? karma * invoke('GameServer/Karma').XP_DIVIDER / expPerHour : Infinity;
    return wash + positive(lostGearHours) * positive(deathsPerHour) * Math.max(wash, positive(exposureHours));
}
function pkDropValue(state, priceOf) {
    return require('../../PkDropPolicy').expectedValue(state.physicalInventory
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
module.exports = { riskWeight, stageHours, deathHours, karmaHours, pkDropValue, resale, progressStats, trait,
    opportunity, acquisition, createOpportunity, addOutcome, finishOpportunity, OUTCOME_LIMIT, fundingDelay, readyBenefit };
