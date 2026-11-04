'use strict';
const ColdKillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');
const BotHuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const SpotEconomics = require('./SpotEconomics');
const Packet = require('./StatsPacket');
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

// The search's answer (the route or null) and the money weights it stands
// over (weightRange): { route, weights: { low, high, hour } }. The held
// earning spot (EconomyContext) searches again only when the weight leaves
// them. list: the search's spotList, when the caller reads it too.
function search(state, options) {
    return find(state, options, true);
}
function select(state, options) {
    return find(state, options, false).route;
}
// Every weight: an answer that does not read it.
const ALL_WEIGHTS = Object.freeze({ low: 0, high: 1, hour: null });
function find(state, { spots = [], timestamp = Date.now(), price, required = false, mode,
    maxChecks = 32, list = null } = {}, ranged) {
    const unweighed = { route: null, weights: ALL_WEIGHTS };
    if (!spots.length || state.party?.partyId || ['party', 'duo'].includes(mode)
        || !invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)) return unweighed;
    const minGap = -15;
    list ||= spotList(state, { price });
    const spoiler = list.spoiler();
    if (!required && !economicHunt(state) && !spoiler) return unweighed;
    const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const Index = invoke('GameServer/Bot/AI/SpotIndex');
    const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
    // Values in the role's best hour of the band, not the bot's own: an hour
    // read at the spot it stands on makes two spots each look better from the
    // other (own outputs are not inputs).
    const role = SpotValueTable.roleFor(state), bestIncome = SpotValueTable.best(role, state.level, true, 'income');
    const hour = { adena: (bestIncome?.adena || 0) + (bestIncome?.loot || 0), exp: SpotValueTable.best(role, state.level, true, 'exp')?.exp };
    const weight = SpotEconomics.moneyWeight(state);
    const evaluate = SpotEconomics.create(state, { timestamp, price, hour, moneyWeight: weight });
    const excluded = Risk.excludedSpotIdsForStates([state], timestamp);
    const options = { timestamp, mode: 'solo', matchupProfiles: Match.stateProfiles(state, { timestamp }) };
    const survives = Match.soloSpotUpperBound(options.matchupProfiles);
    const origin = Index.spotById(spots, state.spotId)?.center || state.loc;
    const ids = new Set([state.spotId, ...BotHuntEfficiency.sampledRows(state, timestamp).map(row => row.spotId)]);
    // Search-local: null rejects a spot; undefined awaits its first walk factor.
    const spotFactors = new Map();
    // Every spot the bot may earn at with this charge policy, each with its
    // score, positive or not (weightRange reads those below zero too).
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
    const pick = open.slice(0, checks).find(candidate => allowed(candidate.spot)) || null;
    if (pick) {
        pick.matchupProfiles = options.matchupProfiles;
        // The bot's hour (hourAdena, the unit of every value) stays what it could
        // earn: its best income among the spots it may hunt, wherever it levels.
        pick.earning = pick.row.income;
        for (const candidate of open.toSorted((a, b) => b.row.income - a.row.income).slice(0, checks)) {
            if (candidate.row.income <= pick.earning) break;
            if (allowed(candidate.spot)) { pick.earning = candidate.row.income; break; }
        }
    }
    if (!ranged) return { route: pick, weights: null };
    // Without the band's money hour the values count income in the packet's
    // own hour (SpotEconomics.create): that hour is an input beside the weight.
    const ownHour = hour.adena > 0 ? null : Number(Packet.hourAdena(state.stats?.money));
    return { route: pick, weights: { ...weightRange(weight, pool, open, pick, checks), hour: ownHour } };
}

