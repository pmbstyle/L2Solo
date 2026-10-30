'use strict';
// Resolved at the first call (cycles); a require per call is a path lookup (L73).
let SpotRewardExpectation = null;
const Diagnostics = require('./EconomyDiagnostics');
// The hour fields of a table row that follow its kills (SpotValueTable.value).
const PER_KILL_FIELDS = ['kills', 'deaths', 'exp', 'sp', 'adena', 'dropLoot', 'spoilLoot', 'loot', 'shots', 'potions'];
// Shared table evaluation. It depends on native facts and own samples,
// never on Context or pricing, so route and wish readers cannot recurse.
function moneyWeight(state) {
    const packet = state.stats?.money;
    if (Array.isArray(packet)) {
        const gapPrice = Number(packet[3]);
        return Number.isFinite(gapPrice) && gapPrice > 0 ? 1 : 0;
    }
    const focus = state.stats?.wishFocus;
    const price = Array.isArray(focus) ? Number(focus[2]) : 0;
    return Number.isFinite(price) && price > Math.max(0, Number(state.adena) || 0) ? 1 : 0;
}

// hunt: the build's own hunt (EconomyContext), so one build reads one hour;
// a caller outside a build leaves it out and gets the bot's bare hunt.
// spotHunters(spot, state): the hunters on a spot with the bot among them,
// of the thread that plans (SpotOccupancyIndex.huntersOn): by default
// SpotProfiles.spotHunters, this thread's occupancy (main's world index, a
// worker's kernel index).
function create(state, { timestamp = Date.now(), mode, persona, deathHours, moneyWeight: weight = moneyWeight(state), price, hunt,
    spotHunters = invoke('GameServer/Bot/Population/SpotProfiles').spotHunters } = {}) { // lazy: cycle SpotProfiles' route search builds this reader
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
    const Tendency = invoke('GameServer/Bot/AI/TendencyRoll');
    const positive = value => Math.max(0, Number(value) || 0);
    persona ||= invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
    const tableRole = Table.roleFor(state);
    hunt ??= Hunt.huntIncome(state, timestamp, mode);
    // The previous build's packet hour comes first, by design; the hunt only fills a missing packet.
    const packetHour = Number(state.stats?.money?.[0]);
    const huntHour = Number(hunt.perHour);
    const bestIncome = packetHour > 0 && Number.isFinite(packetHour) || huntHour > 0 && Number.isFinite(huntHour)
        ? null : Table.best(tableRole, state.level, true, 'income');
    const hourAdena = Math.max(1, Number.isFinite(packetHour) && packetHour > 0 ? packetHour
        : Number.isFinite(huntHour) && huntHour > 0 ? huntHour : Number(bestIncome?.adena || 0) + Number(bestIncome?.loot || 0));
    deathHours ??= Valuation.deathHours(state, hunt);
    const riskWeight = Valuation.riskWeight(state, persona);
    const costs = Hunt.consumablePrices(state, price);
    const rewardOptions = { spoilSkillLevel: (SpotRewardExpectation ||= require('./SpotRewardExpectation')).spoilSkillLevel(state) };
    const own = Hunt.sampledRows(state, timestamp, mode);
    const calibrations = own.flatMap(row => {
        const base = Table.value(row.spotId, tableRole, state.level, true, rewardOptions);
        return base?.exp > 0 ? [Math.max(0, row.exp) / row.cycleMs * 3600000 / base.exp] : [];
    });
    const calibration = calibrations.length ? calibrations.reduce((sum, value) => sum + value, 0) / calibrations.length : 1;
    const incomeError = Learning.knowledgeEnabled() ? Learning.stageError(0.03 + 0.25 * (1 - Number(persona.understanding ?? 0.3)),
        0.03, state.stats?.lifelongKills ?? state.stats?.fightsWon ?? 0, Learning.gradeOfLevel(state.level)) : 0;
    // A table row on a spot other bots hunt (user 10-29): its kills at most the
    // bot's share of what the spawns it may fight give back, production over
    // the hunters with it (BackgroundResolver.soloShareMobs in the fight); the
    // hour's fields follow its kills.
    // A crowd cut (crowdFactor < 1) is counted as spot_value:crowd:cut
    // (developer diagnostics).
    const crowded = (spot, row, shots) => {
        const hunters = row && spotHunters ? spotHunters(spot, state) : 1;
        if (!(hunters > 1)) return row;
        const share = Number(Table.production(spot.id, tableRole, state.level, shots)) / hunters;
        const factor = share > 0 && row.kills > 0 ? Math.min(1, share / row.kills) : 1;
        if (factor >= 1) return row;
        if (Diagnostics.active()) Diagnostics.count('spot_value', 'crowd', 'cut');
        const out = { ...row, crowdFactor: factor };
        for (const field of PER_KILL_FIELDS) if (Number.isFinite(row[field])) out[field] = row[field] * factor;
        return out;
    };
    return (spot, shots = hunt.useShots !== false) => {
        // Charged observations cannot estimate a deliberately uncharged hunt.
        const observed = shots ? own.find(row => row.spotId === spot.id) : null;
        const rate = observed ? 3600000 / observed.cycleMs : 0;
        const theoretical = crowded(spot, Table.value(spot.id, tableRole, state.level, shots, rewardOptions), shots);
        const base = observed ? {
            exp: observed.exp * rate, adena: observed.adena * rate, loot: observed.loot * rate,
            kills: observed.kills * rate, deaths: theoretical?.deaths || 0, costs: Number(observed.costs || 0) * rate
        } : theoretical;
        if (!base) return null;
        const bias = 1 + incomeError * (2 * Tendency.roll('spot-income', state.characterId, spot.id) - 1);
        const scale = observed ? 1 : calibration;
        // The bot's own observed row already carries the share it got (ARCH-08-b);
        // a table row shares the spot's production with its other hunters (crowded).
        const row = { ...base, useShots: shots, exp: base.exp * scale * bias,
            adena: base.adena * scale * bias, loot: base.loot * scale * bias,
            kills: base.kills * scale };
        // Own deaths calibrate danger independently, then receive the same
        // learned personal evaluation floor as income.
        const sample = state.stats?.spotRisk?.spotId === spot.id ? state.stats.spotRisk : null;
        if (sample?.windowFights > 0) row.deaths = row.kills * positive(sample.windowDeaths) / sample.windowFights;
        const riskBias = 1 + incomeError * (2 * Tendency.roll('spot-danger', state.characterId, spot.id) - 1);
        row.deaths *= riskBias;
        row.riskHours = row.deaths * deathHours * riskWeight;
        row.costs = observed ? Number(observed.costs || 0) * rate
            : (Number(base.shots || 0) * costs.shots + Number(base.potions || 0) * costs.potions) * calibration;
        row.income = row.adena + row.loot - row.costs;
        row.valueHours = row.exp / Math.max(1, hunt.expPerHour) * (1 - weight)
            + row.income / hourAdena * weight - row.riskHours;
        return row;
    };
}
module.exports = { create, moneyWeight };
