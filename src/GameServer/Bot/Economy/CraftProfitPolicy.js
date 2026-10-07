'use strict';

function revenue(recipe, price) {
    return Number(price) * Number(recipe?.productCount || 0)
        * Math.max(0, Math.min(100, Number(recipe?.successRate || 0))) / 100;
}
// Materials retain their market opportunity value even when already owned.
// A missing monetary hour or MP production rate is unknown labour, never free labour.
function margin(recipe, price, inputs, { hourAdena, hunt, mpPerHour, tripCost = 0 } = {}) {
    hourAdena = hunt?.perHour ?? hourAdena;
    const mp = Math.max(0, Number(recipe?.mpCost || 0));
    if (mp && (!(hourAdena >= 0) || !Number.isFinite(hourAdena) || !(mpPerHour > 0))) return null;
    const hours = mp ? mp / mpPerHour : 0;
    const labour = hours * Number(hourAdena || 0);
    const expectedRevenue = revenue(recipe, price);
    const profit = expectedRevenue - Number(inputs) - labour - Math.max(0, Number(tripCost || 0));
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
function tripFor(state, { hourAdena } = {}) {
    const Trip = require('../Population/ColdTrip');
    const towns = require('../../World/TownRespawn').towns;
    const byName = new Map(Object.values(towns).map(town => [town.name, town]));
    const from = state.stats?.marketReturn?.loc || state.loc;
    const traveller = from === state.loc ? state : { ...state, loc: from };
    const costs = new Map();
    return town => {
        if (!town || state.activity === 'shopping' && town === state.currentRegion) return 0;
        if (!costs.has(town)) {
            const destination = byName.get(town);
            const plan = destination && Trip.townPlan(traveller, destination);
            const back = plan ? Trip.spotTripMs({ ...traveller, loc: Trip.point(destination) }, from) : 0;
            costs.set(town, plan && Number.isFinite(hourAdena) ? Math.round((plan.durationMs + back) / 3600000 * hourAdena)
                + Number(plan.route.fee || 0) : Infinity);
        }
        return costs.get(town);
    };
}
function inputValue(id, state, context = {}) {
    const worth = context.worth?.(Number(id));
    if (Number.isFinite(worth) && worth > 0) return worth;
    const offer = invoke('GameServer/AfkTrade/AfkTradeService').offers(id, 1, { characterId: state.characterId })[0];
    const npc = invoke('GameServer/Bot/Economy/BotMarketPricing').npcPrice({ selfId: Number(id) });
    const price = Math.min(Number(offer?.price || Infinity), Number(npc));
    return Number.isFinite(price) && price > 0 ? price
        : invoke('GameServer/Bot/Economy/MarketCounters').firstPrice(id);
}
function materials(items, recipe, batches = 1) {
    const required = new Map();
    for (const input of recipe.materials || []) {
        const id = Number(input.selfId);
        required.set(id, Number(required.get(id) || 0) + Number(input.amount) * batches);
    }
    const result = [];
    for (const [selfId, amount] of required) {
        let missing = amount;
        for (const item of items || []) {
            if (missing <= 0) break;
            if (Number(item.selfId) !== selfId || item.equipped) continue;
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
module.exports = { revenue, margin, craftIncomePerHour, contextFor, tripFor, inputValue, materials, succeeds };
