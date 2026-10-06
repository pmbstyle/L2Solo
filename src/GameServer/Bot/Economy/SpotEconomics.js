'use strict';
// Shared table evaluation. It depends on native facts and own samples,
// never on Context or pricing, so route and wish readers cannot recurse.
function create(state, { timestamp = Date.now(), mode, occupancy, persona, deathHours } = {}) {
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    const Valuation = require('./EconomicValuation');
    const Tendency = require('../AI/TendencyRoll');
    const positive = value => Math.max(0, Number(value) || 0);
    persona ||= invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
    const role = state.party?.role || state.stats?.role || invoke('GameServer/Bot/AI/BotRoles').inferRole(state.stats?.classId || 0);
    const tableRole = role === 'melee' ? 'dps' : role === 'nuker' ? 'mage' : role === 'crafter' ? 'spoiler' : role;
    const hunt = Hunt.huntIncome(state, timestamp, mode);
    deathHours ??= Valuation.deathHours(state, hunt);
    const riskWeight = Valuation.riskWeight(state, persona);
    const own = Hunt.sampledRows(state, timestamp, mode);
    const calibrations = own.flatMap(row => {
        const base = Table.value(row.spotId, tableRole, state.level, true);
        return base?.exp > 0 ? [Math.max(0, row.exp) / row.cycleMs * 3600000 / base.exp] : [];
    });
    const calibration = calibrations.length ? calibrations.reduce((sum, value) => sum + value, 0) / calibrations.length : 1;
    const incomeError = Learning.knowledgeEnabled() ? Learning.stageError(0.03 + 0.25 * (1 - Number(persona.understanding ?? 0.3)),
        0.03, state.stats?.lifelongKills ?? state.stats?.fightsWon ?? 0, Learning.gradeOfLevel(state.level)) : 0;
    return (spot, shots = true) => {
        const observed = own.find(row => row.spotId === spot.id);
        const rate = observed ? 3600000 / observed.cycleMs * Hunt.onSpotShare(state) : 0;
        const base = Table.value(spot.id, tableRole, state.level, shots) || (observed ? {
            exp: observed.exp * rate, adena: observed.adena * rate, loot: observed.loot * rate,
            kills: observed.kills * rate, deaths: 0
        } : null);
        if (!base) return null;
        const entry = occupancy?.[spot.id] || occupancy?.get?.(spot.id);
        const crowd = Math.max(1, positive(entry?.reservedCount ?? entry?.count) / Math.max(1, positive(spot.density)));
        const bias = 1 + incomeError * (2 * Tendency.roll('spot-income', state.characterId, spot.id) - 1);
        const row = { ...base, exp: base.exp * calibration * bias / crowd,
            adena: base.adena * calibration * bias / crowd, loot: base.loot * calibration * bias / crowd,
            kills: base.kills * calibration / crowd };
        // Own deaths calibrate danger independently, then receive the same
        // learned personal evaluation floor as income.
        const sample = state.stats?.spotRisk?.spotId === spot.id ? state.stats.spotRisk : null;
        if (sample?.windowFights > 0) row.deaths = row.kills * positive(sample.windowDeaths) / sample.windowFights;
        const riskBias = 1 + incomeError * (2 * Tendency.roll('spot-danger', state.characterId, spot.id) - 1);
        row.deaths *= riskBias;
        row.riskHours = row.deaths * deathHours * riskWeight;
        row.valueHours = row.exp / Math.max(1, hunt.expPerHour) - row.riskHours;
        return row;
    };
}
module.exports = { create };
