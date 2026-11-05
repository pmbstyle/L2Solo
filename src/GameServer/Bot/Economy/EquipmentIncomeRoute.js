'use strict';
const ColdKillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');
const BotHuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const SpotEconomics = require('./SpotEconomics');
const WalkBack = require('./WalkBack');
const Diagnostics = require('./EconomyDiagnostics');

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
// costs are read once, at their first use. ids(shots, level, minGap, cuts):
// spot ids of the band level+minGap..level+8, best income first, ties to the
// spot closest to level.
function spotList(state, { price } = {}) {
    let spoiler, costs = null;
    const spoilerOf = () => spoiler !== undefined ? spoiler
        : (spoiler = ColdKillRewards.spoilerFor(state, { skills: ColdCombatProfile.skillsFor(state) }) || null);
    return { spoiler: spoilerOf, ids: (shots, level = state.level, minGap = -7) => SpotValueTable.rankedSpotIds(
        SpotValueTable.roleFor(state), level,
        costs ||= BotHuntEfficiency.consumablePrices(state, price), minGap, shots,
        { spoilSkillLevel: spoilerOf()?.skillLevel || 0 }) };
}

// The earning spot search (the decision's, EconomyContext.incomeRouteFor while it is woken): { route (null: none),
// error (the bot's own error on a row's income, SpotEconomics incomeError) }. select: the route alone.
function search(state, options) {
    return find(state, options);
}
function select(state, options) {
    return find(state, options).route;
}
// The solo matchup the search reads.
function matchupOptions(state, timestamp) {
    return { timestamp, mode: 'solo', matchupProfiles: invoke('GameServer/Bot/AI/BotTargetMatchup').stateProfiles(state, { timestamp }) };
}
// The search's spot values (find, heldRoute): SpotEconomics' reader in the
// role's best hour of the band, not the bot's own: an hour read at the spot
// it stands on makes two spots each look better from the other (own outputs
// are not inputs); at the bot's money weight.
function valuesFor(state, timestamp, price) {
    const role = SpotValueTable.roleFor(state), bestIncome = SpotValueTable.best(role, state.level, true, 'income');
    const hour = { adena: (bestIncome?.adena || 0) + (bestIncome?.loot || 0), exp: SpotValueTable.best(role, state.level, true, 'exp')?.exp };
    const weight = SpotEconomics.moneyWeight(state);
    return { hour, weight, evaluate: SpotEconomics.create(state, { timestamp, price, hour, moneyWeight: weight }) };
}
function find(state, { spots = [], timestamp = Date.now(), price, required = false, mode,
    maxChecks = 32, list = null } = {}) {
    const none = { route: null, error: 0 };
    if (!spots.length || state.party?.partyId || ['party', 'duo'].includes(mode)
        || !invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)) return none;
    const minGap = -15;
    list ||= spotList(state, { price });
    const spoiler = list.spoiler();
    if (!required && !economicHunt(state) && !spoiler) return none;
    const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const Index = invoke('GameServer/Bot/AI/SpotIndex');
    const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
    const { evaluate } = valuesFor(state, timestamp, price);
    const excluded = Risk.excludedSpotIdsForStates([state], timestamp);
    const options = matchupOptions(state, timestamp);
    const survives = Match.soloSpotUpperBound(options.matchupProfiles);
    const origin = Index.spotById(spots, state.spotId)?.center || state.loc;
    const sampled = BotHuntEfficiency.sampledRows(state, timestamp).map(row => row.spotId);
    const ids = new Set([state.spotId, ...sampled]);
    // Search-local: null rejects a spot; undefined awaits its first walk factor.
    const spotFactors = new Map();
    // A spot the bot may earn at, whatever the prices.
    const admitted = spot => {
        if (!spot) return false;
        if (spotFactors.has(spot)) return spotFactors.get(spot) !== null;
        const allowed = !spot.raidBoss
            && Number(spot.avgLevel || spot.minLevel || 1) - state.level >= minGap
            && !excluded.has(String(spot.id)) && survives(spot)
            && !Routes.localityPenaltyForSpot(spot, state, { level: state.level }, Routes.tagsForSpot(spot));
        spotFactors.set(spot, allowed ? undefined : null);
        return allowed;
    };
    // Every spot the bot may earn at with this charge policy, each with its
    // score; those earning nothing at the prices read stay out.
    const candidates = shots => {
        // costs are the bot's own price beliefs: the id view, not the shared shortlist rows.
        for (const spotId of list.ids(shots, state.level, minGap)) ids.add(spotId);
        return [...ids].map(id => Index.spotById(spots, id)).filter(admitted)
            .map(spot => {
                const row = evaluate(spot, shots);
                let walkFactor = spotFactors.get(spot);
                if (walkFactor === undefined) {
                    walkFactor = 1 + WalkBack.tripHours(origin, spot, state, spots) / 0.5;
                    spotFactors.set(spot, walkFactor);
                }
                // Amortize relocation over a half-hour earning visit. Actual
                // town fees/time are still charged by the common wish paths.
                return { spot, row, walkFactor, score: (row?.valueHours || 0) / walkFactor };
            }).filter(row => row.row?.income > 0);
    };
    // Compare both charge policies and the entire earning band together.
    // Returning the first charged/near-level camp hid cheaper easier hunts.
    // The same spot under both policies ties on all keys: the charged one first.
    const pool = [true, false].flatMap(candidates);
    const shortlist = pool.filter(row => row.score > 0).sort((a, b) => b.score - a.score
        || Number(a.spot.avgLevel || 1) - Number(b.spot.avgLevel || 1)
        || String(a.spot.id).localeCompare(String(b.spot.id)));
    // One profile and safety read for the whole shortlist (L131). The chosen
    // route carries its solo profiles: the same build's source route reader
    // (GearAcquisitionPlanner.sourceRouteReader) reads the same ones.
    const allowed = Routes.spotAllowedReaderFor(state, options);
    // A spot full of other bots is no pick (the search's room rule): the bot
    // takes its next best now, not a refused trip.
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles'); // lazy: cycle SpotProfiles' search calls this select
    const open = shortlist.filter(candidate => Spots.roomFor(candidate.spot, state) || !(candidate.closed = true));
    const checks = Math.max(1, maxChecks);
    // Each spot's verdict, asked once.
    const verdicts = new Map();
    const asked = spot => {
        let verdict = verdicts.get(spot);
        if (verdict === undefined) verdicts.set(spot, verdict = !!allowed(spot));
        return verdict;
    };
    const pick = open.slice(0, checks).find(candidate => asked(candidate.spot)) || null;
    if (pick) {
        pick.matchupProfiles = options.matchupProfiles;
        // The bot's hour (hourAdena, the unit of every value) stays what it could
        // earn: its best income among the spots it may hunt, wherever it levels.
        pick.earning = pick.row.income;
        for (const candidate of open.toSorted((a, b) => b.row.income - a.row.income).slice(0, checks)) {
            if (candidate.row.income <= pick.earning) break;
            if (asked(candidate.spot)) { pick.earning = candidate.row.income; break; }
        }
    }
    return { route: pick, error: evaluate.incomeError };
}

