const BotPersona = invoke('GameServer/Bot/AI/BotPersona');

const MIN_DEATHS_AT_NEW_SPOT = 2;
const MIN_DEATH_RATE = 0.2;
const MIN_ADENA_RESERVE = 500;
const RESERVE_RATE = 0.2;

function personaFor(state = {}) {
    return state?.persona?.traits ? state.persona : BotPersona.generate(state);
}

// The baseline is stamped by BotLifeState when a resolver actually puts the
// bot on another farming spot. This intentionally ignores historic deaths:
// an old failure at a starter camp must not cause a purchase at every future
// town visit.
function spotDeathPressure(state = {}) {
    const risk = state.stats?.spotRisk;
    if (!risk || String(risk.spotId || '') !== String(state.spotId || '')) return null;
    const deaths = Math.max(0, Number(state.stats?.deaths || 0) - Number(risk.deathsAtEntry || 0));
    const fights = Math.max(0, Number(state.stats?.fightsResolved || 0) - Number(risk.fightsAtEntry || 0));
    const deathRate = deaths / Math.max(1, fights);
    if (deaths < MIN_DEATHS_AT_NEW_SPOT || deathRate < MIN_DEATH_RATE) return null;
    return { spotId: risk.spotId, deaths, fights, deathRate };
}

function investmentOpportunity(state = {}, estimatedCost = 0) {
    if (personaFor(state)?.primaryDrive !== 'wealth') return null;
    const pressure = spotDeathPressure(state);
    if (!pressure) return null;
    const cost = Math.max(1, Number(estimatedCost) || 0);
    const reserve = Math.max(MIN_ADENA_RESERVE, Math.ceil(cost * RESERVE_RATE));
    const adena = Math.max(0, Number(state.adena || 0));
    return {
        pressure,
        reserve,
        affordable: adena >= cost + reserve,
        reason: 'reduce_deaths_at_profitable_spot'
    };
}

module.exports = {
    MIN_DEATHS_AT_NEW_SPOT,
    MIN_DEATH_RATE,
    MIN_ADENA_RESERVE,
    RESERVE_RATE,
    investmentOpportunity,
    spotDeathPressure
};
