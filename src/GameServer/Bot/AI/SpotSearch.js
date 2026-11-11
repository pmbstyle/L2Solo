'use strict';
// The one solo spot search: where a bot hunts under its goal. Worker-safe (no World): every spot is read
// from the catalogue the caller passes, the spot it stands on is the caller's. rank owns the one filter
// (the catalogue, no raid unless the goal's candidates carry one, the bot's exclusions: marks, death marks,
// death pressure, a camp held against it (SpotRecords); then the goal's level window and cheap clauses), the order by the goal's value and the
// one pick (the habit, below); the costly verdict (ground and matchup) is asked lazily, in that order.
// Goals and their callers:
// - income: the earning decision's search (EquipmentIncomeRoute.find, worker): the bot's hour at a spot
//   over the walk there; with no pick in its window, easier ground (easierGround, the leveling goal's too);
// - source: the gear plan's source of an item (GearAcquisitionPlanner.bestSourceForState: the plan's pick
//   at plan time, BotRoute.huntSpot's plan step at route time): the source's yield per effort;
// - leveling: a bot with no held answer (leveling, via SpotProfiles.findForState: a protected starter, a
//   first decision pending, a party waiter's level ground, an evacuation; a party's ground without the
//   habit): the game table's spot list for its role and level, its income.
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const TendencyRoll = invoke('GameServer/Bot/AI/TendencyRoll');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');

// Favourite camps: among the candidates whose value is within HABIT_BAND of the best passing one's, the
// bot's own seeded roll over the spot picks (TendencyRoll: bot and spot ids, no stored state, the same pick
// at every search while the values stay in the band). Our choice, not C4: a C4 player keeps his own camp
// among equally good ones, so a band's bots do not all take its best camp at once.
const HABIT_BAND = 0.12;

const solo = (state, mode) => !['party', 'duo'].includes(LevelingRoutes.modeForState(state, { mode }));
const spotOfCandidate = candidate => candidate.spot;
const spotIdOf = spot => spot.id;

// rank(state, goal, ctx) -> { pick (a candidate or null), best (the best passing one), ranked (every admitted
// candidate in value order, the unchecked tail too), verdict (candidate -> bool, asked once) }.
// goal: { candidates (iterable), spot(candidate) (default candidate.spot; null: not in the catalogue), id(spot)
//   (default spot.id),
//   fits(candidate, spot) (the goal's level window and cheap clauses), value(candidate, spot) (higher is
//   better; read once for every admitted candidate unless `sorted`, then only for the best and the band),
//   sorted (the candidates come in value order), tie(a, b) (the order of equal values), raid (raid
//   profiles are candidates: the goal's own list decided it) }.
// ctx: { excluded (spot ids), repelled(spotId) (a camp known held against the bot: SpotRecords.reader, on the
//   worker; counted spot:repelled per candidate it drops), allowed(candidate, spot) (the costly verdict), maxChecks (the first n of the
//   order are asked; a counted search left with no pick while more were admitted: spot:search:capped), verdicts (a Map
//   shared by the ranks of one search), habit (default: a solo bot's;
//   off for a party's ground, a clan's operation), mode, count (the pick is the bot's answer: the earning
//   decision's, the route's; a check that only asks whether a source exists, or a plan-time comparison,
//   counts nothing) }.
// The pick: the best passing candidate, then among the band's the highest roll; verdicts are asked in
// value order until one passes, then in roll order only for the band's candidates rolling above it,
// stopping at the first that passes. A counted pick not the best is situations spot:habit:other.
function rank(state, goal, { excluded = null, repelled = null, allowed = null, maxChecks = Infinity, verdicts = new Map(),
    habit = undefined, mode = undefined, count = false } = {}) {
    const spotOf = goal.spot || spotOfCandidate, idOf = goal.id || spotIdOf;
    const spots = new Map(), values = new Map();
    const ranked = [];
    for (const candidate of goal.candidates || []) {
        const spot = spotOf(candidate);
        if (!spot || spot.raidBoss === true && !goal.raid) continue;
        if (excluded && (excluded.has(String(idOf(spot))) || excluded.has(idOf(spot)))) continue;
        if (goal.fits && !goal.fits(candidate, spot)) continue;
        if (repelled?.(idOf(spot))) { noteRepelled(); continue; }
        spots.set(candidate, spot);
        if (!goal.sorted) {
            const value = Number(goal.value(candidate, spot));
            if (!(value > 0)) continue;
            values.set(candidate, value);
        }
        ranked.push(candidate);
    }
    if (!goal.sorted) ranked.sort((a, b) => values.get(b) - values.get(a) || (goal.tie ? goal.tie(a, b) : 0));
    const checked = Math.min(ranked.length, Math.max(1, maxChecks));
    const verdict = candidate => {
        let passed = verdicts.get(candidate);
        if (passed === undefined) verdicts.set(candidate, passed = !allowed || !!allowed(candidate, spots.get(candidate)));
        return passed;
    };
    const valueOf = candidate => values.has(candidate) ? values.get(candidate) : Number(goal.value(candidate, spots.get(candidate)));
    let at = 0;
    while (at < checked && !verdict(ranked[at])) at++;
    const best = at < checked ? ranked[at] : null;
    // The checks ran out, not the candidates: its "none" is the cap's (a limit hit, counted).
    if (!best && count && ranked.length > checked) noteCapped();
    const result = { pick: best, best, ranked, verdict };
    if (!best || !(habit ?? solo(state, mode))) return result;
    const top = valueOf(best);
    if (!(top > 0)) return result;
    const floor = top * (1 - HABIT_BAND), roll = candidate => TendencyRoll.roll('spot_habit', state.characterId, idOf(spots.get(candidate)));
    // Only a roll above the best one's can take its place; the same spot (another charge policy) rolls the same.
    const own = roll(best), band = [];
    for (let next = at + 1; next < checked; next++) {
        const candidate = ranked[next];
        if (!(valueOf(candidate) >= floor)) break;
        const value = roll(candidate);
        if (value > own) band.push({ candidate, value });
    }
    band.sort((a, b) => b.value - a.value);
    for (const { candidate } of band) {
        if (!verdict(candidate)) continue;
        result.pick = candidate;
        if (count) noteHabit();
        break;
    }
    return result;
}

