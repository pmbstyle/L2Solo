const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');

const MIN_DEATHS_AT_NEW_SPOT = SpotRiskPolicy.MIN_DEATHS_AT_SPOT;
const MIN_DEATH_RATE = SpotRiskPolicy.MIN_DEATH_RATE;
const MIN_ADENA_RESERVE = 500;
const RESERVE_RATE = 0.2;

function personaFor(state = {}) {
    return BotPersona.of(state);
}

// The baseline is stamped by BotLifeState when a resolver actually puts the
// bot on another farming spot. This intentionally ignores historic deaths:
// an old failure at a starter camp must not cause a purchase at every future
// town visit.
function spotDeathPressure(state = {}) {
    return SpotRiskPolicy.deathPressure(state);
}

// The investment is affordable when the shared rule funds the purchase
// (PurchaseFunding: wallet plus the bot's own buy-order escrow) with the larger
// of the plan's reserve and the investment's own cushion (20% of the cost) kept.
function investmentOpportunity(state = {}, estimatedCost = 0, planReserve = 0, escrow = 0) {
    if (personaFor(state)?.primaryDrive !== 'wealth') return null;
    const pressure = spotDeathPressure(state);
    if (!pressure) return null;
    const cost = Math.max(1, Number(estimatedCost) || 0);
    const reserve = Math.max(MIN_ADENA_RESERVE, Math.ceil(cost * RESERVE_RATE));
    return {
        pressure,
        reserve,
        affordable: PurchaseFunding.shortfall(state, cost, Math.max(Number(planReserve || 0), reserve), escrow) === 0,
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
