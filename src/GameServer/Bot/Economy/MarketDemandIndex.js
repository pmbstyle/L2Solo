const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

const WANTED_TTL_MS = 30 * 60 * 1000;

function timestampForWanted(wanted = {}) {
    const value = wanted || {};
    return Math.max(Number(value.lastMissingAt || 0), Number(value.lastTradeAdAt || 0));
}

function demandSignal(state, selfId, timestamp) {
    if (!state || Number(state.characterId || 0) <= 0) return null;
    const wanted = state.stats?.marketWanted;
    const plan = state.stats?.equipmentPlan;
    const wantedAt = timestampForWanted(wanted);
    const recentWanted = Number(wanted?.itemId || 0) === Number(selfId)
        && wantedAt > 0
        && wantedAt + WANTED_TTL_MS > timestamp;
    const activeTarget = plan?.status === 'active'
        && Number(plan.target?.selfId || 0) === Number(selfId);
    const material = ['active', 'component_ready', 'ready_to_craft'].includes(plan?.status)
        ? (plan.materials || []).find((item) => Number(item.selfId) === Number(selfId) && Number(item.missing || 0) > 0)
        : null;

    if (!recentWanted && !activeTarget && !material) return null;
    const ready = recentWanted || (activeTarget && plan.strategy === 'market') || Boolean(material?.marketFallback);
    return {
        characterId: Number(state.characterId),
        name: state.name || null,
        town: state.currentRegion || null,
        amount: Math.max(1, Number(material?.missing || 1)),
        budget: Math.max(0, Number(state.adena || 0)),
        ready,
        source: recentWanted ? 'wanted' : material ? 'craft' : plan.strategy === 'market' ? 'market_plan' : 'progression_plan'
    };
}

function states(options = {}) {
    return options.states || LifeState.allStates(5000);
}

function demandFor(selfId, options = {}) {
    const timestamp = Number(options.now) || Date.now();
    const unitPrice = Math.max(0, Number(options.unitPrice || 0));
    const excludedCharacterId = Number(options.excludeCharacterId || 0);
    const signals = states(options)
        .filter((state) => Number(state.characterId) !== excludedCharacterId)
        .map((state) => demandSignal(state, selfId, timestamp))
        .filter(Boolean);
    const towns = signals.reduce((result, signal) => {
        if (!signal.town) return result;
        result[signal.town] = (result[signal.town] || 0) + signal.amount;
        return result;
    }, {});
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
        units: signals.reduce((sum, signal) => sum + signal.amount, 0),
        readyUnits: readySignals.reduce((sum, signal) => sum + signal.amount, 0),
        fundedUnits: signals.reduce((sum, signal) => sum + affordableUnits(signal), 0),
        unitPrice,
        towns,
        signals
    };
}

function supplyFor(selfId, options = {}) {
    const excludedCharacterId = Number(options.excludeCharacterId || 0);
    const offers = states(options).flatMap((state) => {
        if (Number(state.characterId) === excludedCharacterId || state.activity !== 'merchant') return [];
        const store = state.stats?.marketStore;
        if (!store || Number(store.storeType || 1) !== 1) return [];
        const item = (store.items || []).find((entry) => Number(entry.selfId) === Number(selfId) && Number(entry.count || 0) > 0);
        if (!item) return [];
        return [{
            characterId: Number(state.characterId),
            town: store.town || state.currentRegion || null,
            count: Number(item.count),
            price: Number(item.price || 0)
        }];
    });
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

module.exports = { WANTED_TTL_MS, demandFor, demandSignal, snapshot, supplyFor, timestampForWanted };