const noteHabit = () => invoke('GameServer/Bot/Situations').note('spot:habit:other');
const noteRepelled = () => invoke('GameServer/Bot/Situations').note('spot:repelled');
const noteCapped = () => invoke('GameServer/Bot/Situations').note('spot:search:capped');

// A bot's raid ground it is sent to (a clan raid objective or its clan-owned raid plan's spot).
function explicitClanRaidSpot(state = {}, profile = null) {
    if (profile?.raidBoss !== true) return false;
    const spotId = String(profile.id || '');
    const objective = state.stats?.clanPartyObjective;
    if (objective?.sourceKind === 'raid' && objective?.clanOperation === 'equipment'
        && String(objective.spotId || '') === spotId) return true;
    const plan = state.stats?.equipmentPlan;
    return plan?.next?.sourceKind === 'raid'
        && invoke('GameServer/Bot/AI/GearAcquisitionPlanner').isClanOwnedPlan(plan) // lazy: cycle the planner ranks its sources here
        && String(plan.next?.spotId || '') === spotId;
}

// Easier ground: where a solo bot hunts when its kit may hunt nothing near its level, one rule for the
// leveling goal (its recovery) and the earning search (EquipmentIncomeRoute.find, its window gave no pick):
// the spots below the level's near window (SpotProfiles.lowerSpots, by the level mix) its kit may survive
// (survives: BotTargetMatchup.soloSpotUpperBound, the optimistic damage prefilter) and the goal accepts
// (accept(spot): its own cheap clauses; none: every one), not excluded; by value (value(spot): a SpotEconomics
// row, its valueHours; a spot with none ranks after every valued one: the table has no row past the
// deep-blue gap), ties by the closest level, then density, then id; the costly verdict (allowed(spot): the
// ground and matchup) asked in that order for the first EASIER_CHECKS (more left unasked with none passed:
// spot:search:capped, rank). A C4 player outgunned at his level farms lower mobs alone. The habit only among spots of a positive value. Returns the pick ({ spot, value })
// or null: none passed (counted by the caller: spot_list:pick:none, earning:no_spot).
// ARCH-NOTE: ALT optimistic damage prefilter preserves exact-safe camps: naked L50 catalogue fixture
// finds 100% of best safe income with 8 exact probes (default 128 found none).
const EASIER_CHECKS = 128;
function easierGround(state, { profiles, targetLevel, excluded, survives, accept = null, value = null, allowed, mode, count = false }) {
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles'); // lazy: cycle its search calls this goal
    const lower = Spots.lowerSpots(profiles, targetLevel)
        .filter(spot => survives(spot) && !excluded.has(String(spot.id)) && (!accept || accept(spot)))
        .map(spot => ({ spot, value: value?.(spot)?.valueHours ?? -Infinity }))
        .sort((a, b) => b.value - a.value || Math.abs(a.spot.avgLevel - targetLevel) - Math.abs(b.spot.avgLevel - targetLevel)
            || b.spot.density - a.spot.density || String(a.spot.id).localeCompare(String(b.spot.id)));
    return rank(state, { candidates: lower, sorted: true, value: candidate => candidate.value },
        { excluded, allowed: (candidate, spot) => allowed(spot), maxChecks: EASIER_CHECKS, mode, count }).pick;
}

