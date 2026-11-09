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
// spot closest to level; values(...): the same as { spotId, value } (the income
// each is ranked by: SpotSearch's leveling goal).
function spotList(state, { price } = {}) {
    let spoiler, costs = null;
    const spoilerOf = () => spoiler !== undefined ? spoiler
        : (spoiler = ColdKillRewards.spoilerFor(state, { skills: ColdCombatProfile.skillsFor(state) }) || null);
    const ranked = read => (shots, level = state.level, minGap = -7) => read(SpotValueTable.roleFor(state), level,
        costs ||= BotHuntEfficiency.consumablePrices(state, price), minGap, shots,
        { spoilSkillLevel: spoilerOf()?.skillLevel || 0 });
    return { spoiler: spoilerOf, ids: ranked(SpotValueTable.rankedSpotIds), values: ranked(SpotValueTable.rankedSpotValues) };
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
// The route of a spot a rule fixed (the karma wash, a protected starter's field): its row with shots, else
// without, else none (no income expected there); the hour its row's income. null: no spot.
function fixedRoute(spot, evaluate) {
    if (!spot) return null;
    const row = evaluate(spot, true) || evaluate(spot, false);
    return { spot, row: row || { income: 0, expected: 0, kills: 0, exp: 0, useShots: true }, earning: Number(row?.income) || 0 };
}
// Survival drinks (situations.md A5): potions are no must. A spot needs them of
// this bot when the table's reference bot drinks there (its row's potions at the
// bot's level) and the bot's own HP margin does not carry the fight without: the
// cycle's damage per fight × its pull × DRINK_TAIL against maxHp × (1 − the
// potion threshold) (one Table.cycle read; the reference bot's gear is not the
// bot's). DRINK_TAIL is ours (limits.md "Survival drinks tail"): rows are
// simulated with drinks, so a stay without them is unproven until deaths count.
const DRINK_TAIL = 1.5;
function needsDrinks(state, spot, shots) {
    const role = SpotValueTable.roleFor(state);
    if (!(Number(SpotValueTable.value(spot.id, role, state.level, shots)?.potions) > 0)) return false;
    const cycle = SpotValueTable.cycle(spot.id, role, state.level, shots), maxHp = Number(state.vitals?.maxHp) || 0;
    if (!cycle || !(maxHp > 0)) return true;
    const margin = maxHp * (1 - invoke('GameServer/Bot/AI/HealingPotionStock').useThreshold(state));
    return Number(cycle.taken) * (Number(cycle.pull) || 1) * DRINK_TAIL >= margin;
}
// The spot's own kit use for the bot (situations.md §14): the table row's shots
// (the bot's shot kind fires; none for a weapon without a charge) and survival
// potions per hour at its level and charge policy, and whether the spot needs
// drinks of it. Written into the earning answer when the decision is taken
// (answerOf; spotUseOf reads it); the kit's per-bot rates are the build's
// (StatsPacket.kitRates). Rounded as the kit rates are.
// shotKind: the earning decision's own choice of shot (ShotStock.decidedKind), the kind a bot
// holding no shot fires and buys until the decision is taken again.
function spotRates(state, spot, shots) {
    const Shots = invoke('GameServer/Inventory/ShotStock'), Packet = require('./StatsPacket'), plan = Shots.planForState(state);
    const row = SpotValueTable.value(spot.id, SpotValueTable.roleFor(state), state.level, shots);
    return { shotKind: Shots.decidedKind(state), shotsPerHour: Packet.roundRate(plan.perAction > 0 ? Math.max(0, Number(row?.shots) || 0) : 0),
        potionsPerHour: Packet.roundRate(Math.max(0, Number(row?.potions) || 0)), drinks: needsDrinks(state, spot, shots) };
}
// The kit's per-spot use for the bot now, one rule on both threads (situations.md
// §14): its held earning answer's when the answer carries it and the bot hunts
// that spot solo (or stands on none: the town, the road); else the spot table's
// at the bot's spot and level (a party member, an answer saved before it carried
// the use, none held, another spot), the band's best row without a spot. A pure
// table read, no search. earning: the answer to read (a build's own, else held).
function spotUseOf(state, earning = state?.stats?.earning) {
    const party = state?.party?.partyId || state?.partyId;
    if (!party && earning && Number.isFinite(earning.shotsPerHour) && Number.isFinite(earning.potionsPerHour)
        && (!state?.spotId || String(state.spotId) === String(earning.spotId))) return earning;
    const Packet = require('./StatsPacket'), plan = invoke('GameServer/Inventory/ShotStock').planForState(state);
    const role = SpotValueTable.roleFor(state), level = Number(state?.level) || 1;
    const row = (state?.spotId && SpotValueTable.value(state.spotId, role, level, true)) || SpotValueTable.best(role, level, true);
    return { shotsPerHour: Packet.roundRate(plan.perAction > 0 ? Math.max(0, Number(row?.shots) || 0) : 0),
        potionsPerHour: Packet.roundRate(Math.max(0, Number(row?.potions) || 0)) };
}
// What one line of survival potions costs the bot that misses it: the units up to
// its line at the kit's price (the NPC list price the refill reserve holds,
// EconomyContext.survivalPrice). One rule for the search's broke bot (cannotDrink)
// and the build's threshold (DecisionSections.affordAtOf, goal_affordable:potions).
const drinksAt = (line, held, listPrice) => Math.max(0, Number(line) - Number(held)) * Math.max(0, Number(listPrice) || 0);
// A bot that cannot drink: its survival potions below their line and its money
// short of that line (drinksAt; the refill reserve holds what the counter spends
// on it, so a wallet that holds the line can buy it). Such a bot hunts where it
// needs no drinks.
function cannotDrink(state, price) {
    const Packet = require('./StatsPacket');
    const line = Packet.lineOf(state.stats?.kitRates, spotUseOf(state), 'potions');
    if (!(line > 0)) return false;
    const potionId = invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId;
    const held = Number(state.inventory?.[potionId]?.amount || 0);
    if (held >= line) return false;
    const list = Number(invoke('GameServer/Bot/Economy/StaticMerchantPricing').botNpcListPrice(potionId));
    return require('./PurchaseFunding').budget(state) < drinksAt(line, held, list > 0 ? list : price?.(potionId));
}
// The earning spot search (the decision's, EconomyContext.incomeRouteFor while it is woken; search below):
// { route (null: none), error (the bot's own error on a row's income, SpotEconomics incomeError) }.
function find(state, { spots = [], timestamp = Date.now(), price, required = false, mode,
    maxChecks = 32, list = null } = {}) {
    const none = { route: null, error: 0 };
    if (!spots.length || state.party?.partyId || state.partyId || ['party', 'duo'].includes(mode)) return none;
    // While the bot has karma the decision takes the karma wash's choice (situations.md B6, ColdKarmaPolicy's
    // rule), whatever else it is (a crafter at its station too: karma closes its town): weaker experience-bearing
    // mobs, on foot; woken again by karma_changed. A party member searches none (its party's spot washes it).
    const Karma = invoke('GameServer/Bot/Population/ColdKarmaPolicy');
    // A broke bot skips the spots that need survival drinks of it (A5), the karma wash's too.
    const broke = cannotDrink(state, price);
    if (Karma.active(state)) {
        const { evaluate } = valuesFor(state, timestamp, price);
        const accept = broke ? spot => !needsDrinks(state, spot, true) : null;
        return { route: fixedRoute(Karma.washSpot(state, spots, timestamp, accept), evaluate), error: evaluate.incomeError };
    }
    if (!invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)) return none;
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
    // The goal's own window (SpotSearch.rank holds the catalogue, raid and exclusion clauses): monsters at
    // most 15 levels below the bot, a kit that may survive them, no foreign starter field. Search-local,
    // one answer per spot.
    const fitting = new Map();
    const fits = (candidate, spot) => {
        let fit = fitting.get(spot);
        if (fit === undefined) fitting.set(spot, fit = Number(spot.avgLevel || spot.minLevel || 1) - state.level >= minGap
            && survives(spot) && !Routes.localityPenaltyForSpot(spot, state, { level: state.level }, Routes.tagsForSpot(spot)));
        return fit;
    };
    // lazy: cycle SpotProfiles' search reads this module's held answer.
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
    const Search = invoke('GameServer/Bot/AI/SpotSearch');
    // A fresh racial cohort stays on its level-one field until it advances (SpotProfiles.isProtectedStarterCohort):
    // that field is its answer while it may hunt there.
    const own = Spots.isProtectedStarterCohort(state) ? Index.spotById(spots, state.spotId) : null;
    if (own && Search.rank(state, { candidates: [{ spot: own }], fits, value: () => 1 }, { excluded, habit: false }).pick) {
        return { route: fixedRoute(own, evaluate), error: evaluate.incomeError };
    }
    // Every spot the bot may earn at with this charge policy, as the search's candidates; the value its hour
    // there over the walk (search-local walk factors, one per spot); those earning nothing at the prices
    // read, or needing drinks of a broke bot, are worth nothing.
    const walkFactors = new Map();
    const value = candidate => {
        const { spot, shots } = candidate, row = candidate.row = evaluate(spot, shots);
        if (!(row?.income > 0) || broke && needsDrinks(state, spot, shots)) return 0;
        let walkFactor = walkFactors.get(spot);
        if (walkFactor === undefined) walkFactors.set(spot, walkFactor = 1 + WalkBack.tripHours(origin, spot, state, spots) / 0.5);
        // Amortize relocation over a half-hour earning visit. Actual
        // town fees/time are still charged by the common wish paths.
        candidate.walkFactor = walkFactor;
        return candidate.score = (row.valueHours || 0) / walkFactor;
    };
    // costs are the bot's own price beliefs: the id view, not the shared shortlist rows.
    const candidates = shots => {
        for (const spotId of list.ids(shots, state.level, minGap)) ids.add(spotId);
        return [...ids].map(id => ({ spot: Index.spotById(spots, id), shots }));
    };
    // Compare both charge policies and the entire earning band together.
    // Returning the first charged/near-level camp hid cheaper easier hunts.
    // The same spot under both policies ties on all keys: the charged one first.
    // One profile and safety read for the whole search (L131). The chosen
    // route carries its solo profiles: the same build's source route reader
    // (GearAcquisitionPlanner.sourceRouteReader) reads the same ones.
    // The crowd is no input: a C4 player picks a camp by what he knows of it and
    // meets the crowd on arrival (SpotContest turns it away from one found crowded).
    const allowed = Routes.spotAllowedReaderFor(state, options);
    // Each spot's verdict, asked once (the two charge policies share it).
    const verdicts = new Map();
    const asked = spot => {
        let verdict = verdicts.get(spot);
        if (verdict === undefined) verdicts.set(spot, verdict = !!allowed(spot));
        return verdict;
    };
    const { pick, ranked } = Search.rank(state, { candidates: [true, false].flatMap(candidates), fits, value,
        tie: (a, b) => Number(a.spot.avgLevel || 1) - Number(b.spot.avgLevel || 1) || String(a.spot.id).localeCompare(String(b.spot.id)) },
    { excluded, allowed: (candidate, spot) => asked(spot), maxChecks, mode: 'solo', count: true });
    if (pick) {
        pick.matchupProfiles = options.matchupProfiles;
        // The bot's hour (hourAdena, the unit of every value) stays what it could
        // earn: its best income among the spots it may hunt, wherever it levels.
        pick.earning = pick.row.income;
        for (const candidate of ranked.toSorted((a, b) => b.row.income - a.row.income).slice(0, Math.max(1, maxChecks))) {
            if (candidate.row.income <= pick.earning) break;
            if (asked(candidate.spot)) { pick.earning = candidate.row.income; break; }
        }
    }
    return { route: pick, error: evaluate.incomeError };
}

