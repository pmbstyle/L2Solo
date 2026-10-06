const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

const WANTED_TTL_MS = 30 * 60 * 1000;

function timestampForWanted(wanted = {}) {
    const value = wanted || {};
    return Math.max(Number(value.lastMissingAt || 0), Number(value.lastTradeAdAt || 0));
}

function demandSignal(state, selfId, timestamp) {
    if (!state || Number(state.characterId || 0) <= 0) return null;
    const wanted = state.stats?.marketWanted;
    const shotWanted = state.stats?.shotDemand;
    const recipeWanted = state.stats?.shotRecipeDemand;
    const plan = state.stats?.equipmentPlan;
    const wantedAt = timestampForWanted(wanted);
    const recentWanted = Number(wanted?.itemId || 0) === Number(selfId)
        && wantedAt > 0
        && wantedAt + WANTED_TTL_MS > timestamp;
    const recentShot = Number(shotWanted?.itemId || 0) === Number(selfId)
        && Number(shotWanted?.at || 0) + WANTED_TTL_MS > timestamp;
    const recentRecipe = Number(recipeWanted?.itemId || 0) === Number(selfId)
        && Number(recipeWanted?.at || 0) + WANTED_TTL_MS > timestamp;
    const activeTarget = plan?.status === 'active'
        && Number(plan.target?.selfId || 0) === Number(selfId);
    const material = ['active', 'component_ready', 'ready_to_craft'].includes(plan?.status)
        ? (plan.materials || []).find((item) => Number(item.selfId) === Number(selfId) && Number(item.missing || 0) > 0)
        : null;

    if (!recentWanted && !recentShot && !recentRecipe && !activeTarget && !material) return null;
    const ready = recentWanted || recentShot || recentRecipe
        || (activeTarget && plan.strategy === 'market') || Boolean(material?.marketFallback);
    const economicWanted = recentShot ? shotWanted : recentRecipe ? recipeWanted : null;
    return {
        characterId: Number(state.characterId),
        name: state.name || null,
        town: state.currentRegion || null,
        amount: Math.max(1, Number(economicWanted?.amount || (recentWanted ? wanted?.amount : material?.missing) || 1)),
        budget: Math.max(0, Math.min(Number(state.adena || 0), economicWanted?.maxSpend === undefined
            ? Infinity : Number(economicWanted.maxSpend))),
        ready,
        source: recentShot ? 'shots' : recentRecipe ? 'shot_recipe' : recentWanted ? 'wanted'
            : material ? 'craft' : plan.strategy === 'market' ? 'market_plan' : 'progression_plan'
    };
}

function states(options = {}) {
    return options.states || LifeState.allStates(5000);
}

// Every seller's listing review indexes the signals of every state, while
// most states are unchanged between two reviews. States are replaced, never
// edited in place, so a state's signals are kept with the object that
// produced them until it is replaced or one of its timed wants expires.
const stateSignals = new WeakMap();

function signalsOfState(state, timestamp) {
    const cached = stateSignals.get(state);
    if (cached && timestamp >= cached.at && timestamp < cached.validUntil) return cached.entries;
    const plan = state?.stats?.equipmentPlan;
    const ids = new Set([
        Number(state?.stats?.marketWanted?.itemId || 0),
        Number(state?.stats?.shotDemand?.itemId || 0),
        Number(state?.stats?.shotRecipeDemand?.itemId || 0),
        Number(plan?.target?.selfId || 0),
        ...(plan?.materials || []).map((material) => Number(material?.selfId || 0))
    ]);
    const entries = [];
    ids.forEach((selfId) => {
        if (selfId <= 0) return;
        const signal = demandSignal(state, selfId, timestamp);
        if (signal) entries.push([selfId, signal]);
    });
    const expiries = [timestampForWanted(state?.stats?.marketWanted), Number(state?.stats?.shotDemand?.at || 0),
        Number(state?.stats?.shotRecipeDemand?.at || 0)]
        .map((at) => at + WANTED_TTL_MS).filter((until) => until > timestamp);
    if (state && typeof state === 'object') {
        stateSignals.set(state, { entries, at: timestamp, validUntil: expiries.length ? Math.min(...expiries) : Infinity });
    }
    return entries;
}

