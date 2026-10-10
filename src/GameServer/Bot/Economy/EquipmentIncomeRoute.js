'use strict';

// Only economic errands may deliberately hunt below the ordinary XP band.
// Deep-blue drop/spoil penalties still apply in the native reward facts.
function economicHunt(state) {
    return invoke('GameServer/Bot/AI/PersonalGearProgression').personal(state)
        && /^(power:|resale:)/.test(String(state.stats?.wishFocus?.[0] || ''));
}

function select(state, { spots = [], occupancy = {}, timestamp = Date.now(), price, required = false, mode,
    maxChecks = 32 } = {}) {
    if (!spots.length || state.party?.partyId || ['party', 'duo'].includes(mode)
        || !invoke('GameServer/Bot/AI/PersonalGearProgression').personal(state)) return null;
    const Roles = invoke('GameServer/Bot/AI/BotRoles');
    const role = state.stats?.role || Roles.inferRole(state.stats?.classId || 0);
    const spoiler = !!invoke('GameServer/Bot/Population/ColdKillRewards').spoilerFor(state,
        { skills: invoke('GameServer/Bot/Population/ColdCombatProfile').skillsFor(state) });
    if (!required && !economicHunt(state) && !spoiler) return null;
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const Index = invoke('GameServer/Bot/AI/SpotIndex');
    const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const costs = Hunt.consumablePrices(state, price);
    const tableRole = spoiler ? 'spoiler' : role === 'melee' || role === 'crafter' ? 'dps' : role === 'nuker' ? 'mage' : role;
    const evaluate = require('./SpotEconomics').create(state, { timestamp, occupancy, price, moneyWeight: 1 });
    const excluded = Risk.excludedSpotIdsForStates([state], timestamp);
    const options = { timestamp, mode: 'solo', occupancy, matchupProfiles: Match.stateProfiles(state, { timestamp }) };
    const survives = Match.soloSpotUpperBound(options.matchupProfiles);
    const origin = Index.spotById(spots, state.spotId)?.center || state.loc;
    const ids = new Set([state.spotId, ...Hunt.sampledRows(state, timestamp).map(row => row.spotId)]);
    const minGap = -15;
    const candidates = shots => {
        for (const row of Table.rankedIncome(tableRole, state.level, costs, minGap, shots)) ids.add(row.spotId);
        return [...ids].map(id => Index.spotById(spots, id)).filter(spot => spot && !spot.raidBoss
            && Number(spot.avgLevel || spot.minLevel || 1) - state.level >= minGap
            && !excluded.has(String(spot.id)) && survives(spot)
            && !Routes.localityPenaltyForSpot(spot, state, { level: state.level }, Routes.tagsForSpot(spot))
            && Profiles.hasCapacityForStates(spot, [state], occupancy))
            .map(spot => {
                const row = evaluate(spot, shots);
                const walkHours = origin && spot.center ? Math.hypot(origin.locX - spot.center.locX,
                    origin.locY - spot.center.locY) / (120 * 3600) : 0;
                // Amortize relocation over a half-hour earning visit. Actual
                // town fees/time are still charged by the common wish paths.
                return { spot, row, score: (row?.valueHours || 0) / (1 + walkHours / 0.5) };
            }).filter(row => row.row?.income > 0 && row.score > 0)
            .sort((a, b) => b.score - a.score || String(a.spot.id).localeCompare(String(b.spot.id)));
    };
    // Compare both charge policies and the entire earning band together.
    // Returning the first charged/near-level camp hid cheaper easier hunts.
    const shortlist = [true, false].flatMap(candidates).sort((a, b) => b.score - a.score
        || Number(a.spot.avgLevel || 1) - Number(b.spot.avgLevel || 1)
        || String(a.spot.id).localeCompare(String(b.spot.id)));
    for (const candidate of shortlist.slice(0, Math.max(1, maxChecks))) {
        if (Routes.isSpotAllowedForState(candidate.spot, state, options)) return candidate;
    }
    return null;
}

module.exports = { select, economicHunt };
