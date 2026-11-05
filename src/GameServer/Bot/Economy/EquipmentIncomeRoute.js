'use strict';
const ColdKillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');
const BotHuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const SpotEconomics = require('./SpotEconomics');
const Packet = require('./StatsPacket');
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
// spot closest to level; cuts: takes the ranking's cut, for the prices the
// same ids stand over (SpotValueTable.rankedSpotIds, cutStands).
function spotList(state, { price } = {}) {
    let spoiler, costs = null;
    const spoilerOf = () => spoiler !== undefined ? spoiler
        : (spoiler = ColdKillRewards.spoilerFor(state, { skills: ColdCombatProfile.skillsFor(state) }) || null);
    return { spoiler: spoilerOf, ids: (shots, level = state.level, minGap = -7, cuts = null) => SpotValueTable.rankedSpotIds(
        SpotValueTable.roleFor(state), level,
        costs ||= BotHuntEfficiency.consumablePrices(state, price), minGap, shots,
        { spoilSkillLevel: spoilerOf()?.skillLevel || 0 }, cuts) };
}

// The search's answer (the route or null), the money weights it stands over
// (lineRange) and what else it stands on (standsOf: its prices, a range of
// frustration, its crowd key): { route, weights: { low, high, hour },
// stands }. The held earning spot (EconomyContext) searches again only when
// one of them moves (standsMoved). list: the search's spotList, when the
// caller reads it too.
function search(state, options) {
    return find(state, options, true);
}
function select(state, options) {
    return find(state, options, false).route;
}
// Every weight: an answer that does not read it.
const ALL_WEIGHTS = Object.freeze({ low: 0, high: 1, hour: null });
// The solo matchup the search reads (find; the crowd key's replay asks a
// spot's verdict through the same reader, Routes.spotAllowedReaderFor).
function matchupOptions(state, timestamp) {
    return { timestamp, mode: 'solo', matchupProfiles: invoke('GameServer/Bot/AI/BotTargetMatchup').stateProfiles(state, { timestamp }) };
}
// The search's spot values (find, liveRoute): SpotEconomics' reader in the
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
    const { hour, weight, evaluate } = valuesFor(state, timestamp, price);
    const excluded = Risk.excludedSpotIdsForStates([state], timestamp);
    const options = matchupOptions(state, timestamp);
    const survives = Match.soloSpotUpperBound(options.matchupProfiles);
    const origin = Index.spotById(spots, state.spotId)?.center || state.loc;
    const sampled = BotHuntEfficiency.sampledRows(state, timestamp).map(row => row.spotId);
    const ids = new Set([state.spotId, ...sampled]);
    // The band's spots (arrival: the bot's own spot stays a candidate after it
    // leaves only if the band or its samples name it).
    const listed = ranged ? new Set(sampled.map(String)) : null;
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
    // The band's cuts the candidates came from (priceStands: the prices they
    // stand over) and the spots it scored that earn nothing at the prices read
    // (their costs pass their income).
    const cuts = ranged ? [] : null, unpooled = [];
    // A spot whose place in a cut moves the candidates: not one anyway (the
    // bot's own spot or a sampled one), and admitted, as far as known without
    // asking more (a spot the search never asked: what its catalog entry
    // tells, the rest counted as admitted).
    const always = new Set(ids), counted = new Map();
    const admittedKnown = spot => !spot ? false : spotFactors.has(spot) ? spotFactors.get(spot) !== null
        : !spot.raidBoss && Number(spot.avgLevel || spot.minLevel || 1) - state.level >= minGap && !excluded.has(String(spot.id));
    const matters = id => {
        let known = counted.get(id);
        if (known !== undefined) return known;
        known = admittedKnown(always.has(id) ? null : Index.spotById(spots, id));
        counted.set(id, known);
        return known;
    };
    // Every spot the bot may earn at with this charge policy, each with its
    // score, positive or not (lineRange and the crowd key read those below zero too).
    const candidates = shots => {
        // costs are the bot's own price beliefs: the id view, not the shared shortlist rows.
        for (const spotId of list.ids(shots, state.level, minGap, cuts)) { ids.add(spotId); listed?.add(String(spotId)); }
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
            }).filter(row => {
                if (row.row?.income > 0) return true;
                // A cheaper consumable could lift it into the pool.
                if (ranged && row.row && row.row.shotUnits + row.row.potionUnits > 0) unpooled.push(row);
                return false;
            });
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
    // Each spot's verdict, asked once: the crowd key keeps the ones asked.
    const verdicts = new Map();
    const asked = spot => {
        let verdict = verdicts.get(spot);
        if (verdict === undefined) verdicts.set(spot, verdict = !!allowed(spot));
        return verdict;
    };
    const pick = open.slice(0, checks).find(candidate => asked(candidate.spot)) || null;
    let earner = null;
    if (pick) {
        pick.matchupProfiles = options.matchupProfiles;
        // The bot's hour (hourAdena, the unit of every value) stays what it could
        // earn: its best income among the spots it may hunt, wherever it levels.
        pick.earning = pick.row.income;
        for (const candidate of open.toSorted((a, b) => b.row.income - a.row.income).slice(0, checks)) {
            if (candidate.row.income <= pick.earning) break;
            if (asked(candidate.spot)) { pick.earning = candidate.row.income; earner = candidate; break; }
        }
    }
    if (!ranged) return { route: pick, weights: null };
    // Without the band's money hour the values count income in the packet's
    // own hour (SpotEconomics.create): that hour is an input beside the weight.
    const ownHour = hour.adena > 0 ? null : Number(Packet.hourAdena(state.stats?.money));
    const weights = { ...lineRange(weight, 0, 1, pool, open, pick, checks, weightLine), hour: ownHour };
    // The bot's arrival at the pick, its own output, moves only the origin of
    // every walk (to the pick's center, its own walk 1) and which spot is its
    // own (the room's exception; the spot it left stays a candidate only if
    // listed): the crowd key replays the answer from there too (crowdKey).
    const here = String(state.spotId);
    const arrival = pick && pick.spot.center && String(pick.spot.id) !== here
        ? arrivalAt(state, pick, timestamp, hour, evaluate, {
            walkOf: spot => 1 + WalkBack.tripHours(pick.spot.center, spot, state, spots) / 0.5,
            away: state.spotId != null && !listed.has(here) ? here : null,
            // From the pick the spot it left is a candidate only through the band's cut (unless sampled): its place there counts.
            matters: id => String(id) === here && !sampled.some(spotId => String(spotId) === here)
                ? admittedKnown(Index.spotById(spots, id)) : matters(id) }) : null;
    const stands = standsOf(state, { pool, shortlist, pick, earner, checks, verdicts, weight, weights,
        open, unpooled, cuts, matters, hour: evaluate.moneyHour, costs: BotHuntEfficiency.consumablePrices(state, price), arrival });
    // The inputs the route's numbers (its row, its earning) were read at (liveRoute).
    if (pick && stands.crowd) pick.live = liveInputs(stands.crowd, state, stands.crowd.earner, stands.prices);
    return { route: pick, weights, stands };
}