// The money weights [low, high] around the search's own weight w0 over which
// it returns the same answer, all its other inputs held (decision links: the
// hold searches when an input moves enough to change the answer). The weight
// enters the search only through each candidate's score:
// SpotEconomics.create's valueHours = expHours·(1 − w) + incomeHours·w −
// riskHours, divided by a walk factor that does not read it, a line in w.
// Everything else the search reads of a candidate (its income, room, the
// ground and matchup verdict, the tie keys) does not read the weight. So the
// answer follows from comparisons of lines: a candidate's score against zero
// (the shortlist) and against another's (the order). The range keeps those
// comparisons the answer reads, each true over a half-line around w0:
// - a pick: it stays above zero and above every candidate below it (the
//   ones above are spots the matchup refused; dropping them only raises the
//   pick within maxChecks); every candidate paying more than it keeps its side
//   of zero, and those paying the same keep their order (its earning: the
//   best-paying allowed spot of the first maxChecks by income).
// - no pick: every candidate keeps its side of zero and, past maxChecks, the
//   first maxChecks (all refused) stay above the rest.
// Spots the room rule refused never enter; a spot whose room or verdict the
// search never asked counts as open and allowed (the range only narrows).
// Scores are float sums: each comparison keeps a margin of a few roundings of
// its terms (a comparison inside it holds only w0 itself), so a weight inside
// the range finds the same answer bit for bit.
function weightRange(weight, pool, open, pick, checks) {
    let low = 0, high = 1;
    const lines = new Map();
    const line = candidate => {
        let out = lines.get(candidate);
        if (!out) {
            const { expHours: exp, incomeHours: income, riskHours: risk } = candidate.row, f = candidate.walkFactor;
            out = { a: (exp - risk) / f, b: (income - exp) / f,
                e: 8 * Number.EPSILON * (Math.abs(exp) + Math.abs(income) + Math.abs(risk)) / f };
            if (!Number.isFinite(out.a) || !Number.isFinite(out.b) || !Number.isFinite(out.e)) out = null;
            lines.set(candidate, out);
        }
        return out;
    };
    // a + b·w stays above 2e: a half-line around w0, or only w0 inside the margin.
    const keep = (a, b, e) => {
        if (!(a + b * weight > 2 * e)) { low = high = weight; return; }
        if (b > 0) low = Math.max(low, (2 * e - a) / b);
        else if (b < 0) high = Math.min(high, (2 * e - a) / b);
    };
    const side = candidate => {
        const l = line(candidate);
        if (!l) { low = high = weight; return; }
        if (candidate.score > 0) keep(l.a, l.b, l.e);
        else keep(-l.a, -l.b, l.e);
    };
    const above = (upper, lower) => {
        const u = line(upper), d = line(lower);
        if (!u || !d) { low = high = weight; return; }
        keep(u.a - d.a, u.b - d.b, u.e + d.e);
    };
    const entering = pool.filter(candidate => !candidate.closed);
    if (pick) {
        const rank = new Map(open.map((candidate, at) => [candidate, at])), ties = new Map();
        side(pick);
        for (const candidate of entering) {
            if (candidate === pick || low === high) continue;
            if (!(rank.get(candidate) < rank.get(pick))) above(pick, candidate);
            if (candidate.row.income <= pick.row.income) continue;
            side(candidate);
            if (!(candidate.score > 0)) continue;
            let tied = ties.get(candidate.row.income);
            if (!tied) ties.set(candidate.row.income, tied = []);
            tied.push(candidate);
        }
        for (const tied of ties.values()) for (let i = 1; i < tied.length; i++) {
            for (let j = 0; j < i; j++) {
                const [first, second] = rank.get(tied[j]) < rank.get(tied[i]) ? [tied[j], tied[i]] : [tied[i], tied[j]];
                above(first, second);
            }
        }
    } else {
        for (const candidate of entering) if (low < high) side(candidate);
        for (let i = 0; i < Math.min(checks, open.length) && low < high; i++) {
            for (let j = checks; j < open.length && low < high; j++) above(open[i], open[j]);
        }
    }
    return { low: Math.min(low, weight), high: Math.max(high, weight) };
}

module.exports = { select, search, economicHunt, spotList };