function indexSignals(allStates, timestamp = Date.now()) {
    const byItem = new Map();
    for (const state of allStates || []) {
        for (const [selfId, signal] of signalsOfState(state, timestamp)) {
            if (!byItem.has(selfId)) byItem.set(selfId, []);
            byItem.get(selfId).push(signal);
        }
    }
    return byItem;
}

function demandFor(selfId, options = {}) {
    const timestamp = Number(options.now) || Date.now();
    const unitPrice = Math.max(0, Number(options.unitPrice || 0));
    const excludedCharacterId = Number(options.excludeCharacterId || 0);
    const afkOrders = invoke('GameServer/AfkTrade/AfkTradeService').offers(selfId, 3, {
        characterId: excludedCharacterId
    }).filter((offer) => Number(offer.count) > 0 && Number(offer.price) > 0);
    const afkOwners = new Set(afkOrders.map((offer) => Number(offer.sourceId)));
    const signals = options.signals
        ? options.signals.filter((signal) => Number(signal.characterId) !== excludedCharacterId
            && !afkOwners.has(Number(signal.characterId)))
        : states(options)
            .filter((state) => Number(state.characterId) !== excludedCharacterId
                && !afkOwners.has(Number(state.characterId)))
            .map((state) => demandSignal(state, selfId, timestamp))
            .filter(Boolean);
    const afkOrderUnits = afkOrders.reduce((sum, offer) => sum + Number(offer.count), 0);
    const fundedAfkUnits = afkOrders.reduce((sum, offer) => sum + (
        unitPrice <= 0 || Number(offer.price) >= unitPrice ? Number(offer.count) : 0
    ), 0);
    const towns = signals.reduce((result, signal) => {
        if (!signal.town) return result;
        result[signal.town] = (result[signal.town] || 0) + signal.amount;
        return result;
    }, {});
    afkOrders.forEach((offer) => {
        if (offer.town) towns[offer.town] = (towns[offer.town] || 0) + Number(offer.count);
    });
    const readySignals = signals.filter((signal) => signal.ready);
    const affordableUnits = (signal) => {
        if (!signal.ready) return 0;
        if (unitPrice <= 0) return signal.budget > 0 ? signal.amount : 0;
        return Math.min(signal.amount, Math.floor(signal.budget / unitPrice));
    };
    return {
        selfId: Number(selfId),
        bots: signals.length,
        readyBots: readySignals.length,
        fundedBots: readySignals.filter((signal) => affordableUnits(signal) > 0).length,
        afkOrders: afkOrders.length,
        units: signals.reduce((sum, signal) => sum + signal.amount, 0) + afkOrderUnits,
        readyUnits: readySignals.reduce((sum, signal) => sum + signal.amount, 0) + afkOrderUnits,
        fundedUnits: signals.reduce((sum, signal) => sum + affordableUnits(signal), 0) + fundedAfkUnits,
        unitPrice,
        towns,
        signals
    };
}

// The sellers of an item: the board's sell lines, and `options.supplyByItem`
// (the supply a caller already has, by item) besides.
function supplyFor(selfId, options = {}) {
    const excludedCharacterId = Number(options.excludeCharacterId || 0);
    const coldOffers = options.supplyByItem?.get(Number(selfId)) || [];
    const offers = coldOffers.filter((offer) => Number(offer.characterId) !== excludedCharacterId)
        .concat(invoke('GameServer/AfkTrade/AfkTradeService').offers(selfId, 1, {
        characterId: excludedCharacterId
    }).map((offer) => ({
        characterId: Number(offer.sourceId),
        town: offer.town,
        count: Number(offer.count),
        price: Number(offer.price)
    })));
    return {
        selfId: Number(selfId),
        sellers: offers.length,
        units: offers.reduce((sum, offer) => sum + offer.count, 0),
        minimumPrice: offers.reduce((minimum, offer) => (
            offer.price > 0 ? Math.min(minimum, offer.price) : minimum
        ), Infinity),
        offers
    };
}

function snapshot(selfId, options = {}) {
    return {
        demand: demandFor(selfId, options),
        supply: supplyFor(selfId, options)
    };
}

module.exports = { WANTED_TTL_MS, demandFor, demandSignal, indexSignals, signalsOfState,
    snapshot, supplyFor, timestampForWanted };
