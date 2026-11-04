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
    const matters = id => {
        let known = counted.get(id);
        if (known !== undefined) return known;
        const spot = always.has(id) ? null : Index.spotById(spots, id);
        known = !spot ? false : spotFactors.has(spot) ? spotFactors.get(spot) !== null
            : !spot.raidBoss && Number(spot.avgLevel || spot.minLevel || 1) - state.level >= minGap && !excluded.has(String(spot.id));
        counted.set(id, known);
        return known;
    };
    // Every spot the bot may earn at with this charge policy, each with its
    // score, positive or not (lineRange and the crowd key read those below zero too).
    const candidates = shots => {
        // costs are the bot's own price beliefs: the id view, not the shared shortlist rows.
        for (const spotId of list.ids(shots, state.level, minGap, cuts)) ids.add(spotId);
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
    return { route: pick, weights, stands: standsOf(state, { pool, shortlist, pick, earner, checks, verdicts, weight, weights,
        open, unpooled, cuts, matters, hour: evaluate.moneyHour, costs: BotHuntEfficiency.consumablePrices(state, price) }) };
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
function standsOf(state, { pool, shortlist, pick, earner, checks, verdicts, weight, weights, open, unpooled, cuts, matters, hour, costs }) {
    const base = Math.max(0, Number(state.stats?.frustration) || 0);
    const risk = { base, ...lineRange(1, 1 / (1 + base), Infinity, pool, open, pick, checks, riskLine(weight)) };
    const prices = priceStands({ pool, open, pick, checks, weight, unpooled, cuts, matters, hour, costs });
    return { prices, risk,
        crowd: crowdKey(state, { pool, shortlist, pick, earner, checks, verdicts, weight, weights, risk, prices, hour }) };
}
// The input of the answer's stands that moved since its search: 'prices'
// outside their ranges (a reader with no prices of its own, price null,
// leaves them to the hold's owner), 'frustration' outside its range, else
// what the crowd key's replay at the crowd and prices now finds moved
// (crowdStands: 'crowd' or 'prices'); '' when it stands. weight: the money
// weight now (inside the answer's weights: the caller checked them).
function standsMoved(stands, state, weight, price) {
    if (!stands) return '';
    let move = null;
    if (price !== null) {
        const costs = BotHuntEfficiency.consumablePrices(state, price);
        const shots = costs.shots - stands.prices.shots, potions = costs.potions - stands.prices.potions;
        if (shots || potions) {
            if (!pricesInside(stands.prices, shots, potions)) return 'prices';
            move = { shots, potions };
        }
    }
    const k = riskFactor(state, stands.risk.base);
    if (!(k >= stands.risk.low && k <= stands.risk.high)) return 'frustration';
    return crowdStands(stands.crowd, state, weight, k, move);
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
function priceStands({ pool, open, pick, checks, weight, unpooled, cuts, matters, hour, costs }) {
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
    // ends), ranked at the same prices (spotList's, the same price reader).
    if (cuts.some(cut => cut.costs.shots !== costs.shots || cut.costs.potions !== costs.potions)) {
        ranges.shots = [costs.shots, costs.shots]; ranges.potions = [costs.potions, costs.potions];
    } else SpotValueTable.cutStands(cuts, matters, ranges);
    return { shots: costs.shots, potions: costs.potions, shotsRange: ranges.shots, potionsRange: ranges.potions };
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
// count past which, all else as searched, the answer moves): those ranked
// above the pick, those whose score could pass the pick's somewhere in the
// box, those that could pay more than the pick and its earner somewhere (the
// earning: judge holds the earner), and with no pick every one that could
// score above zero. Each is multilinear in
// the weight, ρ and either price, so its extremes lie at the box's corners
// (the hull's four ends, a price each). Outside the box the weight,
// frustration or prices moved (searched by their ranges) or the pick's crowd
// passed `most`. A read replays the answer's comparisons over them at the
// counts and prices it reads (crowdStands). Comparisons inside a few roundings
// of their terms stand only while nothing moved.
const MOVED = 0, STANDS = 1, UNSURE = 2;
function modelOf(candidate, at, state, verdicts, Spots) {
    const row = candidate.row, share = row.crowd || null, hunters = Spots.spotHunters(candidate.spot, state);
    const model = { spot: candidate.spot, at, own: String(candidate.spot.id) === String(state.spotId),
        exp: row.expHours, income: row.incomeHours, risk: row.riskHours, walk: candidate.walkFactor, gain: row.income,
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
// pool; as read: it does).
function valueOf(model, weight, k, rho, open, move = null, hour = 1) {
    const sigma = model.share?.value ? rho : 1, tau = model.share ? rho : 1;
    const spend = move ? model.shotUnits * move.shots + model.potionUnits * move.potions : 0;
    const costs = move ? Math.abs(model.costs) + Math.abs(spend) : 0;
    const income = move ? model.income - spend / hour : model.income;
    const lift = model.exp * (1 - weight) + income * weight, cost = model.risk * k;
    const gain = sigma * (move ? model.gain - spend : model.gain);
    const tolGain = 16 * Number.EPSILON * (Math.abs(gain) + sigma * costs);
    return { model, open, moved: !!move, s: (sigma * lift - tau * cost) / model.walk, gain,
        tol: 16 * Number.EPSILON * (Math.abs(model.exp) + Math.abs(income) + costs / hour + Math.abs(cost)) * Math.max(1, sigma, tau) / model.walk,
        tolGain, pool: move ? (gain > tolGain ? 1 : gain < -tolGain ? -1 : 0) : 1 };
}
// The answer the search reads from these values: STANDS (the same pick and
// earning spot), MOVED, or UNSURE (a comparison inside its margin). values:
// valueOf per candidate; pick, earner: theirs (null: none).
function judge(values, pick, earner, checks) {
    let unsure = false;
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
            if (reached === 1 && positive(x) === 1) return MOVED;
            if (reached !== -1) unsure = true;
        }
        return unsure ? UNSURE : STANDS;
    }
    if (!pick.open || note(positive(pick)) === -1) return MOVED;
    // No candidate the matchup may allow comes before the pick, and the pick
    // stays within the first `checks`.
    for (const x of values) {
        if (x === pick || x.model.verdict === false || !x.open || positive(x) === -1) continue;
        const b = before(x, pick);
        if (b === 1 && positive(x) === 1) return MOVED;
        if (b !== -1) unsure = true;
    }
    if (note(within(pick, before)) === -1) return MOVED;
    // The earning: the first allowed of the first `checks` by income paying more
    // than the pick (earner), every one before it refused; none: no allowed one pays more.
    if (earner) {
        if (!earner.open || note(positive(earner)) === -1 || note(richer(earner, pick)) === -1) return MOVED;
        if (note(within(earner, richer)) === -1) return MOVED;
    }
    for (const x of values) {
        if (x === pick || x === earner || x.model.verdict === false || !x.open || positive(x) === -1) continue;
        const b = richer(x, earner || pick);
        if (b === -1) continue;
        const reached = within(x, richer);
        if (reached === -1) continue;
        if (b === 1 && positive(x) === 1 && reached === 1) return MOVED;
        unsure = true;
    }
    return unsure ? UNSURE : STANDS;
}
function crowdKey(state, { pool, shortlist, pick, earner, checks, verdicts, weight, weights, risk, prices, hour }) {
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
    // The pick's own hunters past which, all else as searched, the answer
    // moves: its room (another spot's), else, where its value follows its
    // share, where its score or income falls below what it must stay above
    // (the answer moves at most once as the count grows: found by halving, up
    // to 64 more on its own spot, none past that).
    let most = Infinity;
    if (pickModel) {
        const room = invoke('GameServer/Bot/AI/LevelingRoutes').roomForSpot(pickModel.spot);
        const last = pickModel.own ? Infinity : Math.max(pickModel.hunters, room);
        // An observed row's deaths fall with its hunters and its income stays: it only gains.
        if (!pickModel.share?.value) most = last;
        else {
            const at = models.indexOf(pickModel), pickValue = values[at];
            const earnerValue = earnerModel ? values[models.indexOf(earnerModel)] : null;
            const cap = pickModel.own ? pickModel.hunters + 64 : last;
            const stands = h => {
                values[at] = valueOf(pickModel, weight, 1, shareAt(pickModel, h), Spots.roomAt(pickModel.spot, state, h));
                return judge(values, values[at], earnerValue, checks) === STANDS;
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
    // The most a model can pay above another (the pick, its earner) in the box.
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
    const kept = models.filter(model => {
        if (model === pickModel || model === earnerModel) return true;
        if (best(model) <= -margin(model)) return false;
        if (!pickModel) return true;
        // The earning reads only the candidates paying more than the pick and its earner (judge: the same earner).
        return above.has(pool[model.at]) || passes(model) > -margin(model)
            || richer(model, pickModel) >= -1e-9 * leastGain && (!earnerModel || richer(model, earnerModel) >= -1e-9 * leastGain);
    });
    return { models: kept, pick: kept.indexOf(pickModel), earner: kept.indexOf(earnerModel), checks, most, weight, hour };
}
// The crowd key's replay at a read: '' while the answer stands at the counts
// of its candidates' hunters and the prices now (weight, k: the weight and
// risk factor now, each inside its range, move: the prices' move inside their
// hull, null: as read; the caller checked them), else the input that moved
// ('prices' when only they did, else 'crowd'). The counts are compared first:
// with none moved, the prices as read and the weight or the risk factor as
// searched, the other one inside its range is the search's own answer (each
// range holds the rest as searched), and nothing is replayed. Else every
// comparison is replayed at once (the weight, frustration and price ranges
// are each taken with the others as searched, so two moved need the replay
// too). Cost per read: n count reads (n: the key's models), no allocation; a
// replay adds n values and judge's O(n·(1 + r)) comparisons (r: the
// candidates richer than the pick's earning that the search never asked,
// usually none).
function crowdStands(key, state, weight, k, move = null) {
    if (!key) return move ? 'prices' : '';
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
    const models = key.models;
    let crowded = false;
    for (let at = 0; at < models.length && !crowded; at++) crowded = Spots.spotHunters(models[at].spot, state) !== models[at].hunters;
    if (!crowded && !move && (weight === key.weight || k === 1)) return '';
    const moved = crowded || !move ? 'crowd' : 'prices';
    if (key.pick >= 0 && Spots.spotHunters(models[key.pick].spot, state) > key.most) return countCrowd(crowded, false) ? '' : moved;
    const values = models.map(model => {
        const hunters = Spots.spotHunters(model.spot, state);
        return valueOf(model, weight, k, shareAt(model, hunters), Spots.roomAt(model.spot, state, hunters), move, key.hour);
    });
    const verdict = judge(values, key.pick >= 0 ? values[key.pick] : null, key.earner >= 0 ? values[key.earner] : null, key.checks);
    return countCrowd(crowded, verdict === STANDS) ? '' : moved;
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
    searchTotals: () => ({ ...searchCounts }), economicHunt, spotList, standsMoved };
