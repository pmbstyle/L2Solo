'use strict';
const ColdKillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');
const BotHuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const SpotEconomics = require('./SpotEconomics');

// Only economic errands may deliberately hunt below the ordinary XP band.
// Deep-blue drop/spoil penalties still apply in the native reward facts.
// Clan warehouse custody does not change a member's ordinary earning routes.
function economicHunt(state) {
    return invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)
        && /^(power:|resale:)/.test(String(state.stats?.wishFocus?.[0] || ''));
}

// The game table's spot list for one bot (ARCH-08-b): its table role (a
// spoiler reads the spoiler list) and its own price beliefs. One object per
// search serves the income route and the spot search: spoiler() and the
// costs are read once, at their first use. ids(shots, level, minGap): spot
// ids of the band level+minGap..level+8, best income first, ties to the spot
// closest to level.
function spotList(state, { price } = {}) {
    let spoiler, costs = null;
    const spoilerOf = () => spoiler !== undefined ? spoiler
        : (spoiler = ColdKillRewards.spoilerFor(state, { skills: ColdCombatProfile.skillsFor(state) }) || null);
    return { spoiler: spoilerOf, ids: (shots, level = state.level, minGap = -7) => SpotValueTable.rankedSpotIds(
        SpotValueTable.roleFor(state), level,
        costs ||= BotHuntEfficiency.consumablePrices(state, price), minGap, shots,
        { spoilSkillLevel: spoilerOf()?.skillLevel || 0 }) };
}

// list: the search's spotList, when the caller reads it too.
function select(state, { spots = [], timestamp = Date.now(), price, required = false, mode,
    maxChecks = 32, list = null } = {}) {
    if (!spots.length || state.party?.partyId || ['party', 'duo'].includes(mode)
        || !invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)) return null;
    const minGap = -15;
    list ||= spotList(state, { price });
    const spoiler = list.spoiler();
    if (!required && !economicHunt(state) && !spoiler) return null;
    const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const Index = invoke('GameServer/Bot/AI/SpotIndex');
    const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
    const evaluate = SpotEconomics.create(state, { timestamp, price, moneyWeight: 1 });
    const excluded = Risk.excludedSpotIdsForStates([state], timestamp);
    const options = { timestamp, mode: 'solo', matchupProfiles: Match.stateProfiles(state, { timestamp }) };
    const survives = Match.soloSpotUpperBound(options.matchupProfiles);
    const origin = Index.spotById(spots, state.spotId)?.center || state.loc;
    const ids = new Set([state.spotId, ...BotHuntEfficiency.sampledRows(state, timestamp).map(row => row.spotId)]);
    // Search-local: null rejects a spot; undefined awaits its first walk factor.
    const spotFactors = new Map();
    const candidates = shots => {
        // costs are the bot's own price beliefs: the id view, not the shared shortlist rows.
        for (const spotId of list.ids(shots, state.level, minGap)) ids.add(spotId);
        return [...ids].map(id => Index.spotById(spots, id)).filter(spot => {
            if (!spot) return false;
            if (spotFactors.has(spot)) return spotFactors.get(spot) !== null;
            const allowed = !spot.raidBoss
                && Number(spot.avgLevel || spot.minLevel || 1) - state.level >= minGap
                && !excluded.has(String(spot.id)) && survives(spot)
                && !Routes.localityPenaltyForSpot(spot, state, { level: state.level }, Routes.tagsForSpot(spot));
            spotFactors.set(spot, allowed ? undefined : null);
            return allowed;
        })
            .map(spot => {
                const row = evaluate(spot, shots);
                let walkFactor = spotFactors.get(spot);
                if (walkFactor === undefined) {
                    const walkHours = origin && spot.center ? Math.hypot(origin.locX - spot.center.locX,
                        origin.locY - spot.center.locY) / (120 * 3600) : 0;
                    walkFactor = 1 + walkHours / 0.5;
                    spotFactors.set(spot, walkFactor);
                }
                // Amortize relocation over a half-hour earning visit. Actual
                // town fees/time are still charged by the common wish paths.
                return { spot, row, score: (row?.valueHours || 0) / walkFactor };
            }).filter(row => row.row?.income > 0 && row.score > 0)
            .sort((a, b) => b.score - a.score || String(a.spot.id).localeCompare(String(b.spot.id)));
    };
    // Compare both charge policies and the entire earning band together.
    // Returning the first charged/near-level camp hid cheaper easier hunts.
    const shortlist = [true, false].flatMap(candidates).sort((a, b) => b.score - a.score
        || Number(a.spot.avgLevel || 1) - Number(b.spot.avgLevel || 1)
        || String(a.spot.id).localeCompare(String(b.spot.id)));
    // One profile and safety read for the whole shortlist (L131). The chosen
    // route carries its solo profiles: the same build's source route reader
    // (GearAcquisitionPlanner.sourceRouteReader) reads the same ones.
    const allowed = Routes.spotAllowedReaderFor(state, options);
    for (const candidate of shortlist.slice(0, Math.max(1, maxChecks))) {
        if (allowed(candidate.spot)) { candidate.matchupProfiles = options.matchupProfiles; return candidate; }
    }
    return null;
}

module.exports = { select, economicHunt, spotList };
