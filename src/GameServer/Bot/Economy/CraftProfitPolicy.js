'use strict';
const Valuation = require('./EconomicValuation');

function successProbability(recipe) {
    const rate = Number(recipe?.successRate);
    return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate / 100 : NaN;
}
function craftOutcomes(recipe, { success = {}, failure = {}, batches = 1 } = {}) {
    const probability = successProbability(recipe);
    if (!Number.isFinite(probability) || !Number.isSafeInteger(batches) || batches < 0 || batches > 64) return [];
    // craftSelf/craftInventoryItems make one draw for the whole native batch.
    // Clip the successful physical output first; never clip its expectation.
    return [{ ...success, probability }, { ...failure, probability: 1 - probability }];
}
function mpHours(recipe, batches = 1, { mpPerHour } = {}) {
    const mp = Number(recipe?.mpCost ?? 0);
    if (!Number.isFinite(mp) || mp < 0 || !Number.isSafeInteger(batches) || batches < 0 || batches > 64) return null;
    if (!mp || !batches) return 0;
    return Number.isFinite(mpPerHour) && mpPerHour > 0 ? mp * batches / mpPerHour : null;
}

function revenue(recipe, price) {
    return Number(price) * Number(recipe?.productCount || 0)
        * successProbability(recipe);
}
// Materials retain their market opportunity value even when already owned.
// A missing monetary hour or MP production rate is unknown labour, never free labour.
function margin(recipe, price, inputs, { hourAdena, hunt, mpPerHour, tripCost = 0 } = {}) {
    hourAdena = hunt?.perHour ?? hourAdena;
    const mp = Math.max(0, Number(recipe?.mpCost || 0));
    if (mp && (!(hourAdena >= 0) || !Number.isFinite(hourAdena) || !(mpPerHour > 0))) return null;
    const hours = mpHours(recipe, 1, { mpPerHour });
    if (hours === null) return null;
    const labour = hours * Number(hourAdena || 0);
    const moneyPrice = hourAdena > 0 ? 1 / hourAdena : 1;
    const common = { ownInputOpportunityValue: Number(inputs), actualCashFees: Math.max(0, Number(tripCost || 0)),
        foregoneBenefitHours: hourAdena > 0 ? hours : 0, cycleHours: hours };
    const value = Valuation.opportunity({ moneyPrice }, craftOutcomes(recipe, {
        success: { ...common, receipts: Number(price) * Number(recipe?.productCount || 0) }, failure: common }));
    if (!value.known) return null;
    const expectedRevenue = value.expectedReceipts;
    const profit = value.valueHours / moneyPrice;
    return Number.isFinite(profit) ? { expectedRevenue, inputs: Number(inputs), labour, hours, profit,
        perHour: hours > 0 ? profit / hours : profit } : null;
}
// Revenue less materials and trip, in adena per craft hour; zero-MP is no repeatable clock.
function craftIncomePerHour(margin) {
    return margin?.hours > 0 ? (margin.profit + margin.labour) / margin.hours : null;
}
function contextFor(state, timestamp = Date.now()) {
    const context = require('../Population/ColdEconomyDecision').economyFor(state, { timestamp });
    const regen = invoke('GameServer/Bot/Population/BackgroundResolver').coldRestRegenPerTick(state);
    return { ...context, mpPerHour: Number(regen.mp) * 1200 };
}
function tripFor(state, options = {}) { return require('./EconomicTrip').reader(state, options); }
function inputValue(id, state, context = {}) {
    const worth = context.worth?.(Number(id));
    if (Number.isFinite(worth) && worth > 0) return worth;
    const offer = invoke('GameServer/AfkTrade/AfkTradeService').offers(id, 1, { characterId: state.characterId })[0];
    const npc = invoke('GameServer/Bot/Economy/BotMarketPricing').npcPrice({ selfId: Number(id) });
    const price = Math.min(Number(offer?.price || Infinity), Number(npc));
    return Number.isFinite(price) && price > 0 ? price
        : invoke('GameServer/Bot/Economy/MarketCounters').firstPrice(id);
}
function requirements(recipe, batches = 1) {
    if (!Number.isSafeInteger(batches) || batches < 1 || batches > 64) return null;
    const required = new Map();
    for (const input of recipe?.materials || []) {
        const id = Number(input.selfId), amount = Number(input.amount) * batches;
        if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(amount) || amount < 1) return null;
        const total = Number(required.get(id) || 0) + amount;
        if (!Number.isSafeInteger(total)) return null;
        required.set(id, total);
    }
    return required;
}
function batchesFor(recipe, output) {
    const count = Number(recipe?.productCount || 1);
    if (!Number.isSafeInteger(output) || output < 0 || !Number.isSafeInteger(count) || count <= 0) return null;
    const batches = Math.ceil(output / count);
    return Number.isSafeInteger(batches) ? batches : null;
}
function craftableBatches(items, recipe, requested = 1) {
    const required = requirements(recipe), amounts = new Map(), seen = new Set();
    if (!required || !Number.isSafeInteger(requested) || requested < 1) return 0;
    for (const item of items || []) {
        const identity = Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0 ? Number(item.id) : item;
        if (item.equipped || item.protected || !required.has(Number(item.selfId)) || seen.has(identity)) continue;
        seen.add(identity);
        amounts.set(Number(item.selfId), (amounts.get(Number(item.selfId)) || 0) + Number(item.amount || 0));
    }
    let count = requested;
    for (const [id, amount] of required) count = Math.min(count, Math.floor((amounts.get(id) || 0) / amount));
    return count;
}
function materials(items, recipe, batches = 1) {
    const required = requirements(recipe, batches);
    if (!required) return null;
    const byItem = new Map(), physical = new Set();
    for (const item of items || []) {
        const id = Number(item.id), selfId = Number(item.selfId), amount = Number(item.amount);
        if (item.equipped || item.protected || !required.has(selfId)) continue;
        if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(amount) || amount < 0) return null;
        if (physical.has(id)) continue;
        physical.add(id);
        if (!byItem.has(selfId)) byItem.set(selfId, []);
        byItem.get(selfId).push(item);
    }
    const result = [];
    for (const [selfId, amount] of required) {
        let missing = amount;
        for (const item of byItem.get(selfId) || []) {
            if (missing <= 0) break;
            const taken = Math.min(missing, Number(item.amount || 0));
            if (taken > 0) result.push({ id: Number(item.id), selfId, amount: taken });
            missing -= taken;
        }
        if (missing > 0) return null;
    }
    return result;
}

function succeeds(recipe, random = Math.random) {
    return Number(recipe.successRate) >= 100 || Number(random()) * 100 < Number(recipe.successRate);
}
module.exports = { requirements, batchesFor, craftableBatches, revenue, margin, craftIncomePerHour, contextFor, tripFor, inputValue, materials, succeeds,
    mpHours, successProbability, craftOutcomes };