// The earning spot's searches and their time since the worker started (the status line's situations
// search=, diagnostics off too): two clock reads per search, ~5 per bot-hour.
const searchCounts = { count: 0, ms: 0 };
const timed = entry => function (state, options) {
    const started = performance.now();
    try { return entry(state, options); } finally {
        const ms = performance.now() - started;
        searchCounts.count++; searchCounts.ms += ms;
        if (Diagnostics.active()) Diagnostics.duration('situations:search', ms);
    }
};

// Whether the bot's hour is its earning spot's (EconomyContext's foundation prices its hunt there): its gear is
// required, its focus is an economic hunt, or it spoils; else it levels (BotHuntEfficiency.huntIncome). The bot
// holds its earning spot either way (the party comparison's solo side reads it); this only says how the build uses it.
function earnsOnRoute(state, required = false) {
    return !!required || economicHunt(state) || !!spotList(state).spoiler();
}
// The earning spot's held answer (situations.md §10, stats.earning in the mind; its one owner of the layout): what
// a search chose, { spotId (null: none), shots (the charge policy of its row), income (the row's income an hour, as
// the bot believes it), expected (the same without its belief bias: SpotEconomics expected), earning (the bot's hour:
// its best income among the spots it may hunt), error (its own error on a row's income, SpotEconomics incomeError),
// at }. ~60 B. found: search's { route }; error: the search's evaluate.incomeError.
function answerOf(route, at, error = 0) {
    return route ? { spotId: String(route.spot.id), shots: route.row.useShots !== false, income: Number(route.row.income) || 0,
        expected: Number(route.row.expected ?? route.row.income) || 0, earning: Number(route.earning) || 0, error: Number(error) || 0, at }
        : { spotId: null, shots: true, income: 0, expected: 0, earning: 0, error: 0, at };
}
// The route of the held answer at the inputs now (no search): its spot's row evaluated once at the reader's prices
// (SpotEconomics, as the search reads it), its hour as decided. null: no answer, none held (spotId null) or a spot
// the catalogue lost.
// A bot in a party has none here: its hunt is the party's (the party comparison reads its solo copy).
function heldRoute(state, { spots = [], timestamp = Date.now(), price, mode = null } = {}) {
    if (state.party?.partyId || state.partyId || ['party', 'duo'].includes(mode)) return null;
    const held = state.stats?.earning;
    if (!held?.spotId) return null;
    const spot = invoke('GameServer/Bot/AI/SpotIndex').spotById(spots, held.spotId);
    if (!spot) return null;
    const row = valuesFor(state, timestamp, price).evaluate(spot, held.shots !== false);
    return row ? { spot, row, earning: Number(held.earning) || 0 } : null;
}

module.exports = { select, search: timed(search), searchTotals: () => ({ ...searchCounts }), economicHunt, spotList,
    answerOf, heldRoute, earnsOnRoute };