// The leveling goal: the spot a bot hunts when no held answer names one (options: the route options of the
// caller, as SpotProfiles.findForState builds them: profiles (the catalogue), currentSpot (the spot it
// stands on, null: none), excludedSpotIds, repelled (SpotRecords.reader), matchupProfiles, spotEconomics, list
// (the game table's list of the bot, EquipmentIncomeRoute.spotList), and the level fit's own options). In order: the spot it stands
// on while it fits (its level, or a protected starter's field) and it need not leave it; the game table's
// list for its role and level (with shots, then without), a suitable spot first, else an allowed one (a
// solo bot keeps its current one when the list holds it: comparable camps must not become a travel loop);
// else the allowed ground near its level, then (solo) easier ground its kit survives. A foreign starter
// field is no list pick. Returns a spot decorated with its route match, or null.
function leveling(state, options = {}) {
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles'); // lazy: cycle its search calls this goal
    const profiles = options.profiles || [];
    const excluded = options.excludedSpotIds || new Set();
    const current = options.currentSpot || null;
    const targetLevel = LevelingRoutes.targetLevelForState(state, options);
    const soloSearch = solo(state, options.mode);
    const starter = Spots.isProtectedStarterCohort(state);
    const currentMatch = current ? LevelingRoutes.scoreSpot(current, state, options) : null;
    // One reader per search: profiles and safety are read once.
    const homeAllowed = LevelingRoutes.spotAllowedReaderFor(state, options);
    const foreign = profile => LevelingRoutes.localityPenaltyForSpot(profile, state, { level: targetLevel },
        LevelingRoutes.tagsForSpot(profile)) > 0;
    const suitable = profile => SpotService.isSuitable(profile, targetLevel, options);
    // A starter field outside the bot's region asks for a move only when a field without that penalty can
    // take the bot: allowed, near its level. A kit that survives no home field yet (an orc mystic on fists
    // before its first spell) would otherwise be sent to another penalised field on every resolve and
    // never hunt. Checked only for the few young bots on foreign ground.
    const localityRelocate = current && currentMatch.localityPenalty > 0
        && Spots.spotsNearLevel(profiles, targetLevel).some(profile => profile.id !== current.id
            && !excluded.has(String(profile.id)) && !foreign(profile) && homeAllowed(profile));
    const mustRelocate = !!current && (localityRelocate
        || (current.raidBoss === true && !explicitClanRaidSpot(state, current))
        || currentMatch.targetMatchup?.eligible === false
        || currentMatch.huntingGround?.allowed === false
        || excluded.has(String(current.id)));
    const kept = () => LevelingRoutes.decorateSpot(current, currentMatch);
    const isCurrent = spot => !!current && spot?.id === current.id;
    if (current && !mustRelocate && (starter || suitable(current))) return kept();
    const withRoute = spot => LevelingRoutes.decorateSpot(spot, LevelingRoutes.routeMatchFor(spot, state, options));
    const list = options.list || invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').spotList(state);
    // The list's verdicts, one per spot for the whole search.
    const verdicts = new Map();
    const allowed = spot => {
        let passed = verdicts.get(spot);
        if (passed === undefined) verdicts.set(spot, passed = homeAllowed(spot));
        return passed;
    };
    // countHabit: the pick is the route's answer (BotRoute.choose); the list's `any` is counted only when taken.
    const ctx = { excluded, repelled: options.repelled || null, allowed: (candidate, spot) => allowed(spot), habit: soloSearch,
        mode: options.mode, count: options.countHabit === true };
    for (const shots of [true, false]) {
        const candidates = list.values(shots, targetLevel).map(row => ({ spot: SpotIndex.spotById(profiles, row.spotId), value: row.value }));
        const goal = fits => ({ candidates, sorted: true, value: candidate => candidate.value,
            fits: (candidate, spot) => !foreign(spot) && !(mustRelocate && isCurrent(spot)) && fits(spot) });
        const fitting = rank(state, goal(suitable), ctx).pick;
        if (fitting) { Diagnostics.count('spot_list', 'pick', 'suitable'); return withRoute(fitting.spot); }
        const listed = rank(state, goal(() => true), { ...ctx, count: false }), any = listed.pick;
        if (!any) continue;
        // Without a suitable camp a solo bot keeps its current one when the list holds it.
        if (soloSearch && current && !mustRelocate && !foreign(current)
            && candidates.some(candidate => isCurrent(candidate.spot)) && allowed(current)) {
            Diagnostics.count('spot_list', 'pick', 'current');
            return kept();
        }
        Diagnostics.count('spot_list', 'pick', 'allowed');
        if (ctx.count && any !== listed.best) noteHabit();
        return withRoute(any.spot);
    }
    // No allowed spot on the list (a catalogue spot the table does not rank, e.g. one without income): the
    // allowed ground near the level, a field of the bot's own region first, then the closest level.
    const candidates = Spots.spotsNearLevel(profiles, targetLevel)
        .filter(profile => !excluded.has(String(profile.id)) && allowed(profile));
    const relocation = mustRelocate ? candidates.filter(profile => profile.id !== current.id) : candidates;
    let routeCandidates = relocation.length ? relocation : candidates;
    let fitting = routeCandidates.filter(suitable);
    // Without a suitable camp a solo bot hunts allowed ground near its level: it keeps its current camp.
    if (soloSearch && !fitting.length && current && !mustRelocate && routeCandidates.some(profile => profile.id === current.id)) {
        Diagnostics.count('spot_list', 'pick', 'current');
        return kept();
    }
    // A weak kit can make every camp near the character's level unsafe. Search easier ground using the
    // same combat checks; otherwise a perfectly healthy bot repeats missing_spot forever.
    if (!routeCandidates.length && soloSearch) {
        const recoveryState = { ...state, stats: { ...state.stats, equipmentPlan: null } };
        const recoveryAllowed = LevelingRoutes.spotAllowedReaderFor(recoveryState, options);
        const easier = easierGround(state, { profiles, targetLevel, excluded, mode: options.mode, count: ctx.count,
            survives: invoke('GameServer/Bot/AI/BotTargetMatchup').soloSpotUpperBound(options.matchupProfiles),
            value: options.spotEconomics, allowed: recoveryAllowed });
        routeCandidates = easier ? [easier.spot] : [];
        fitting = [];
        Diagnostics.count('spot_list', 'pick', routeCandidates.length ? 'recovery' : 'none');
    } else {
        Diagnostics.count('spot_list', 'pick', routeCandidates.length ? 'near_level' : 'none');
    }
    const fallback = (fitting.length ? fitting : routeCandidates).sort((a, b) => {
        if (foreign(a) !== foreign(b)) return foreign(a) ? 1 : -1;
        const aGap = Math.abs(a.avgLevel - targetLevel), bGap = Math.abs(b.avgLevel - targetLevel);
        if (aGap !== bGap) return aGap - bGap;
        return b.density - a.density;
    })[0] || null;
    return fallback && withRoute(fallback);
}

module.exports = { rank, leveling, easierGround, explicitClanRaidSpot, HABIT_BAND };
