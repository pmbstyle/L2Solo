const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');

const MIN_DEATHS_AT_NEW_SPOT = SpotRiskPolicy.MIN_DEATHS_AT_SPOT;
const MIN_DEATH_RATE = SpotRiskPolicy.MIN_DEATH_RATE;
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
    return SpotRiskPolicy.deathPressure(state);
}

// The investment is affordable when the purchase is funded by the shared rule
// (PurchaseFunding: wallet plus the bot's own buy-order escrow, the plan's
// reserve kept) and the investment's own cushion (20% of the cost) is left too.
function investmentOpportunity(state = {}, estimatedCost = 0, funding = {}) {
    if (personaFor(state)?.primaryDrive !== 'wealth') return null;
    const pressure = spotDeathPressure(state);
    if (!pressure) return null;
    const cost = Math.max(1, Number(estimatedCost) || 0);
    const reserve = Math.max(MIN_ADENA_RESERVE, Math.ceil(cost * RESERVE_RATE));
    return {
        pressure,
        reserve,
        affordable: PurchaseFunding.shortfall(state, cost, funding.reserve, funding.escrow) === 0
            && PurchaseFunding.budget(state, funding.escrow) >= cost + reserve,
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
