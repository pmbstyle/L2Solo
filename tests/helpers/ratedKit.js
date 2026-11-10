'use strict';
// A state as main reads it once its build published the kit:
// the per-bot kit rates (stats.kitRates) and the earning answer's per-spot use
// (stats.earning: shotsPerHour, potionsPerHour), here from the bot's basics.
// A held answer keeps its spot; a bot with none holds the basics' spot.
module.exports = function ratedKit(state, deps = {}) {
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const base = Economy.basics(state, deps);
    const earning = { ...(state.stats?.earning || { spotId: base.bestSpotId ?? null, shots: true, income: 0, expected: 0,
        earning: 0, error: 0, at: 0 }), shotsPerHour: base.rates.shotUse, potionsPerHour: base.rates.potionUse };
    return { ...state, stats: { ...state.stats, kitRates: Economy.kitRates(base), earning } };
};
