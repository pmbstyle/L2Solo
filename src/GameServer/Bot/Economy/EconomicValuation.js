'use strict';

const positive = value => Math.max(0, Number(value) || 0);
const trait = (persona, key) => Math.max(0, Math.min(1, Number(persona?.traits?.[key] ?? 0.5)));

function riskWeight(state, persona) {
    return (1 + trait(persona, 'caution')) / (0.5 + trait(persona, 'resilience'))
        * (1 + positive(state.stats?.frustration));
}
function stageHours(state, expPerHour, persona) {
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    const Data = invoke('GameServer/DataCache');
    const Cap = invoke('GameServer/Progression/ProgressionCap');
    const level = positive(state.level) || 1;
    const stage = Learning.stages().find(row => row.grade === Learning.gradeOfLevel(level));
    const cap = Cap.effectiveLevelCap();
    if (level >= cap) return 1 + 24 * trait(persona, 'commitment');
    const end = Math.min(cap, stage.maxLevel + 1);
    const remaining = Math.max(0, Number(Data.experience[end - 1]) - positive(state.stats?.exp ?? state.exp));
    return expPerHour > 0 ? remaining / expPerHour : 0;
}
function deathHours(state, { expPerHour = 0, walkBackHours, returnHours, lostGearHours = 0, spotId } = {}) {
    const Death = invoke('GameServer/Progression/DeathExperience');
    const loss = Death.calculateLoss({ ...state, exp: state.stats?.exp ?? state.exp ?? 0 });
    const downtime = walkBackHours ?? returnHours ?? require('./WalkBack').hours(spotId || state.spotId, state);
    return (expPerHour > 0 ? loss.expLost / expPerHour : 0) + 90 / 3600 + positive(downtime) + positive(lostGearHours);
}
function karmaHours(state, { expPerHour = 0, lostGearHours = 0, exposureHours = 0, deathsPerHour = 0 } = {}) {
    const karma = positive(state.stats?.karma);
    if (!karma) return 0;
    const wash = expPerHour > 0 ? karma * invoke('GameServer/Karma').XP_DIVIDER / expPerHour : Infinity;
    return wash + positive(lostGearHours) * positive(deathsPerHour) * Math.max(wash, positive(exposureHours));
}
function pkDropValue(state, priceOf) {
    return require('../../PkDropPolicy').expectedValue(state.physicalInventory
        ? { ...state, inventory: state.physicalInventory } : state, priceOf);
}
function resale(price, { trend = 0, hours = 0, understanding = 0.3, assertiveness = 0.5,
    caution = 0.5, nextBuyerUse = price, npcFloor = 0 } = {}) {
    const forecast = positive(price) * Math.exp(Math.max(-20, Math.min(20,
        Number(trend || 0) * positive(hours) * positive(understanding) * (1 + assertiveness - caution))));
    return Math.max(positive(npcFloor), Math.min(forecast, positive(nextBuyerUse)));
}
function progressStats(state, { timestamp = Date.now(), startedAt = 0, kills = 0, losses = 0,
    lossHours = 0, risky = false, persona = {}, knowledgeEnabled = true } = {}) {
    const stats = state.stats || {};
    const at = Number(stats.economyClock || state.timing?.lastResolvedAt || 0);
    const elapsed = at >= startedAt && timestamp > at ? (timestamp - at) / 3600000 : 0;
    const frustration = positive(stats.frustration) * Math.exp(-elapsed)
        + positive(losses) * positive(lossHours) * (1 - trait(persona, 'resilience')) * (risky ? 0.5 : 1);
    return { playedHours: positive(stats.playedHours) + elapsed, economyClock: timestamp,
        frustration: Math.max(0, frustration - positive(kills) / Math.max(1, positive(stats.lifelongKills) + positive(kills))),
        lifelongKills: positive(stats.lifelongKills) + (knowledgeEnabled ? positive(kills) : 0) };
}
module.exports = { riskWeight, stageHours, deathHours, karmaHours, pkDropValue, resale, progressStats, trait };
