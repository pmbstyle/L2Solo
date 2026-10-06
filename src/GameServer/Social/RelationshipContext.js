const sessions = new WeakMap();

function stateOf(source) {
    if (source?.characterId) return source;
    const session = source?.actor ? source : source?.session;
    const id = Number(session?.actor?.fetchId?.() || source);
    return session?.coldLifeState || session?.coldMarketState || session?.coldCraftState
        || invoke('GameServer/Bot/Population/BotLifeState').cachedState(id);
}
function playedHours(source, at = Date.now()) {
    const session = source?.actor ? source : source?.session;
    const state = stateOf(source), saved = Math.max(0, Number(state?.stats?.playedHours || 0));
    if (!session?.actor?.fetchIsOnline?.() || state?.phase === 'cold') return saved;
    let clock = sessions.get(session);
    if (!clock) { clock = { at, saved }; sessions.set(session, clock); }
    return Math.max(saved, clock.saved + Math.max(0, at - clock.at) / 3600000);
}
function enrich(event, source, target = null) {
    if (event.playedHours !== undefined) return event;
    const state = stateOf(source);
    const persona = invoke('GameServer/Bot/AI/BotPersona').of(state || source || {});
    const human = !!target?.session?.accountId && !String(target.session.accountId).startsWith('bot_');
    let hours = Number(event.hours);
    if (!Number.isFinite(hours) && state) {
        const income = invoke('GameServer/Bot/AI/BotHuntEfficiency').huntIncome(state, event.at);
        if (event.type === 'killed') hours = invoke('GameServer/Bot/Economy/EconomicValuation').deathHours(state, income);
        else if (Number(event.lossExp) > 0 && income.expPerHour > 0) hours = event.lossExp / income.expPerHour;
        else if (Number(event.valueAdena) > 0 && income.perHour > 0) hours = event.valueAdena / income.perHour;
    }
    return { ...event, playedHours: playedHours(source, event.at), traits: persona?.traits || {},
        ...(human ? { player: true } : {}), ...(Number.isFinite(hours) && hours >= 0 ? { hours } : {}) };
}
module.exports = { playedHours, enrich };