// The arrival (find): what moves when the bot stands on the pick, its own
// output. Beside the walks and its own spot, the death hours: the bot's hunt
// and its walk back read the spot it stands on (SpotEconomics.deathHoursOf,
// one factor on every row's riskHours, as frustration's k: the replay reads
// k times their ratio). Without the band's hours the rows' own hour reads the
// hunt too: the arrival searches. Cost: one hunt and death hours at the pick.
function arrivalAt(state, pick, timestamp, hour, evaluate, arrival) {
    if (!(hour.adena > 0 && hour.exp > 0)) return null;
    const there = SpotEconomics.deathHoursOf({ ...state, spotId: pick.spot.id }, undefined, timestamp);
    const death = evaluate.deathHours > 0 ? there / evaluate.deathHours : there === 0 ? 1 : NaN;
    return Number.isFinite(death) ? { ...arrival, death } : null;
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
// (the shortlist) and against another's (the order). lineRange keeps those
// comparisons the answer reads, each true over a half-line around w0.
const weightLine = candidate => {
    const { expHours: exp, incomeHours: income, riskHours: risk } = candidate.row, f = candidate.walkFactor;
    return { a: (exp - risk) / f, b: (income - exp) / f, e: 8 * Number.EPSILON * (Math.abs(exp) + Math.abs(income) + Math.abs(risk)) / f };
};
// The bot's frustration enters each score as a line too: riskHours = deaths ×
// deathHours × riskWeight, riskWeight ∝ 1 + frustration
// (EconomicValuation.riskWeight), so in k = (1 + frustration) / (1 + its value
// at the search) the score is (expHours·(1 − w0) + incomeHours·w0)/walk −
// k·riskHours/walk, and nothing else the search reads moves with it.
const riskLine = weight => candidate => {
    const { expHours: exp, incomeHours: income, riskHours: risk } = candidate.row, f = candidate.walkFactor;
    return { a: (exp * (1 - weight) + income * weight) / f, b: -risk / f,
        e: 8 * Number.EPSILON * (Math.abs(exp) + Math.abs(income) + Math.abs(risk)) / f };
};
const riskFactor = (state, base) => (1 + Math.max(0, Number(state.stats?.frustration) || 0)) / (1 + base);

// The range [low, high] (inside [lo, hi]) of one input x around its value x0
// over which the search answers the same, all its other inputs held, for an
// input every score is a line in (lineOf(candidate): score = a + b·x, e: a
// few roundings of its terms). The comparisons the answer reads:
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
// its terms (a comparison inside it holds only x0 itself), so an x inside
// the range finds the same answer bit for bit.
function lineRange(x0, lo, hi, pool, open, pick, checks, lineOf) {
    let low = lo, high = hi;
    const lines = new Map();
    const line = candidate => {
        let out = lines.get(candidate);
        if (!out) {
            out = lineOf(candidate);
            if (!Number.isFinite(out.a) || !Number.isFinite(out.b) || !Number.isFinite(out.e)) out = null;
            lines.set(candidate, out);
        }
        return out;
    };
    // a + b·x stays above 2e: a half-line around x0, or only x0 inside the margin.
    const keep = (a, b, e) => {
        if (!(a + b * x0 > 2 * e)) { low = high = x0; return; }
        if (b > 0) low = Math.max(low, (2 * e - a) / b);
        else if (b < 0) high = Math.min(high, (2 * e - a) / b);
    };
    const side = candidate => {
        const l = line(candidate);
        if (!l) { low = high = x0; return; }
        if (candidate.score > 0) keep(l.a, l.b, l.e);
        else keep(-l.a, -l.b, l.e);
    };
    const above = (upper, lower) => {
        const u = line(upper), d = line(lower);
        if (!u || !d) { low = high = x0; return; }
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
    return { low: Math.min(low, x0), high: Math.max(high, x0) };
}

// What the answer stands on beside its inputs' versions and the money weights
// (decision links step 3; EconomyContext.incomeMoved reads it, standsMoved):
// - prices: the shot and potion prices it read and the range of each (the
//   other as read) the answer is replayed over (priceStands).
// - risk: the range of k (riskLine) it answers the same over (base: the
//   frustration at the search).
// - crowd: the crowd key (crowdKey), replayed at the crowd and prices now.
function standsOf(state, { pool, shortlist, pick, earner, checks, verdicts, weight, weights, open, unpooled, cuts, matters, hour, costs, arrival }) {
    const base = Math.max(0, Number(state.stats?.frustration) || 0);
    // k from no frustration up (from the pick: times its death hours' ratio, crowdKey's arrival).
    const risk = { base, ...lineRange(1, Math.min(1, arrival?.death ?? 1) / (1 + base), Infinity, pool, open, pick, checks, riskLine(weight)) };
    const prices = priceStands({ pool, open, pick, checks, weight, unpooled, cuts, matters, hour, costs, arrival });
    return { prices, risk,
        crowd: crowdKey(state, { pool, shortlist, pick, earner, checks, verdicts, weight, weights, risk, prices, hour, arrival }) };
}
// The input of the answer's stands that moved since its search: 'prices'
// outside their ranges (a reader with no prices of its own, price null,
// leaves them to the hold's owner), 'frustration' outside its range, else
// what the crowd key's replay at the crowd and prices now finds moved
// (crowdStands: 'crowd' or 'prices'); '' when the pick stands (its earner
// and numbers: liveRoute). weight: the money weight now (inside the answer's
// weights: the caller checked them).
function standsMoved(stands, state, weight, price, timestamp = Date.now()) {
    return standsRead(stands, state, weight, price, timestamp).moved;
}
// standsMoved's read with what it found: { moved, earner (the key's model
// that sets the earning now, -1: the pick's own), costs (the prices it
// read: as read where the reader has none) }. timestamp: the read's (a
// matchup verdict the replay asks).
function standsRead(stands, state, weight, price, timestamp = Date.now()) {
    if (!stands) return { moved: '', earner: -1, costs: null };
    // From the pick: its own price ranges and the death hours there (crowdKey's arrival).
    const there = arrived(stands, state), ranges = there ? stands.prices.arrival : stands.prices;
    let move = null, costs = stands.prices;
    if (price !== null) {
        costs = BotHuntEfficiency.consumablePrices(state, price);
        const shots = costs.shots - stands.prices.shots, potions = costs.potions - stands.prices.potions;
        if (shots || potions) {
            if (!pricesInside(ranges, shots, potions)) return { moved: 'prices', earner: -1, costs };
            move = { shots, potions };
        }
    }
    const k = riskFactor(state, stands.risk.base) * (there ? stands.crowd.death : 1);
    if (!(k >= stands.risk.low && k <= stands.risk.high)) return { moved: 'frustration', earner: -1, costs };
    const replayed = crowdStands(stands.crowd, state, weight, k, move, timestamp, there);
    return { moved: replayed.moved, earner: replayed.earner, costs };
}
// The bot stands where the crowd key replays its answer from the pick's own
// spot (its arrival: crowdKey), not where it searched: its spot moved only
// by its own arrival (EconomyContext.incomeMoved keeps the spot's version).
function arrived(stands, state) {
    const key = stands?.crowd;
    return !!key?.arrival && !!stands.prices.arrival && String(state.spotId) === key.arrival && key.arrival !== key.origin;
}

// The consumable prices. A table row's costs are its shots and potions an
// hour at their prices (SpotEconomics: shotUnits, potionUnits; an own
// observed row's are its samples'), so its income (row.income: what the
// earning reads and the pool's cut, income > 0) is a line in each price, and
// its score one too: valueHours' incomeHours · w over the walk factor, the
// income counted in the hour moneyHour (the band's, or the packet's: no
// price). Nothing else the search reads of a scored spot moves with them; one
// read beside them does: the band's first 64 (SpotValueTable.rankedSpotIds)
// cut which spots it scores at all. The answer at prices s, p is replayed
// over the crowd key's candidates (crowdStands), exactly as the search would
// compare them, wherever those candidates are all the search would score:
// - the cut keeps its place for every spot whose place moves the candidates
//   (cutStands over `matters`), and the scored spots that earn nothing stay
//   at or below zero (unpooled);
// - and, to keep the key small, the pick stays the leader: above zero income
//   and its score where the search put it against every candidate (lineRange
//   over the scores' lines in that price). Past it the answer most likely
//   moves: a search.
// Each is a comparison linear in both prices at once, so they all hold in
// the hull of the two ranges each price has with the other as read
// (pricesInside: the diamond of their four ends), and the crowd key keeps
// every candidate that could change the answer anywhere in it. A read
// outside the hull searches. Cost per search: two line ranges over the pool,
// the cuts' (O(n) each, n: the band's spots) and the key's corners.
function priceStands({ pool, open, pick, checks, weight, unpooled, cuts, matters, hour, costs, arrival = null }) {
    const ranges = {};
    for (const [name, units] of [['shots', row => row.shotUnits], ['potions', row => row.potionUnits]]) {
        const x0 = costs[name];
        let { low, high } = lineRange(x0, 0, Infinity, pool, open, pick, checks, priceLine(units, weight, hour, x0));
        // An income on its side of zero, with the roundings of its terms at the price it reaches.
        const keep = (row, side) => {
            [low, high] = SpotValueTable.keepAbove(x0, low, high, side * row.income, -side * units(row),
                8 * Number.EPSILON * (Math.abs(row.adena) + Math.abs(row.loot) + Math.abs(row.costs)), 8 * Number.EPSILON * units(row));
        };
        for (const { row } of unpooled) if (low < high) keep(row, -1);
        if (pick && low < high) keep(pick.row, 1);
        ranges[name] = [Math.min(low, x0), Math.max(high, x0)];
    }
    // The cuts inside these ranges (the walk of their envelopes stops at the
    // ends), ranked at the same prices (spotList's, the same price reader: a
    // memoized reader answers both reads alike; a caller's list read at other
    // prices leaves only the prices read).
    const ranked = !cuts.some(cut => cut.costs.shots !== costs.shots || cut.costs.potions !== costs.potions);
    if (!ranked) { ranges.shots = [costs.shots, costs.shots]; ranges.potions = [costs.potions, costs.potions]; }
    else SpotValueTable.cutStands(cuts, matters, ranges);
    // Diagnostics: a price whose range is the price read alone (any move of it searches), by what closed it.
    if (Diagnostics.active()) for (const name of ['shots', 'potions']) {
        if (ranges[name][0] === ranges[name][1]) Diagnostics.count('income_prices', 'point', ranked ? name : 'cut_prices');
    }
    // From the pick (arrival): inside these, the cut also keeps the place of the spot the bot left.
    let from = null;
    if (arrival && ranked) {
        from = { shots: [...ranges.shots], potions: [...ranges.potions] };
        SpotValueTable.cutStands(cuts, arrival.matters, from);
    }
    return { shots: costs.shots, potions: costs.potions, shotsRange: ranges.shots, potionsRange: ranges.potions,
        arrival: from && { shots: costs.shots, potions: costs.potions, shotsRange: from.shots, potionsRange: from.potions } };
}
// A candidate's score as a line in one price (units: its row's units of it).
const priceLine = (units, weight, hour, x0) => candidate => {
    const row = candidate.row, f = candidate.walkFactor, b = -weight * units(row) / (hour * f);
    return { a: candidate.score - b * x0, b,
        e: 8 * Number.EPSILON * (Math.abs(row.expHours) + Math.abs(row.incomeHours) + Math.abs(row.riskHours) + Math.abs(b * x0 * f)) / f };
};
// A move of the prices (shots, potions: from the ones read) inside the hull
// of their ranges.
function pricesInside(prices, shots, potions) {
    const part = (d, x0, [low, high]) => d === 0 ? 0 : Math.abs(d) / Math.abs((d > 0 ? high : low) - x0);
    return part(shots, prices.shots, prices.shotsRange) + part(potions, prices.potions, prices.potionsRange) <= 1;
}

// The crowd key. The hunters on a spot (SpotProfiles.spotHunters: this
// thread's occupancy, the bot among them) move the answer through two reads
// of each candidate: its room (SpotProfiles.roomAt) and, where its hunters
// share the spawns' production, its row (SpotEconomics' row.crowd:
// huntShare(production, hunters, kills) multiplies a table row's every hour
// field, an observed row's deaths). So a candidate's score at a weight w, a
// risk factor k and h hunters is
//   (σ·(expHours·(1 − w) + incomeHours·w) − τ·k·riskHours) / walk
// and its income σ·income, with σ, τ = ρ where the share moves that part, else
// 1, and ρ = huntShare(h) / huntShare(the search's h): at the search's values
// the search's own numbers, bit for bit. The prices move a candidate's income
// by its units' cost (priceStands): its score by w · that over its money
// hour and walk, both under σ. The key keeps every candidate that could
// change the answer anywhere in the box of the weight range × the risk range
// × the prices' hull × any crowd, the pick's own hunters at most `most` (the
// count past which, all else as searched, the pick moves): those ranked
// above the pick, those whose score could pass the pick's somewhere in the
// box, those that could pay more than the pick somewhere (any of them may
// set the earning: the replay finds the one that does now, judge), and with
// no pick every one that could score above zero. Each is multilinear in
// the weight, ρ and either price, so its extremes lie at the box's corners
// (the hull's four ends, a price each). Outside the box the weight,
// frustration or prices moved (searched by their ranges) or the pick's crowd
// passed `most`. A read replays the answer's comparisons over them at the
// counts and prices it reads (crowdStands). Comparisons inside a few roundings
// of their terms stand only while nothing moved.
// The bot's arrival at the pick (its own output) moves the walks (each
// candidate's from the pick's center: walkAt, the pick's 1), which spot is
// its own (the spot it left, `away` where only being its own made it a
// candidate) and the death hours (key.death: their ratio, read with k;
// arrivalAt). The key replays from there too (key.arrival: the pick's id)
// where every candidate it dropped stays dropped: a score s = v / walk moves
// to v / walkAt and the pick's to s·walk, so one that could not pass the pick
// anywhere in the box still cannot where walk ≤ the pick's walk × walkAt (a
// spot whose way from the pick shrank more than the pick's own: next to it,
// where the bot came by town); else the arrival searches.
const MOVED = 0, STANDS = 1, UNSURE = 2;
function modelOf(candidate, at, state, verdicts, Spots) {
    const row = candidate.row, share = row.crowd || null, hunters = Spots.spotHunters(candidate.spot, state);
    const model = { spot: candidate.spot, shots: row.useShots, at, own: String(candidate.spot.id) === String(state.spotId),
        exp: row.expHours, income: row.incomeHours, risk: row.riskHours, walk: candidate.walkFactor, walkAt: 0, away: false, gain: row.income,
        shotUnits: row.shotUnits, potionUnits: row.potionUnits, costs: row.costs,
        share, hunters, phi0: share ? SpotValueTable.huntShare(share.production, Math.max(1, hunters), share.kills) : 1,
        verdict: verdicts.get(candidate.spot) };
    // A row with no finite value never scores above zero (select's `|| 0`).
    return [model.exp, model.income, model.risk, model.walk, model.gain, model.phi0, model.shotUnits, model.potionUnits, model.costs]
        .every(Number.isFinite) && model.phi0 > 0 ? model : null;
}
// ρ at h hunters (0 for none known: any crowd).
const shareAt = (model, hunters) => model.share
    ? SpotValueTable.huntShare(model.share.production, Math.max(1, hunters), model.share.kills) / model.phi0 : 1;
// A model's score, income and room at a weight, risk factor and ρ, with
// the margins of its comparisons; move: the prices' move from the ones read
// ({ shots, potions }, null: as read) and the money hour of its scores; a
// moved price's margins count the row's costs at it (a fresh search rounds
// its income from them). pool: whether it earns above zero (the search's
// pool; as read: it does). walk: its walk from where the bot stands.
function valueOf(model, weight, k, rho, open, move = null, hour = 1, walk = model.walk) {
    const sigma = model.share?.value ? rho : 1, tau = model.share ? rho : 1;
    const spend = move ? model.shotUnits * move.shots + model.potionUnits * move.potions : 0;
    const costs = move ? Math.abs(model.costs) + Math.abs(spend) : 0;
    const income = move ? model.income - spend / hour : model.income;
    const lift = model.exp * (1 - weight) + income * weight, cost = model.risk * k;
    const gain = sigma * (move ? model.gain - spend : model.gain);
    const tolGain = 16 * Number.EPSILON * (Math.abs(gain) + sigma * costs);
    return { model, open, moved: !!move, s: (sigma * lift - tau * cost) / walk, gain,
        tol: 16 * Number.EPSILON * (Math.abs(model.exp) + Math.abs(income) + costs / hour + Math.abs(cost)) * Math.max(1, sigma, tau) / walk,
        tolGain, pool: move ? (gain > tolGain ? 1 : gain < -tolGain ? -1 : 0) : 1 };
}
// The answer the search reads from these values: { verdict, earner }, the
// verdict STANDS (the same pick), MOVED, or UNSURE (a comparison inside its
// margin, or a matchup verdict the search never asked where it decides);
// earner: where the pick stands, the value that sets its earning (its index,
// -1: none, the pick's own). values: valueOf per candidate (open false: no
// candidate now); pick: its value (null: none); ask(spot): the matchup's
// verdict on a spot the search never asked, where it decides (null: unsure
// there; asked at the read, for this judgement only: a read's moment is not
// the key's); earning: false judges the pick alone.
function judge(values, pick, checks, ask = null, earning = true) {
    let unsure = false;
    const asked = new Map();
    // The verdict known so far (undefined: never asked), and asked where it decides.
    const known = x => x.model.verdict !== undefined ? x.model.verdict : asked.get(x);
    const verdictOf = x => {
        if (known(x) === undefined && ask) asked.set(x, !!ask(x.model.spot));
        return known(x);
    };
    const out = verdict => ({ verdict, earner: -1 });
    const sign = (d, t) => d > t ? 1 : d < -t ? -1 : 0;
    // On the shortlist: a score above zero, in the pool.
    const positive = v => Math.min(sign(v.s, v.tol), v.pool);
    // Two policies of one spot with the same row stay tied: the search's order
    // (the pool's); at moved prices, with the same units too.
    const twins = (x, y) => x.model.spot === y.model.spot && x.model.exp === y.model.exp && x.model.income === y.model.income
        && x.model.risk === y.model.risk && x.model.walk === y.model.walk && x.model.gain === y.model.gain
        && (!x.moved || x.model.shotUnits === y.model.shotUnits && x.model.potionUnits === y.model.potionUnits);
    const before = (x, y) => sign(x.s - y.s, x.tol + y.tol) || (twins(x, y) ? (x.model.at < y.model.at ? 1 : -1) : 0);
    const richer = (x, y) => sign(x.gain - y.gain, x.tolGain + y.tolGain) || (twins(x, y) ? before(x, y) : 0);
    // In the first `checks` of `order` (before: the order's comparison) among the open candidates above zero.
    const within = (x, order) => {
        let ahead = 0, maybe = 0;
        for (const y of values) {
            if (y === x || !y.open || positive(y) === -1) continue;
            const b = order(y, x);
            if (b === 1 && positive(y) === 1) ahead++;
            else if (b !== -1) maybe++;
        }
        return ahead >= checks ? -1 : ahead + maybe >= checks ? 0 : 1;
    };
    const note = verdict => { if (verdict === 0) unsure = true; return verdict; };
    if (!pick) {
        for (const x of values) {
            if (x.model.verdict === false || !x.open || positive(x) === -1) continue;
            const reached = within(x, before);
            if (reached === 1 && positive(x) === 1) return out(MOVED);
            if (reached !== -1) unsure = true;
        }
        return out(unsure ? UNSURE : STANDS);
    }
    if (!pick.open || note(positive(pick)) === -1) return out(MOVED);
    // No candidate the matchup may allow comes before the pick, and the pick
    // stays within the first `checks`.
    for (const x of values) {
        if (x === pick || x.model.verdict === false || !x.open || positive(x) === -1) continue;
        const b = before(x, pick);
        if (b === -1 || verdictOf(x) === false) continue;
        if (b === 1 && positive(x) === 1) return out(MOVED);
        unsure = true;
    }
    if (note(within(pick, before)) === -1) return out(MOVED);
    if (unsure) return out(UNSURE);
    if (!earning) return out(STANDS);
    // The earning: the first allowed of the first `checks` by income (the
    // open spots above zero) paying more than the pick; none: the pick's own.
    // The first one paying more that the matchup does not refuse, sharply
    // ahead of every other one it does not refuse, within the first `checks`.
    let earner;
    do {
        earner = null;
        for (const x of values) {
            if (x === pick || !x.open || known(x) === false) continue;
            const p = positive(x);
            if (p === -1) continue;
            const b = richer(x, pick);
            if (b === -1) continue;
            if (b === 0 || p === 0) return out(UNSURE);
            if (!earner || x.gain > earner.gain) earner = x;
        }
    } while (earner && verdictOf(earner) === false);
    if (!earner) return { verdict: STANDS, earner: -1 };
    if (known(earner) !== true) return out(UNSURE);
    for (const y of values) {
        if (y === earner || y === pick || !y.open || known(y) === false || positive(y) === -1) continue;
        if (richer(y, pick) !== -1 && richer(earner, y) !== 1) return out(UNSURE);
    }
    const reached = within(earner, richer);
    if (reached === 0) return out(UNSURE);
    return { verdict: STANDS, earner: reached === 1 ? values.indexOf(earner) : -1 };
}
function crowdKey(state, { pool, shortlist, pick, earner, checks, verdicts, weight, weights, risk, prices, hour, arrival }) {
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles'); // lazy: cycle, as select's
    const byCandidate = new Map();
    for (let at = 0; at < pool.length; at++) {
        const model = modelOf(pool[at], at, state, verdicts, Spots);
        if (model) byCandidate.set(pool[at], model);
    }
    const models = [...byCandidate.values()];
    const here = model => valueOf(model, weight, 1, 1, Spots.roomAt(model.spot, state, model.hunters));
    const values = models.map(here);
    const pickModel = pick ? byCandidate.get(pick) : null, earnerModel = earner ? byCandidate.get(earner) : null;
    // Unreachable: a pick scores above zero, so its row is finite.
    if (pick && !pickModel) return null;
    // The pick's own hunters past which, all else as searched, the pick
    // moves: its room (another spot's), else, where its value follows its
    // share, where its score falls below what it must stay above (the pick
    // moves at most once as the count grows: found by halving, up to 64 more
    // on its own spot, none past that).
    let most = Infinity;
    if (pickModel) {
        const room = invoke('GameServer/Bot/AI/LevelingRoutes').roomForSpot(pickModel.spot);
        const last = pickModel.own ? Infinity : Math.max(pickModel.hunters, room);
        // An observed row's deaths fall with its hunters and its income stays: it only gains.
        if (!pickModel.share?.value) most = last;
        else {
            const at = models.indexOf(pickModel), pickValue = values[at];
            const cap = pickModel.own ? pickModel.hunters + 64 : last;
            const stands = h => {
                values[at] = valueOf(pickModel, weight, 1, shareAt(pickModel, h), Spots.roomAt(pickModel.spot, state, h));
                return judge(values, values[at], checks, null, false).verdict === STANDS;
            };
            let lo = pickModel.hunters, hi = cap;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (stands(mid)) lo = mid; else hi = mid - 1;
            }
            most = pickModel.own && lo === cap ? Infinity : lo;
            if (most === Infinity && Diagnostics.active()) Diagnostics.count('income_crowd', 'unbounded', 'own_spot');
            values[at] = pickValue;
        }
    }
    // The box: each model's ρ range (the pick's to its `most`, any other's to
    // any crowd), the weight and risk ranges and the prices' hull (its four
    // ends, each a move of one price from the read one: shots, potions, the
    // moves to their range's ends, possibly infinite).
    const ws = [weights.low, weights.high], kl = risk.low, kh = risk.high;
    const S = { lo: prices.shotsRange[0] - prices.shots, hi: prices.shotsRange[1] - prices.shots };
    const P = { lo: prices.potionsRange[0] - prices.potions, hi: prices.potionsRange[1] - prices.potions };
    // The most a line's slope b in one price adds over that price's moves (the read price adds none).
    const reach = (b, move) => b === 0 ? 0 : Math.max(0, b * move.lo, b * move.hi);
    // Over the hull's ends a value a with slopes bs, bp in the shot and potion prices reaches at most:
    const most4 = (a, bs, bp) => a + Math.max(reach(bs, S), reach(bp, P));
    const rhos = model => !model.share ? [1, 1]
        : model === pickModel ? [shareAt(model, most), shareAt(model, 1)] : [0, shareAt(model, 1)];
    const scale = model => (Math.abs(model.exp) + Math.abs(model.income) + Math.abs(model.risk) * Math.max(1, kl))
        * Math.max(1, rhos(model)[1]) / model.walk;
    // A model's lift at the prices read and its slope per unit of a price (its units' cost in its hour, over its walk).
    const sigma = (model, rho) => model.share?.value ? rho : 1;
    const lift = (model, w, rho) => sigma(model, rho) * (model.exp * (1 - w) + model.income * w) / model.walk;
    const perHour = (model, units) => units / (hour * model.walk);
    const cost = (model, rho) => (model.share ? rho : 1) * model.risk / model.walk;
    // The best score a model reaches in the box (its cost least at kl).
    const best = model => {
        let top = -Infinity;
        for (const w of ws) for (const rho of rhos(model)) {
            const f = -sigma(model, rho) * w;
            top = Math.max(top, most4(lift(model, w, rho) - cost(model, rho) * kl,
                f * perHour(model, model.shotUnits), f * perHour(model, model.potionUnits)));
        }
        return top;
    };
    // The most a model's score can pass the pick's by in the box: at each corner
    // of weight, ρs and prices the difference is a line in k.
    const passes = model => {
        let top = -Infinity;
        for (const w of ws) for (const rx of rhos(model)) for (const rp of rhos(pickModel)) {
            const fx = -sigma(model, rx) * w, fp = -sigma(pickModel, rp) * w;
            const a = most4(lift(model, w, rx) - lift(pickModel, w, rp),
                fx * perHour(model, model.shotUnits) - fp * perHour(pickModel, pickModel.shotUnits),
                fx * perHour(model, model.potionUnits) - fp * perHour(pickModel, pickModel.potionUnits));
            const b = cost(pickModel, rp) - cost(model, rx);
            top = Math.max(top, b > 0 ? (kh === Infinity ? Infinity : a + b * kh) : a + b * kl);
        }
        return top;
    };
    // The most a model can pay above the pick in the box.
    const richer = (model, other) => {
        let top = -Infinity;
        for (const rx of rhos(model)) for (const ro of rhos(other)) {
            const sx = sigma(model, rx), so = sigma(other, ro);
            top = Math.max(top, most4(sx * model.gain - so * other.gain,
                so * other.shotUnits - sx * model.shotUnits, so * other.potionUnits - sx * model.potionUnits));
        }
        return top;
    };
    const margin = model => 1e-9 * (scale(model) + (pickModel ? scale(pickModel) : 0));
    const above = new Set(pick ? shortlist.slice(0, shortlist.indexOf(pick)) : []);
    const leastGain = pickModel ? sigma(pickModel, rhos(pickModel)[0]) * pickModel.gain : 0;
    // Dropped: a model that never scores above zero in the box (none that
    // could, else), or one that can neither pass the pick nor pay more than it.
    const never = model => best(model) <= -margin(model);
    const kept = models.filter(model => {
        if (model === pickModel || model === earnerModel) return true;
        if (never(model)) return false;
        if (!pickModel) return true;
        return above.has(pool[model.at]) || passes(model) > -margin(model) || richer(model, pickModel) >= -1e-9 * leastGain;
    });
    let from = null;
    if (pickModel && arrival) {
        const keeps = new Set(kept);
        let holds = true;
        for (const model of models) {
            model.walkAt = arrival.walkOf(model.spot);
            model.away = String(model.spot.id) === arrival.away;
            if (!keeps.has(model) && !never(model) && !(model.walk <= pickModel.walk * model.walkAt)) holds = false;
        }
        if (holds) from = String(pickModel.spot.id);
        if (Diagnostics.active()) Diagnostics.count('income_crowd', 'arrival', holds ? 'replayed' : 'searches');
    }
    return { models: kept, pick: kept.indexOf(pickModel), earner: kept.indexOf(earnerModel), checks, most, weight, hour,
        origin: String(state.spotId), arrival: from, death: from ? arrival.death : 1 };
}
// The crowd key's replay at a read: { moved, earner }, moved '' while the
// pick stands at the counts of its candidates' hunters and the prices now
// (weight, k: the weight and risk factor now, each inside its range, move:
// the prices' move inside their hull, null: as read; the caller checked
// them), else the input that moved ('prices' when only they did, else
// 'crowd'); earner: the key's model that sets its earning now (-1: none). The
// counts are compared first: with none moved, the prices as read, the bot on
// the spot it searched from and the weight or the risk factor as searched,
// the other one inside its range is the search's own answer (each range
// holds the rest as searched), and nothing is replayed. Else every
// comparison is replayed at once (the weight, frustration and price ranges
// are each taken with the others as searched, so two moved need the replay
// too); from the pick's own spot (arrived: its walks, the spot it left no
// candidate where it was only as its own). Cost per read: n count reads (n:
// the key's models), no allocation; a replay adds n values and judge's
// O(n·(1 + r)) comparisons (r: the candidates paying more than the pick).
function crowdStands(key, state, weight, k, move = null, timestamp = Date.now(), there = false) {
    if (!key) return { moved: move ? 'prices' : '', earner: -1 };
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
    const models = key.models;
    let crowded = false;
    for (let at = 0; at < models.length && !crowded; at++) crowded = Spots.spotHunters(models[at].spot, state) !== models[at].hunters;
    if (!crowded && !move && !there && (weight === key.weight || k === 1)) return { moved: '', earner: key.earner };
    const moved = crowded || !move ? 'crowd' : 'prices';
    if (key.pick >= 0 && Spots.spotHunters(models[key.pick].spot, state) > key.most) {
        countCrowd(crowded, false);
        return { moved, earner: -1 };
    }
    const values = models.map(model => {
        const hunters = Spots.spotHunters(model.spot, state);
        return valueOf(model, weight, k, shareAt(model, hunters), !(there && model.away) && Spots.roomAt(model.spot, state, hunters),
            move, key.hour, there ? model.walkAt : model.walk);
    });
    let allowed = null;
    const ask = spot => (allowed ||= invoke('GameServer/Bot/AI/LevelingRoutes').spotAllowedReaderFor(state, matchupOptions(state, timestamp)))(spot);
    const { verdict, earner } = judge(values, key.pick >= 0 ? values[key.pick] : null, key.checks, ask);
    return countCrowd(crowded, verdict === STANDS) ? { moved: '', earner } : { moved, earner: -1 };
}
// The inputs a route's numbers (its row and earning: liveRoute) read that the
// crowd key replays: the pick's crowd share (huntShare at the hunters on it,
// what its row reads of them; 1: a row that does not), the key's model that
// sets its earning (-1: none) and its share, the shot and potion prices.
function liveInputs(key, state, earner, costs) {
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
    const share = model => model?.share ? SpotValueTable.huntShare(model.share.production,
        Math.max(1, Spots.spotHunters(model.spot, state)), model.share.kills) : 1;
    return { share: share(key.models[key.pick]), earner, earnerShare: share(key.models[earner]), shots: costs.shots, potions: costs.potions };
}
// A held route's numbers at the inputs a read finds (read: standsRead's, the
// pick standing), as a fresh search there gives them, bit for bit: its row
// and its earning, at the hunters on its spot and on the spot the replay
// finds setting the earning now, and the prices (a reader with none of its
// own, price null: as the search read them). The route itself while they
// read the same; else a new one, its spot's and the earner's rows read
// through the search's own reader (valuesFor: one SpotEconomics reader, two
// rows). The rest of a row (its value hours at the weight and frustration
// now) and the inputs no key reads (the bot's own sample values and income
// error inside its error: the observation rule) stay as searched.
function liveRoute(route, stands, state, read, { timestamp = Date.now(), price } = {}) {
    const key = stands?.crowd;
    if (!route || !key || key.pick < 0 || read.moved) return route;
    const live = liveInputs(key, state, read.earner, read.costs), was = route.live;
    if (was && sameLive(was, live)) return route;
    // Diagnostics: a kept read that read the route's rows anew, by whether the spot setting its earning moved.
    if (Diagnostics.active()) Diagnostics.count('income_live', 'refreshed', was && was.earner !== live.earner ? 'earner' : 'inputs');
    const { evaluate } = valuesFor(state, timestamp, price === null ? pricesAsRead(state, stands.prices) : price);
    const row = evaluate(route.spot, route.row.useShots), by = key.models[read.earner];
    const earning = by ? evaluate(by.spot, by.shots)?.income : row?.income;
    return row && Number.isFinite(earning) ? { spot: route.spot, row, earning, live } : route;
}
// A reader with no prices of its own (the party's read of the hold): the
// prices the held route's numbers last read (its owner's), else the search's.
function heldPrices(route, stands, state) {
    return stands?.prices ? pricesAsRead(state, route?.live ?? stands.prices) : null;
}
const sameLive = (a, b) => a.share === b.share && a.earner === b.earner && a.earnerShare === b.earnerShare
    && a.shots === b.shots && a.potions === b.potions;
// A price reader with the given shot and potion prices (a search's, a held
// route's: a reader with none of its own, liveRoute and the party's read).
function pricesAsRead(state, prices) {
    const shot = Number(invoke('GameServer/Inventory/ShotStock').planForState(state).selfId);
    const potion = Number(invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId);
    return id => Number(id) === shot ? prices.shots : Number(id) === potion ? prices.potions : 0;
}
// Diagnostics: a read where its candidates' crowd moved, kept or searched (income_crowd).
function countCrowd(crowded, stands) {
    if (crowded && Diagnostics.active()) Diagnostics.count('income_crowd', stands ? 'kept' : 'searched', 'moved');
    return stands;
}

// Diagnostics only: each search's duration (link:income:search) and the
// searches since the start with their milliseconds (the worker's links line),
// both entry points.
const searchCounts = { searches: 0, ms: 0 };
const timed = entry => function (state, options) {
    if (!Diagnostics.active()) return entry(state, options);
    const started = performance.now();
    try { return entry(state, options); } finally {
        const ms = performance.now() - started;
        searchCounts.searches++; searchCounts.ms += ms;
        Diagnostics.duration('link:income:search', ms);
    }
};

// untimedSelect: the link shadow's verify search (EconomyContext), kept out of these counts.
module.exports = { select: timed(select), search: timed(search), untimedSelect: select,
    searchTotals: () => ({ ...searchCounts }), economicHunt, spotList, standsMoved, standsRead, liveRoute, arrived, heldPrices };