// The earning spot's searches and their time since the worker started (the status line's situations
// search=, diagnostics off too): two clock reads per search, ~5 per bot-hour.
const searchCounts = { count: 0, ms: 0 };
// search: find, timed.
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
// at, and the spot's kit use (spotRates: shotKind, shotsPerHour, potionsPerHour, drinks; read by the kit's line and
// amounts, StatsPacket.ratesOf/lineOf); an answer taken alone also its facts, Situations.withOwnFacts }. ~110 B. found: search's { route }; error: the search's
// evaluate.incomeError; state: the bot (its spot rates).
function answerOf(route, at, error = 0, state = null) {
    return route ? { spotId: String(route.spot.id), shots: route.row.useShots !== false, income: Number(route.row.income) || 0,
        expected: Number(route.row.expected ?? route.row.income) || 0, earning: Number(route.earning) || 0, error: Number(error) || 0, at,
        ...(state ? spotRates(state, route.spot, route.row.useShots !== false) : { drinks: false }) }
        : { spotId: null, shots: true, income: 0, expected: 0, earning: 0, error: 0, at, drinks: false };
}
// A player's command naming a spot (Situations' player_command, B6) as the held answer: that spot, with the
// bot's hour, charge policy and error kept from the answer it replaces (held: null for none); no income expected
// there (a stay never disappoints a command: BotHuntEfficiency.disappoints). Held until the bot's next own
// situation re-decides the spot. command: the player decided it (isCommanded: a spot contest never makes it
// avoid, B14).
// It carries no kit use of its own: spotUseOf reads the spot table there (no table read here); the shot
// kind the replaced answer chose stays (ShotStock.decidedKind).
function commanded(held, spotId, at = 0) {
    return { spotId: String(spotId), shots: held?.shots !== false, income: 0, expected: 0, earning: Number(held?.earning) || 0,
        error: Number(held?.error) || 0, at: Number(at) || 0, command: true, drinks: false,
        ...(held?.shotKind ? { shotKind: held.shotKind } : {}) };
}
const isCommanded = held => held?.command === true;
// The held answer's spot id (no search). null: no answer, none held (spotId null), or a bot in a party: its
// hunt is the party's (the party comparison reads its solo copy).
function answerSpotId(state, mode = null) {
    if (state.party?.partyId || state.partyId || ['party', 'duo'].includes(mode)) return null;
    return state.stats?.earning?.spotId || null;
}
// The same spot in a catalogue (spots: the catalogue's profiles); null too for a spot the catalogue lost.
function heldSpot(state, spots = [], mode = null) {
    const spotId = answerSpotId(state, mode);
    return spotId ? invoke('GameServer/Bot/AI/SpotIndex').spotById(spots, spotId) || null : null;
}
// The route of the held answer at the inputs now (no search): its spot's row evaluated once at the reader's prices
// (SpotEconomics, as the search reads it), its hour as decided. null: no held spot (heldSpot) or no row there.
// values: the caller's valuesFor of the same state, when it values another hour beside (the party comparison).
function heldRoute(state, { spots = [], timestamp = Date.now(), price, mode = null, values = null } = {}) {
    const spot = heldSpot(state, spots, mode);
    if (!spot) return null;
    const held = state.stats.earning;
    const row = (values || valuesFor(state, timestamp, price)).evaluate(spot, held.shots !== false);
    return row ? { spot, row, earning: Number(held.earning) || 0 } : null;
}

module.exports = { search: timed(find), searchTotals: () => ({ ...searchCounts }), economicHunt, spotList,
    answerOf, commanded, isCommanded, heldSpot, heldRoute, valuesFor, earnsOnRoute, needsDrinks, cannotDrink, spotRates, spotUseOf, drinksAt, DRINK_TAIL };
