'use strict';

// Facts, reusable calculations and a new character decision are different
// things. Only these compact boundaries belong to the saved decision; graphs
// stay in EconomyContext's existing bounded working cache.
const FailureLog = require('../../../FailureLog');
const { fnv1a32 } = require('../Fnv1a');
const { createHash } = require('node:crypto');
const PurchaseFunding = require('./PurchaseFunding');
const Packet = require('./StatsPacket');
const Karma = require('../../Karma');
const Warehouse = require('./PersonalWarehouseIndex');
const ClanSupply = require('../../Clan/ClanSupplyPolicy');
const Providers = require('./WishProviders');
const Floor = require('../Population/SurvivalFloor');
const InventoryLimits = require('../../Inventory/InventoryLimits');
const Diagnostics = require('./EconomyDiagnostics');
const Situations = require('../Situations');
const { FIELD_ACTIVITIES } = Situations;
const partyIdOf = state => String(state.party?.partyId || state.partyId || '');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const DataCache = invoke('GameServer/DataCache');
const CombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const positive = n => Math.max(0, Number(n) || 0);
const hash = value => fnv1a32(JSON.stringify(value));
const SAMPLE_BYTES = 20;
function sampleRows(value) {
    if (typeof value === 'string') {
        if (!value.startsWith('s1:') || value.length > 3 + Math.ceil(Hunt.MAX_SPOTS * SAMPLE_BYTES / 3) * 4) return null;
        const encoded = value.slice(3), bytes = Buffer.from(encoded, 'base64');
        if (!bytes.length || bytes.length % SAMPLE_BYTES || bytes.toString('base64') !== encoded) return null;
        value = [];
        for (let at = 0; at < bytes.length; at += SAMPLE_BYTES) {
            value.push([bytes.readUInt32LE(at), bytes.readDoubleLE(at + 4), bytes.readDoubleLE(at + 12)]);
        }
    }
    if (!Array.isArray(value) || value.length > Hunt.MAX_SPOTS) return null;
    for (const row of value) {
        if (!Array.isArray(row) || row.length !== 3 || !Number.isInteger(row[0]) || row[0] < 0 || row[0] > 0xffffffff
            || !Number.isFinite(row[1]) || !Number.isFinite(row[2])) return null;
    }
    return value;
}
function packSample(rows) {
    if (!Array.isArray(rows) || !sampleRows(rows)) return null;
    if (!rows.length) return [];
    const bytes = Buffer.allocUnsafe(rows.length * SAMPLE_BYTES);
    rows.forEach((row, at) => {
        const offset = at * SAMPLE_BYTES;
        bytes.writeUInt32LE(row[0], offset); bytes.writeDoubleLE(row[1], offset + 4); bytes.writeDoubleLE(row[2], offset + 12);
    });
    return `s1:${bytes.toString('base64')}`;
}
function observationBaselineValid(baseline, rows) {
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return false;
    if (rows === undefined) rows = sampleRows(Object.hasOwn(baseline, 'sample') ? baseline.sample : []);
    return rows !== null && (!Object.hasOwn(baseline, 'share') || Number.isFinite(baseline.share)
        && baseline.share >= 0 && baseline.share <= 1);
}
// The decision sections in the order of their wishDirty bit (1 << at): one
// table for the raise (DecisionEvents) and the names its readers count.
// observation: the bot's own hunt samples moved past its error (Situations'
// observation link, beside its sections): an event bit read by the links that
// read the sample values (the earning spot search), no piece of its own.
const SECTIONS = Object.freeze(['build', 'combat', 'supply', 'benefits', 'sources', 'occupation', 'money', 'relations', 'observation']);
function sectionBit(name) {
    if (name === 'funding') name = 'money';
    const at = SECTIONS.indexOf(name);
    if (at < 0) throw new Error(`decision section: unknown ${name}`);
    return 1 << at;
}
function sectionMask(names) {
    return names.reduce((bits, name) => bits | sectionBit(name), 0);
}
// The computed pieces of a decision and the sections each reads: at the
// decision point a piece is reused while none of its sections is raised
// (EconomyContext.forState's mask), rebuilt when one is.
// foundation: hunt income, risk, death and kit hours, stock targets, the
// survival reserve (kit, profile, consumables, the observation). Of money it
// reads the wallet only for the rest bottles' cap, read anew on a kept
// foundation (EconomyContext.foundationFromPlan), and the money weight of its
// income search, which the held earning spot follows itself (incomeMoved:
// the weights its answer stands over).
// Of the relations fact it reads only the party role (its spot value table
// and hunt income); relations is in its list for it, so a party join
// rebuilds it (a deviation from the spec's four sections).
// The earning spot search inside it decides on its own key (LINK_INPUTS
// incomeSearch, EconomyContext.incomeMoved), not on these sections.
// sources: the source walk (worn gear and level; party, clan, role;
// exclusions, risk, hunt rows; the plan, persona, craft station, trades;
// the hour adena and the money mark). weighing: focus, step and money queue.
// route: the bot's hunting spot search (BotRoute.choose), kept in the worker's
// record: kit and level (build), party and clan (relations), the ground and
// the exclusion and "was full" marks (occupation, sources). The matchup it
// filters with reads the kit, so build covers it; buffs and night are read-time.
const FOUNDATION = sectionMask(['build', 'combat', 'supply', 'occupation', 'relations']);
const COMPUTED = Object.freeze({
    foundation: FOUNDATION,
    // weighing: every piece (a refusal that names no section); the
    // observation bit is an event, not a piece: the earning spot search hears
    // what such a refusal moved through its own key.
    weighing: sectionMask(SECTIONS.filter(name => name !== 'observation')),
    route: sectionMask(['build', 'relations', 'occupation', 'sources']),
    // The source walk's per-spot ground verdict (GearAcquisitionPlanner.sourceGround):
    // level and kit matchup; its other reads are checked beside it.
    sourceGround: sectionMask(['build']),
    // What makes a build weigh every gear candidate whatever the moment: the
    // bot's kit, what gear gives it, a death (Situations.quiet).
    gearReview: sectionMask(['build', 'benefits', 'combat'])
});
// The decision links: the inputs
// each link reads, by inputVersions name. The earning spot search and the
// workshop decide on them (EconomyContext.incomeMoved, workshopKeyHolds); the
// route rows are measured only (EconomyContext's link shadow, developerDiagnostics).
// discrete: a version compared exactly; continuous: a value compared inside
// the answer's own range, else beyond the bot's own error (movedInput);
// events: what the link reads with no version, standing on an event bit or on
// nothing (a window).
const linkOf = (discrete, continuous, events) => Object.freeze({ discrete: Object.freeze(discrete),
    continuous: Object.freeze(continuous), events: Object.freeze(events) });
