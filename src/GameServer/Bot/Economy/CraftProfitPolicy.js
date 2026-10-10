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
    return { ...context, ...invoke('GameServer/Bot/Population/ColdOccupationSources').craftLabour(state, timestamp) };
}
function tripFor(state, options = {}) { return invoke('GameServer/Bot/Economy/EconomicTrip').reader(state, options); }
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
// Native finite facts of one recipe for `output` units or `batches`, read by
// the wish network and by the producer alike. Gross requirements only: the
// Core quantity reader subtracts stock, incoming and commitments once.
// A cold own craft makes one draw per command of up to 64 batches bounded by
// MP (Database.craftInventoryItems); a hot bot crafts one batch per command
// (HotWealthCraftService); a workshop command is bounded by its capacity
// (Database.craftForCustomer). A failed draw consumes every input of its command.
// A recipe scroll learned for this decision is consumed once, never per batch.
function* prepareCraftFacts(recipe, { output, batches, executor = 'cold', mpCapacity = Infinity, capacityBatches,
    mpPerHour, recipeInput = 0, fee = 0 } = {}) {
    const probability = successProbability(recipe);
    if (!recipe || !Number.isFinite(probability)) return { status: 'unknown', reason: 'recipe' };
    const productCount = Number(recipe.productCount || 1);
    const count = batches ?? batchesFor(recipe, output);
    if (!Number.isSafeInteger(count) || count < 0) return { status: 'unknown', reason: 'quantity' };
    const mpCost = Math.max(0, Number(recipe.mpCost || 0));
    const bound = executor === 'hot' ? 1 : executor === 'workshop' ? Number(capacityBatches)
        : mpCost > 0 ? Math.floor(Number(mpCapacity) / mpCost) : 64;
    const perCommand = Math.min(64, bound);
    if (!(perCommand >= 1)) return { status: 'unknown', reason: executor === 'workshop' ? 'capacity' : 'mp_capacity' };
    const gross = new Map(), once = new Set();
    const entry = Number(recipeInput || 0);
    if (entry > 0) { gross.set(entry, 1); once.add(entry); }
    let rows = 0;
    for (const input of recipe.materials || []) {
        const id = Number(input.selfId), amount = Number(input.amount) * count;
        if (!Number.isSafeInteger(id) || id < 1 || !(Number(input.amount) > 0) || !Number.isSafeInteger(amount))
            return { status: 'unknown', reason: 'recipe' };
        const total = Number(gross.get(id) || 0) + amount;
        if (!Number.isSafeInteger(total)) return { status: 'unknown', reason: 'quantity' };
        gross.set(id, total); rows++;
        yield 'ingredient';
    }
    const mp = mpCost * count;
    // Own MP is labour; a workshop crafter spends his own MP for the fee.
    const labourMp = executor === 'workshop' ? 0 : mp;
    const labourHours = labourMp ? Number(mpPerHour) > 0 ? labourMp / Number(mpPerHour) : NaN : 0;
    const cash = Math.max(0, Number(fee) || 0) * count;
    // Unknown labour keeps the quantities for readers that need no hours.
    return { ...(Number.isFinite(labourHours) ? { status: 'ready' } : { status: 'unknown', reason: 'mp_regen' }), recipeId: Number(recipe.recipeId), productCount, batches: count, output: count * productCount,
        perCommand, draws: Math.ceil(count / perCommand), successProbability: probability, gross, once, mp, labourHours,
        fee: cash, feeOnFailure: cash > 0, rows };
}
function craftFacts(recipe, options) {
    const steps = prepareCraftFacts(recipe, options);
    let step;
    do { step = steps.next(); } while (!step.done);
    return step.value;
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
module.exports = { prepareCraftFacts, craftFacts, requirements, batchesFor, craftableBatches, revenue, margin, craftIncomePerHour, contextFor, tripFor, inputValue, materials, succeeds,
    mpHours, successProbability, craftOutcomes };
