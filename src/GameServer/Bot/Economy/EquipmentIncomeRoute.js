'use strict';
const ColdKillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');
const BotHuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const SpotEconomics = require('./SpotEconomics');
const WalkBack = require('./WalkBack');

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
    // Values in the role's best hour of the band, not the bot's own: an hour
    // read at the spot it stands on makes two spots each look better from the
    // other (own outputs are not inputs).
    const role = SpotValueTable.roleFor(state), bestIncome = SpotValueTable.best(role, state.level, true, 'income');
    const evaluate = SpotEconomics.create(state, { timestamp, price, hour: {
        adena: (bestIncome?.adena || 0) + (bestIncome?.loot || 0), exp: SpotValueTable.best(role, state.level, true, 'exp')?.exp } });
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
                    walkFactor = 1 + WalkBack.tripHours(origin, spot, state, spots) / 0.5;
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
    // A spot full of other bots is no pick (the search's room rule): the bot
    // takes its next best now, not a refused trip.
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles'); // lazy: cycle SpotProfiles' search calls this select
    const open = shortlist.filter(candidate => Spots.roomFor(candidate.spot, state));
    const checks = Math.max(1, maxChecks);
    const pick = open.slice(0, checks).find(candidate => allowed(candidate.spot));
    if (!pick) return null;
    pick.matchupProfiles = options.matchupProfiles;
    // The bot's hour (hourAdena, the unit of every value) stays what it could
    // earn: its best income among the spots it may hunt, wherever it levels.
    pick.earning = pick.row.income;
    for (const candidate of open.toSorted((a, b) => b.row.income - a.row.income).slice(0, checks)) {
        if (candidate.row.income <= pick.earning) break;
        if (allowed(candidate.spot)) { pick.earning = candidate.row.income; break; }
    }
    return pick;
}

module.exports = { select, economicHunt, spotList };