const LINK_INPUTS = Object.freeze({
    // The earning spot search (EquipmentIncomeRoute.select, called by
    // EconomyContext.incomeRouteFor and holdRead; its route feeds foundation).
    incomeSearch: linkOf([
        'kit.class', // select: SpotValueTable.roleFor (the table role) and Match.stateProfiles
        'kit.level', // select: state.level (the band, minGap, spotList.ids, avgLevel - level), the matchup
        'kit.worn', 'kit.hennas', 'kit.capture', // select: Match.stateProfiles -> soloSpotUpperBound, spotAllowedReaderFor
        'kit.skills', // spotList: ColdKillRewards.spoilerFor(skillsFor), the spoil skill level; the matchup
        'party', // select: the state.party.partyId gate
        'mode', // select: the caller's mode gate (party, duo); maxChecks stays the caller's option
        'adventurer', // select: PersonalGearProgression.adventurer gate
        'economic', // select: economicHunt opens the search
        'required', // select: required (GearProgression.assess in EconomyContext.incomeRouteFor)
        'spot', // select: ids start with state.spotId; origin = its center, else state.loc (WalkBack.tripHours); the arrival at the answer's spot replays (EquipmentIncomeRoute.arrived)
        'samples', // select: BotHuntEfficiency.sampledRows spot ids join the candidates; a new sampled spot moves every table row (calibration) and the hunt's death hours: a search
        'exclusions', // select: SpotRiskPolicy.excludedSpotIdsForStates (its exclusionVersion, a mark's end read at each check)
        'recovery', // select: spotAllowedReaderFor -> safetyOptions' maxTargetLevel (the death recovery's level penalty)
        'bagShot', // spotList.ids: consumablePrices' shot (ShotStock.planForState); stateProfiles' loaded shot (shotInputs)
        'spawns' // SpotValueTable rows (value, rankedSpotIds, best): the spot catalog period, rewards, rates (its revision)
    ], [
        'weight', // SpotEconomics.create: moneyWeight, inside the weights the answer stands over (search's weights)
        'hour' // SpotEconomics.create: the packet's own hour where the band has no money hour (search's weights.hour)
    ], [
        // What the answer stands on beside these (EquipmentIncomeRoute.standsMoved, read where the hold is):
        'observation', // SpotEconomics.create: the bot's own sample values (the observation bit, beyond its own error)
        'prices', // spotList.ids and SpotEconomics: the shot and potion prices (the reader's), inside the hull of the ranges the crowd key replays over (search's stands.prices)
        'frustration', // SpotEconomics riskWeight: inside the range of it the answer stands over (search's stands.risk)
        'crowd' // SpotEconomics spotHunters, SpotProfiles.roomFor: the crowd key's replay over its candidates' hunters (the pick; its earner and numbers at the read: liveRoute)
    ]),
    // The crafter's workshop: the occupation planner's answer
    // (ColdOccupationSources.prepare over the planner capture,
    // ColdSimulationWorker occupationPlanner.capture), kept by
    // EconomyContext.heldWorkshopOf.
    workshop: linkOf([
        'kit.class', 'kit.level', // mpPerHour (seated recovery by class and level); recipe eligibility
        'craft', // prepare: CraftShopService.craftLevelFor; capture: stats.workshop.entries (knownRecipes); the station
        'crafter', // the worker asks a service crafter only (noCrafterWorkshop)
        'recipes', // capture: RecipeBookCodec.unpack(recipeBook)
        'maxMp', // craftLabour: state.vitals.maxMp (a cold command's MP cap)
        'route', // prepare: EconomicTrip.key against the captured routeKey / routeRows (the karma flip among them)
        'income', // prepare: Packet.hourAdena, the earning the held earning spot's answer published (its spot and hour)
        'ownLines', // a crafter: its own sell lines (WealthCraftDecision output stock and prices, the shot exits'
        // posted count); any other bot: whether one stands (noCrafterWorkshop asks the planner's feasibility)
        'supply' // a shot crafter: the bag's shot and potion presence (its product's own stock)
    ], [], [
        'money', // the money bit: the wallet (the planner's funding), the packet's money price and survival reserve, the market watch
        'observation', // the observation bit: the bot's own samples, which move its hour before the income answer does
        'bag', // prepare: every inventory row's free amount (WealthCraftDecision.freeAmount): heard in town (the money bit)
        'reservations' // prepare: reservations(state): no event (the next ask)
    ]),
    // The town route table (EconomicTrip.prepare, keyed by EconomicTrip.key =
    // routeInputs): one input per routeInputs field.
    routeRows: linkOf([
        'route.activity', // routeInputs: shopping, a trip to a visit, or neither
        'route.region', // routeInputs: currentRegion on a visit
        'route.loc', // routeInputs: the bot's point where no trip end or return point stands for it
        'route.scroll', // routeInputs: TripPayment.hasColdScroll
        'route.karma', // routeInputs: Karma.closesTowns
        'route.return', // routeInputs: stats.marketReturn.loc
        'route.travel' // routeInputs: the accepted trip's town and end
    ], [], [])
});
// What the earning spot search reads of the bag (LINK_INPUTS incomeSearch
// bagShot): the shot its consumable prices name
// (BotHuntEfficiency.consumablePrices: a spiritshot class's blessed or plain
// one by what it holds) and the kind of shot the fight loads
// (BotTargetMatchup.shotKind of ColdCombatProfile.shotSupply: none once the
// charges end; none without a bag, as stateProfiles).
function shotInputs(state, timestamp) {
    return [Number(ShotStock.planForState(state)?.selfId) || 0, state.inventory
        ? invoke('GameServer/Bot/AI/BotTargetMatchup').shotKind(CombatProfile.shotSupply(state, timestamp)) : 0];
}
// lazy: ShotCraftPolicy loads the craft decision, which reads this module's readers.
let shotRecipes = null;
const shotRecipe = id => (shotRecipes ||= new Set(invoke('GameServer/Bot/Economy/ShotCraftPolicy').SHOT_RECIPE_IDS)).has(Number(id));
const pointOf = loc => loc ? [Number(loc.locX) || 0, Number(loc.locY) || 0, Number(loc.locZ) || 0] : null;
// One reader per link input over one call's reads (r: the view, the state,
// the options; what several inputs share is read once, r.once).
const VERSIONS = Object.freeze({
    'kit.class': r => hash([r.kits[0], r.kits[1]]), 'kit.level': r => r.kits[2], 'kit.worn': r => r.kits[3],
    'kit.hennas': r => r.kits[4], 'kit.skills': r => r.kits[5], 'kit.capture': r => r.kits[6],
    craft: r => hash([r.view.craftLevel, r.view.craftStationId ?? null, r.view.workshop?.entries ?? null]),
    crafter: r => r.once('crafter', () => require('./CraftEligibility').isServiceCrafter(r.state)),
    recipes: r => r.view.recipes ? hash(r.view.recipes) : null,
    party: r => hash([r.view.party?.partyId, r.view.party?.role]),
    mode: r => ['party', 'duo'].includes(r.mode),
    spot: r => {
        const spot = r.spots ? invoke('GameServer/Bot/AI/SpotIndex').spotById(r.spots, r.state.spotId) : null;
        return hash([r.state.spotId ?? null, spot?.center ? null : pointOf(r.state.loc)]);
    },
    samples: r => hash([...new Set(Hunt.sampledRows(r.state, r.timestamp).map(row => String(row.spotId)))].sort()),
    exclusions: r => invoke('GameServer/Bot/Population/SpotRiskPolicy').exclusionVersion(r.state).revision,
    // What the search's matchup reads of the recovery (its solo safety, as select asks it).
    recovery: r => invoke('GameServer/Bot/AI/LevelingRoutes').safetyOptions(r.state, { mode: 'solo' }).maxTargetLevel ?? null,
    bagShot: r => hash(shotInputs(r.state, r.timestamp)),
    // The table's revision: a counter of this thread (a held answer never leaves it).
    spawns: () => invoke('GameServer/Bot/AI/SpotValueTable').revision(),
    economic: r => invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').economicHunt(r.state),
    adventurer: r => invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(r.state),
    // The caller's own assessment of this state when it holds one (one per read: incomeRouteFor), else assessed here.
    required: r => !!(r.required ?? invoke('GameServer/Bot/AI/PersonalGearProgression').assess(r.state).required),
    weight: r => invoke('GameServer/Bot/Economy/SpotEconomics').moneyWeight(r.state),
    hour: r => Number(Packet.hourAdena(r.stats.money)) || 0, maxMp: r => Number(r.state.vitals?.maxMp) || 0,
    income: r => r.income ? hash(r.income) : null,
    ownLines: r => {
        if (!r.board) return null;
        const lines = r.board.ownerLines(Number(r.state.characterId));
        if (!VERSIONS.crafter(r)) return Number(lines.length > 0);
        return hash(lines.filter(line => Number(line.storeType ?? 1) === 1 && line.custodyPolicy !== 1)
            .map(line => [Number(line.selfId), Number(line.count), Number(line.price)]).sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]));
    },
    supply: r => r.view.recipes?.some(shotRecipe) ? hash(r.view.supply ?? null) : null,
    ...Object.fromEntries(['route', 'route.activity', 'route.region', 'route.loc', 'route.scroll', 'route.karma', 'route.return',
        'route.travel'].map(name => [name, r => r.once('route', () => routeVersions(r.state))[name]]))
});
// Every link input's version on a state, by LINK_INPUTS name (link: only the
// discrete and continuous ones of that link, or of each of a list): a digest
// of the input's value (no counter, no state identity), continuous ones the
// value itself. view: the state's stateView (the held verdict's reads) or
// linkView (no supply); spots: the catalogue the search reads (a spot without
// a center reads the bot's point); board: the board mirror (ownLines; null
// without one); mode: the caller's; income: the earning spot answer the money
// packet carries ([spot, earning], EconomyContext.incomeOutput); required:
// PersonalGearProgression.assess(state).required when the caller holds it.
function inputVersions(view, state, timestamp, { spots = null, board = null, mode = null, income = null, required = null, link = null } = {}) {
    const memo = new Map();
    const r = { view, state, timestamp, spots, board, mode, income, required, stats: state.stats || {}, kits: view.kitHashes || [],
        once: (name, read) => memo.has(name) ? memo.get(name) : memo.set(name, read()).get(name) };
    const names = !link ? Object.keys(VERSIONS) : [...new Set([link].flat().flatMap(name =>
        [...LINK_INPUTS[name].discrete, ...LINK_INPUTS[name].continuous]))];
    const out = {};
    for (const name of names) out[name] = VERSIONS[name](r);
    return out;
}
// The part of stateView the link inputs read, for a reader with no verdict
// (EconomyContext.holdRead from the basics or the party comparison).
function linkView(state, recipes = null) {
    const view = kitView(state);
    view.party = partyIdOf(state) ? state.party : null;
    view.recipes = recipes;
    return view;
}
// The route table's inputs (EconomicTrip.routeInputs): the whole key (route)
// and one version per field (LINK_INPUTS routeRows).
function routeVersions(state) {
    const route = invoke('GameServer/Bot/Economy/EconomicTrip').routeInputs(state);
    return { route: hash(route), 'route.activity': route.activity, 'route.region': route.currentRegion, 'route.loc': hash(route.loc),
        'route.scroll': route.inventory[736].amount, 'route.karma': route.stats.karma,
        'route.return': hash(route.stats.marketReturn), 'route.travel': hash(route.stats.travel) };
}
// The first input of a link that moved between two inputVersions, '' when
// none: a discrete one by its version, a continuous one outside the answer's
// own range where it carries one (bounds: name -> [low, high], as the held
// earning spot's weights), else beyond the relative error (the bot's own, as
// the observation event reads it).
function movedInput(link, before, now, error = 0, bounds = null) {
    const inputs = LINK_INPUTS[link];
    for (const name of inputs.discrete) if (before[name] !== now[name]) return name;
    for (const name of inputs.continuous) {
        const was = Number(before[name]), is = Number(now[name]), range = bounds?.[name];
        if (range ? !(is >= range[0] && is <= range[1])
            : !Object.is(was, is) && !(Math.abs(is - was) <= Math.abs(was) * error)) return name;
    }
    return '';
}
// The names of the sections raised in wishDirty bits, in table order.
function sectionNames(bits) {
    const names = [];
    for (let at = 0; at < SECTIONS.length; at++) if (bits & 1 << at) names.push(SECTIONS[at]);
    return names;
}
// The kit fact of a view: class, level, worn gear, hennas, skills, the hot
// capture (view.kitHashes: ColdCombatProfile.kitHash of combatView's parts,
// hashed once per view), the craft
// (level, station, workshop), the soul crystal quest and the karma flip that
// closes the towns. Effects and night are no economy input, so a buff or the
// day/night flip moves no fact; the clan is a relations fact; the recipe book
// is its own fact. Its parts do not read the clock.
function kitFact(view) {
    return hash([view.kitHashes, view.craftLevel, view.craftStationId, view.workshop,
        view.soulCrystalQuest, view.closesTowns]);
}
// The kit part of the far reader (stateView), without the bag scan.
function kitView(state) {
    const stats = state.stats || {};
    return { kitHashes: CombatProfile.kitHash(CombatProfile.combatView(state)), craftLevel: Number(state.craftLevel ?? stats.dwarvenCraftLevel) || 0,
        craftStationId: stats.craftStationId ?? null, workshop: stats.workshop,
        soulCrystalQuest: !!stats.soulCrystalQuest, closesTowns: Karma.closesTowns(stats.karma) };
}
function kit(state) {
    return kitFact(kitView(state));
}
function fundingMark(state, escrow = 0) {
    const packet = state.stats?.money;
    if (!Array.isArray(packet)) return 0;
    const wallet = PurchaseFunding.budget(state, escrow) - positive(Packet.survivalReserve(packet));
    const funded = [];
    for (let row = 0, rows = Packet.fundedRows(packet); row < rows; row++) funded.push(wallet >= positive(Packet.fundedCumulative(packet, row)));
    // Items or adena on their way from the board are a board-side money fact.
    return hash([wallet >= 0, ...funded, PurchaseFunding.moneyReached(state, escrow), state.incomingPending === true]);
}
function reachesUpper(wallet, bounds) {
    const high = bounds?.[1];
    return high !== null && high !== undefined && wallet >= high;
}
// Hard (allowSoft false): the held option became unaffordable or its
// funding/obligation mark moved. Soft: a newly payable next wish or a drift
// beyond the bot's error (the soft point's, softEvents).
function moneyChanged(state, baseline, escrow, allowSoft) {
    if (!baseline) return false;
    const physicalWallet = positive(state.adena), budgetTracked = Array.isArray(baseline.budgetBounds);
    const decisionBudget = budgetTracked ? PurchaseFunding.budget(state, escrow) : physicalWallet;
    // Old saved decisions recorded both kinds of edge in physical cash. Keep
    // that conservative comparison until an actual build supplies both bounds.
    if (physicalWallet < Number(baseline.cashBounds?.[0] ?? -1)
        || budgetTracked && decisionBudget < Number(baseline.budgetBounds[0])
        || baseline.funding !== fundingMark(state, budgetTracked ? escrow : 0)) return true;
    return allowSoft && (moneyBound(state, baseline, escrow)
        || Number(baseline.moneyError) >= 0
            && Math.abs(decisionBudget - baseline.wallet) > baseline.moneyError);
}
// The wallet or the budget reached the decision's next wish (its upper bound):
// the soft money event without the drift. A solo hunt window ends here
// (ColdSoloWindow); the drift waits for the soft point at its end.
function moneyBound(state, baseline, escrow = 0) {
    if (!baseline) return false;
    return reachesUpper(positive(state.adena), baseline.cashBounds) || Array.isArray(baseline.budgetBounds)
        && reachesUpper(PurchaseFunding.budget(state, escrow), baseline.budgetBounds);
}
// At work a bot watches what its goal costs (decision 11-02), not each price its
// last review read: the rest and the town read those.
function goalReached(state, baseline, escrow = 0) {
    return baseline?.goalBudget > 0 && PurchaseFunding.budget(state, escrow) >= baseline.goalBudget;
}
// The wallet reached what the bot watches where it stands.
function moneyReached(state, baseline, escrow = 0) {
    return Situations.hears('money', Situations.place(state)) ? moneyBound(state, baseline, escrow) : goalReached(state, baseline, escrow);
}
function meaningfulMoney(state, baseline = state.stats?.wishSections, escrow = 0) {
    return moneyChanged(state, baseline, escrow, true);
}
function baselineIdentity(baseline) {
    const canonical = (value, depth = 0) => {
        if (depth > 8) throw new TypeError('decision_baseline_depth');
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (Array.isArray(value)) return ['array', value.map(row => canonical(row, depth + 1))];
        if (value && typeof value === 'object') return ['object', Object.keys(value).sort()
            .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key], depth + 1)])];
        throw new TypeError('decision_baseline_value');
    };
    try {
        if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return null;
        const rows = sampleRows(Object.hasOwn(baseline, 'sample') ? baseline.sample : []);
        if (!observationBaselineValid(baseline, rows)) return null;
        if (Object.hasOwn(baseline, 'sample')) {
            baseline = { ...baseline, sample: rows };
        }
        return createHash('sha256').update(JSON.stringify(canonical(baseline))).digest('hex');
    } catch (error) { FailureLog.note('economy.codec:baseline_identity', error); return null; }
}
function carrySectionBaseline(previous, current, updated) {
    if (!previous || !Number.isFinite(previous.at) || current.at < previous.at) return current;
    const carry = (mask, fields) => {
        if (updated & mask) return;
        for (const name of fields) {
            if (Object.hasOwn(previous, name)) current[name] = previous[name];
            else delete current[name];
        }
    };
    carry(sectionBit('money'), ['wallet', 'cashBounds', 'budgetBounds', 'goalBudget', 'funding', 'moneyError']);
    carry(sectionBit('occupation') | sectionBit('build'), ['sample', 'share', 'incomeError', 'frustration', 'bond']);
    carry(sectionBit('money') | sectionBit('sources') | sectionBit('supply'), ['bagValue']);
    return current;
}
function incomeError(state, persona) {
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    return Learning.knowledgeEnabled() ? Learning.stageError(Learning.INCOME_ERROR_FLOOR + .25 * (1 - Number(persona?.understanding ?? .3)),
        Learning.INCOME_ERROR_FLOOR, state.stats?.lifelongKills ?? state.stats?.fightsWon ?? 0, Learning.gradeOfLevel(state.level)) : 0;
}
// A sample row: the spot, exp and net income per ms of its cycle.
function sampleOf(rows) {
    return rows.map(row => [hash(row.spotId), row.exp / row.cycleMs,
        (positive(row.adena) + positive(row.loot) - positive(row.costs)) / row.cycleMs]);
}
function sample(state, timestamp = Date.now(), mode) {
    return sampleOf(Hunt.sampledRows(state, timestamp, mode));
}
// noise: each current row's own noise (BotHuntEfficiency.record); a drift
// inside the larger of the bot's error and that noise is no change. Rows
// match by spot hash: a round moves its spot's row to the front of the list
// (BotHuntEfficiency.record), which is no change of any value. noise is
// indexed like current.
function learnedChange(current, previous, error, share, previousShare, noise = []) {
    if (current.length !== previous.length) return true;
    const before = new Map(previous.map(row => [row[0], row]));
    return current.some((row, at) => !before.has(row[0]) || row.slice(1).some((value, index) => {
        const old = Number(before.get(row[0])[index + 1]) * previousShare;
        return !Number.isFinite(old) || Math.abs(value * share - old) > Math.abs(old) * Math.max(error, noise[at] || 0);
    }));
}
// The learned frustration the decision weighed its risk with (riskWeight's
// 1 + frustration), rounded: the baseline holds a few bytes.
const frustrationOf = state => Math.round(positive(state.stats?.frustration) * 1000) / 1000;
// bondNow: the caller's reader of the current relation bond
// (WishProviders.relationBond), called only once the rest held; null when the
// caller read no memory. The bond, like frustration, drifts beyond the error.
function bondChanged(baseline, bondNow, error) {
    const base = baseline.bond;
    if (!Array.isArray(base) || typeof bondNow !== 'function') return false;
    const bond = bondNow();
    return Array.isArray(bond) && bond.some((value, at) => Math.abs(value - Number(base[at])) > Math.abs(Number(base[at])) * error);
}
function observationChanged(state, baseline, timestamp, mode, bondNow = null) {
    if (!baseline) return true;
    const rows = Hunt.sampledRows(state, timestamp, mode), current = sampleOf(rows);
    const previous = sampleRows(Object.hasOwn(baseline, 'sample') ? baseline.sample : []);
    const share = Hunt.onSpotShare(state), previousShare = baseline.share ?? 1;
    const error = positive(baseline.incomeError);
    // Frustration drifts every round; it is an event only beyond the bot's
    // error on its risk weight (a baseline saved before it has none).
    const frustration = Number(baseline.frustration);
    return !observationBaselineValid(baseline, previous) || !Number.isFinite(share)
        || Math.abs(share - previousShare) > previousShare * error
        || Number.isFinite(frustration) && Math.abs(frustrationOf(state) - frustration) > (1 + frustration) * error
        || learnedChange(current, previous, error, share, previousShare, rows.map(row => positive(row.noise)))
        || bondChanged(baseline, bondNow, error);
}
function bounds(wallet) {
    const result = [-1, null];
    return { result, watch: price => {
        price = Number(price);
        if (!Number.isFinite(price) || price < 0) return;
        if (price <= wallet) result[0] = Math.max(result[0], price);
        else result[1] = result[1] === null ? price : Math.min(result[1], price);
    } };
}
// facts: the build's semanticFacts(state) when its caller already has them.
// bond: the build's relation bond (WishProviders.relationBond), null without one.
// threat: the gear-threat mask the build weighed (context.gearThreatMask),
// compared hard by the held verdict. marketWatch: the build's watch rows
// [itemId, storeType, reference price, error] (at most MARKET_WATCH), read by
// the soft point (softEvents); recorded by every build, never carried.
function snapshot(state, context, cashBounds, moneyError = -1, mode, money = null, facts = null, bond = null, marketWatch = null) {
    const persona = context.persona;
    const actual = { ...state, stats: { ...state.stats, money: context.statsPacket.money } };
    const budgetTracked = Array.isArray(money?.budgetBounds), escrow = budgetTracked ? money.buyOrderEscrow : 0;
    // budgetBounds tags the budget-aware schema. Its wallet/error use total
    // purchase funds; cashBounds still records physical fees. Old wallets are cash.
    const wallet = budgetTracked ? PurchaseFunding.budget(state, escrow) : positive(state.adena);
    const share = Hunt.onSpotShare(state);
    return { at: Number(context.timestamp), wallet, cashBounds, funding: fundingMark(actual, escrow), moneyError,
        ...(budgetTracked ? { budgetBounds: money.budgetBounds } : {}),
        ...(context.goalBudget > wallet ? { goalBudget: context.goalBudget } : {}),
        bagValue: positive(context.choiceBagValue),
        ...(facts || semanticFacts(state)), threat: context.gearThreatMask,
        frustration: frustrationOf(state), ...(bond ? { bond } : {}),
        incomeError: incomeError(state, persona), sample: packSample(sample(state, context.timestamp, mode)),
        ...(share === 1 ? {} : { share }), ...(marketWatch?.length ? { marketWatch } : {}) };
}
// The soft point (far bots, the end of every step): the sections whose soft
// inputs crossed the bot's own error since its decision, empty when quiet;
// no clock: a drift inside the error is never an event, however long.
// baseline: the decision's (stats.wishSections). input: { board (the board
// mirror, null: not ready, the market part waits), buyOrderEscrow, memory (a
// reader of the bot's memory rows, called only when the bond is compared),
// timestamp (the step's) }. before: the state the step left (arriving in town).
function softEvents(state, baseline, input, before = null) {
    if (!baseline) return NONE;
    let sections = NONE;
    // Diagnostics only: soft:step:far counts the soft points, soft:raise:<source>
    // the raises by source (the observation share per far step is read live).
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('soft', 'step', 'far');
    const where = Situations.place(state, before);
    const add = source => {
        const names = Situations.raise([source], where);
        sections = sections === NONE ? [...names] : [...new Set([...sections, ...names])];
        if (diagnostic) Diagnostics.count('soft', 'raise', source);
    };
    if (Situations.hears('money', where) && meaningfulMoney(state, baseline, input.buyOrderEscrow)) add('money');
    else if (goalReached(state, baseline, input.buyOrderEscrow)) add('goal');
    const bondNow = () => Providers.relationBond(state, { memory: input.memory?.() ?? null });
    if (Situations.hears('observation', where) && observationChanged(state, baseline, input.timestamp, undefined, bondNow)) add('observation');
    if (input.board && marketCrossed(input.board, baseline.marketWatch, Number(state.characterId))) add('market');
    return sections;
}
const NONE = Object.freeze([]);
// The watch rows against the board mirror, one head read per row: a sell line
// (SELL) below the reference by more than the error, or a buy line (BUY)
// above it by more than the error. Rows of another shape
// (a baseline saved by an older build) are skipped.
const MARKET_WATCH = 20;
function marketCrossed(board, watch, ownerId) {
    if (!Array.isArray(watch)) return false;
    const exclude = { excludeOwner: ownerId };
    for (let at = 0; at < watch.length && at < MARKET_WATCH; at++) {
        const row = watch[at];
        if (!Array.isArray(row)) continue;
        const [itemId, storeType, price, error] = row;
        if (!(itemId > 0) || !(price > 0) || !(error >= 0)) continue;
        const line = board.first(itemId, storeType, exclude);
        if (!line) continue;
        if (storeType === SELL ? line.price < price * (1 - error) : storeType === BUY && line.price > price * (1 + error)) return true;
    }
    return false;
}
// Who the friend and the enemy are (WishProviders.relationTargets over the
// bot's memory), not how much: their trust and hostility are the soft bond.
function relationTargetIds(state, memory = null) {
    const { friend, enemy } = Providers.relationTargets(state, { memory });
    return [friend?.targetId ?? null, enemy?.targetId ?? null];
}
// The one fact function, for near and far bots alike: what about the bot's
// world changed is the fact that differs from the copy kept with the
// decision (Situations.detect, factNames). The raw values are read from a state (stateView):
// the saved one of a far bot, the posted row of a near one. view: the kit
// fields (kitView), recipes (the sorted
// known recipe ids, null: none read), party (null: none; its partyId and
// role are the fact, its leaderId is not), clanId,
// relationTargets ([friend, enemy] ids; null: read here from memory), activity,
// spotId, stats.travel (occupationPlanned's shape) and stats.relations (the
// fallback rows without memory), dead, riskDeaths, recovery (the death
// recovery's level penalty, SpotRiskPolicy.recoveryFor), supply ([id, present] per
// stock item), stores (four identities), bagFull, weight (level 0-4).
// memory: the bot's interaction memory rows, null when the caller read none.
function factsOf(view, memory = null) {
    return { build: kitFact(view), level: view.kitHashes?.[2] ?? null, recipes: view.recipes ? hash(view.recipes) : null,
        relations: hash([view.clanId, ...(view.relationTargets || relationTargetIds(view, memory))]),
        party: hash([view.party?.partyId, view.party?.role]),
        occupation: hash([view.spotId, view.activity === 'resting' ? 'hunting' : view.activity]),
        dead: view.dead, riskDeaths: view.riskDeaths, recovery: view.recovery, supply: hash(view.supply), stores: hash(view.stores), warehouse: view.warehouse,
        bag: hash([view.bagFull, view.weight]) };
}
// The party fact of a bot in none (factsOf).
const NO_PARTY = hash([null, null]);
// What the survival drink keeps of the planned potion (its stock target).
const potionSurvivalTarget = state => Number(Packet.potionSurvivalTarget(state.stats?.stockTargets)) || 0;
// The stock items whose presence is the supply fact: the trip's Scroll of
// Escape (736), the planned shot, the planned healing potion.
function stockIds(shotPlan, potion) {
    return [736, shotPlan.selfId, potion.selfId];
}
// The far reader: the raw values of a saved state. recipes: the known recipe
// ids the build reads (WishProviders.recipeIds), null when the caller holds
// no recipe book. One bag scan gives the bag full and the load.
function stateView(state, recipes = null) {
    const stats = state.stats || {};
    const view = kitView(state);
    const partyId = partyIdOf(state);
    const bag = Floor.stateInventory(state, DataCache.items);
    view.recipes = recipes;
    view.party = partyId ? state.party : null;
    view.clanId = Number(state.clanId ?? stats.clanId ?? 0);
    view.relationTargets = null;
    view.activity = state.activity;
    view.spotId = state.spotId;
    view.stats = { travel: stats.travel, relations: stats.relations };
    view.dead = Number(state.activity === 'dead' || Number(state.vitals?.hp) <= 0);
    view.riskDeaths = positive(stats.spotRisk?.windowDeaths);
    view.recovery = positive(invoke('GameServer/Bot/Population/SpotRiskPolicy').recoveryFor(state)?.levelPenalty);
    const shots = ShotStock.planForState(state);
    const potion = HealingPotionStock.purchasePotionFor(state);
    view.supply = stockIds(shots, potion).map(id => [id, positive(state.inventory?.[id]?.amount) > 0]);
    view.stores = storesOf(state);
    view.warehouse = Warehouse.contentIdentity(state);
    // The bag full: its slot limit (the full-bag sale itself is SurvivalFloor's).
    view.bagFull = Number(bag.slots >= InventoryLimits.forState(state));
    // The kit profile store reads the kit by the hashes this view already holds.
    view.weight = Floor.weightPenalty(bag.load,
        CombatProfile.profileFor(state, Date.now(), { kitHashes: view.kitHashes }).maxLoad);
    return view;
}
// What the bot's clan asks of it and holds for it: the clan's material demand, the clan
// supply, whether the clan has a warehouse, the clan goal's crystals. The personal
// warehouse is its own fact: the bot's own doing, read in town (Situations, warehouse).
// owner: { characterId, clanId, stats } (a state is one); into: the array written (the
// near reader's, updated in place).
function storesOf(owner, into = new Array(3)) {
    // A far member hears what its clan asks for, not how much is left.
    const demand = owner.stats?.clanMaterialDemand ?? null, request = Situations.reactive(owner);
    into[0] = request && demand ? Object.keys(demand) : demand;
    into[1] = request ? ClanSupply.requestIdentity(owner) : ClanSupply.contentIdentity(owner); into[2] = ClanSupply.hasWarehouse(owner);
    const crystals = owner.stats?.equipmentPlan?.clanGoal?.clanId && require('./ClanCrystalSupply').identity(owner);
    if (crystals) into[3] = crystals;
    else into.length = 3;
    return into;
}
// memory: the bot's interaction memory (the caller's deps.memory), null when
// the caller read none. recipes: as stateView's.
function semanticFacts(state, memory = null, recipes = null) {
    return factsOf(stateView(state, recipes), memory);
}
// A retained calculation accepts its own decision output, not a foreign
// leaf or focus that happens to share the same sequence. Scalars also let
// the cache compare its original unpublished input without another object.
function decisionRefusal(state, decisionSeq, activityLeaf, focus) {
    const stats = state.stats || {};
    if (Number(stats.decisionSeq || 0) !== decisionSeq) return 'decision_seq';
    if (Number(stats.activityLeaf || 0) !== activityLeaf) return 'activity_leaf';
    if ((stats.wishFocus?.[0] ?? null) !== focus) return 'wish_focus';
    return '';
}
function isEmptyWishPlan(plan) {
    return plan?.status === 'deferred' && plan.strategy === 'none'
        && plan.next == null && plan.reason === 'wish_focus'
        && Object.keys(plan).every(key => ['status', 'strategy', 'next', 'reason'].includes(key));
}
// The one reading of an occupation against the held leaf (Recompute: own
// outputs are not inputs): the trip the leaf ordered under way (to its
// hunting spot arriving to hunt, or to its town), or the arrival where it
// led (its hunting spot, hunting or resting there; else its own activity).
// The route's detour around the leaf's full hunting spot stands in for it
// (BotRoute.trip decides which trip is one): the trip names the leaf's spot
// (travel.leafSpotId), the arrival keeps the pair leaf spot + ground reached
// (stats.standIn, BackgroundResolver.resolveTravel), the leaf's own arrival
// while the bot stands on that ground.
// A far bot (Situations, own_move) owns more: hunting or resting on any ground,
// and any trip but a forced one (FORCED_TRIPS: a flight, a death pressure, a
// pushed-out spot, a party's call), so a pull to another spot or a flight's
// arrival raises nothing there. Near a player only the leaf's own trip and
// arrival are; death, recall, a pull, a flight or a yield stay events. Read by
// the held build's verdict and by the far step's round check (Situations.factNames'
// planned); its field-trip clause is EconomyContext.fieldActivity's.
function occupationPlanned(state, leaf) {
    const where = Situations.place(state);
    if (ownMove(state, where) && !Situations.hears('own_move', where)) return true;
    if (!leaf?.activity) return false;
    const hunt = leaf.activity === 'hunting';
    if (state.activity === 'traveling') {
        const travel = state.stats?.travel;
        if (!travel) return false;
        return hunt && leaf.spotId != null ? (ownSpot(travel.spotId, leaf) || ownSpot(travel.leafSpotId, leaf))
            && travel.arrivalActivity === 'hunting' && travel.townName == null
            : leaf.town != null && travel.townName != null && String(travel.townName) === String(leaf.town);
    }
    // A hunting leaf without a spot names no arrival: any spot is an event.
    if (hunt) return leaf.spotId != null && (state.activity === 'hunting' || state.activity === 'resting')
        && (ownSpot(state.spotId, leaf) || standsIn(state, leaf));
    return state.activity === leaf.activity;
}
// A trip the bot took itself, out or back, and the ground it reached (the trip's
// start was its event); a flight, a pushed-out spot or a party's call is the world's.
const FORCED_TRIPS = new Set(['unsafe_ground_evacuation', 'death_pressure_replan', 'party_spot_replan']);
function ownMove(state, where) {
    if (state.activity !== 'traveling') return Situations.field(where);
    const travel = state.stats?.travel;
    return !!travel && !travel.cause && !FORCED_TRIPS.has(travel.reason);
}
function ownSpot(spotId, leaf) {
    return spotId != null && String(spotId) === String(leaf.spotId);
}
// The bot stands on the ground its detour for the leaf's spot reached.
function standsIn(state, leaf) {
    const pair = state.stats?.standIn;
    return pair?.ground != null && String(pair.ground) === String(state.spotId) && ownSpot(pair.leaf, leaf);
}
// The kit fact each economy build records in its baseline moved between two
// states of one bot: a party member's kit event. A party member's step raises
// no hard event (they run in hunting rounds only); its own post-round build
// names the kit change in its baseline instead. A step with no build (a held
// decision) keeps the baseline, so it reads as no move.
function kitMoved(before, after) {
    return (before?.stats?.wishSections?.build ?? null) !== (after?.stats?.wishSections?.build ?? null);
}
module.exports = { FIELD_ACTIVITIES, partyIdOf, moneyReached, goalReached, SECTIONS, COMPUTED, LINK_INPUTS, inputVersions, linkView, routeVersions, movedInput, shotInputs, stateView, sectionBit, sectionMask, sectionNames, kit, kitMoved, moneyChanged, moneyBound, observationChanged, incomeError,
    MARKET_WATCH, softEvents, marketCrossed, carrySectionBaseline, baselineIdentity, sample, sampleRows, packSample, observationBaselineValid, bounds, snapshot, semanticFacts, factsOf, relationTargetIds, NO_PARTY, potionSurvivalTarget, fundingMark, occupationPlanned, hash, isEmptyWishPlan, decisionRefusal };
