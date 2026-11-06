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
const ClanSupply = require('../../Clan/ClanSupplyPolicy');
const Providers = require('./WishProviders');
const Situations = require('../Situations');
const Stall = require('../AI/GearStall');
const { FIELD_ACTIVITIES } = Situations;
const partyIdOf = state => String(state.party?.partyId || state.partyId || '');
const CombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const positive = n => Math.max(0, Number(n) || 0);
const hash = value => fnv1a32(JSON.stringify(value));
// The decision links: the inputs
// each link reads, by inputVersions name. The workshop decides on them
// (EconomyContext.workshopKeyHolds); the
// route rows are measured only (EconomyContext's link shadow, developerDiagnostics).
// discrete: a version compared exactly; continuous: a value compared inside
// the answer's own range, else beyond the bot's own error (movedInput);
// events: what the link reads with no version, standing on an event bit or on
// nothing (a window).
const linkOf = (discrete, continuous, events) => Object.freeze({ discrete: Object.freeze(discrete),
    continuous: Object.freeze(continuous), events: Object.freeze(events) });
const LINK_INPUTS = Object.freeze({
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
// What a bot's fight reads of the bag (PartyGoalPolicy's forming key): the shot its consumable prices name
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
// One reader per link input over one call's reads (r: the view, the state,
// the options; what several inputs share is read once, r.once).
const VERSIONS = Object.freeze({
    'kit.class': r => hash([r.kits[0], r.kits[1]]), 'kit.level': r => r.kits[2],
    craft: r => hash([r.view.craftLevel, r.view.craftStationId ?? null, r.view.workshop?.entries ?? null]),
    crafter: r => r.once('crafter', () => require('./CraftEligibility').isServiceCrafter(r.state)),
    recipes: r => r.view.recipes ? hash(r.view.recipes) : null,
    maxMp: r => Number(r.state.vitals?.maxMp) || 0,
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
// value itself. view: the state's stateView (the held verdict's reads);
// board: the board mirror (ownLines; null without one); income: the earning
// spot's held answer ([spot, earning], EconomyContext.earningInput).
function inputVersions(view, state, timestamp, { board = null, income = null, link = null } = {}) {
    const memo = new Map();
    const r = { view, state, timestamp, board, income, stats: state.stats || {}, kits: view.kitHashes || [],
        once: (name, read) => memo.has(name) ? memo.get(name) : memo.set(name, read()).get(name) };
    const names = !link ? Object.keys(VERSIONS) : [...new Set([link].flat().flatMap(name =>
        [...LINK_INPUTS[name].discrete, ...LINK_INPUTS[name].continuous]))];
    const out = {};
    for (const name of names) out[name] = VERSIONS[name](r);
    return out;
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
// The kit fact of a view: class, level, worn gear, hennas, skills, the hot
// capture (view.kitHashes: ColdCombatProfile.kitEvents, a hash of each of combatView's parts,
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
    return { kitHashes: CombatProfile.kitEvents(state), craftLevel: Number(state.craftLevel ?? stats.dwarvenCraftLevel) || 0,
        craftStationId: stats.craftStationId ?? null, workshop: stats.workshop,
        soulCrystalQuest: !!stats.soulCrystalQuest, closesTowns: Karma.closesTowns(stats.karma) };
}
function kit(state) {
    return kitFact(kitView(state));
}
// The build's money thresholds (situations.md §14, F3; step 4 C7): its wallet is read
// when it decides and wakes nothing else. goal_affordable:<kind> as the budget stands at
// or above the build's threshold (baseline.affordAt { at, kind }, affordAtOf), out_of_money
// as it stands below the held leaf's funded row (baseline.fundedAt: the cumulative cost
// the money queue held for its root). budget: PurchaseFunding.budget (the escrow in it).
function goalReached(state, baseline, escrow = 0) {
    const afford = baseline?.affordAt ?? (baseline?.goalBudget > 0 ? { at: baseline.goalBudget, kind: 'focus' } : null);
    return afford?.at > 0 && PurchaseFunding.budget(state, escrow) >= afford.at ? afford.kind : null;
}
// The money situations of the wallet now against the decision's armed thresholds
// (detect: a far step, a body's post). One comparison per step with the wallet as it
// stands, so money main adds between steps (an AFK sale paid, an escrow returned, a
// meeting settled) is heard at the next one. Each is raised once per baseline: raised
// is the mark kept with the bot ({ at: the baseline's time, afford, out }:
// stats.moneyRaised, a body's previous post), and the next build re-arms both (its
// baseline's own time; a build arms affordAt only above the wallet, fundedAt only within it).
// Returns { names, raised }: the names to raise and the mark to keep.
function moneyCrossings(wallet, baseline, raised = null) {
    const names = [];
    if (!baseline || !Number.isFinite(wallet)) return { names, raised };
    const at = Number(baseline.at) || 0, held = raised?.at === at ? raised : null;
    const afford = baseline.affordAt;
    const reached = afford?.at > 0 && wallet >= afford.at && !held?.afford;
    const short = baseline.fundedAt > 0 && wallet < baseline.fundedAt && !held?.out;
    if (reached) names.push(`goal_affordable:${afford.kind}`);
    if (short) names.push('out_of_money');
    return { names, raised: names.length ? { at, afford: !!held?.afford || reached, out: !!held?.out || short } : raised };
}
// What the wallet waits to reach, the first of (situations.md §14, B7, B4): a broke
// bot's survival potions (the money for their missing line, the search's broke
// rule: it re-opens buying them and the spots that need them), an unarmed bot's
// weapon bridge (its price from the whole wallet, WishProviders' survival wish:
// survival), its focus (the goal's cumulative cost). Re-armed by each build.
function affordAtOf(context, wallet) {
    const potions = context.stock?.('potions');
    if (potions && potions.current < potions.line) {
        // The search's broke rule's own threshold (EquipmentIncomeRoute.drinksAt, cannotDrink).
        const at = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').drinksAt(potions.line, potions.current, potions.survivalPrice);
        if (at > wallet) return { at, kind: 'potions' };
    }
    const bridge = context.weaponBridge;
    if (bridge?.price > wallet) return { at: bridge.price, kind: 'survival' };
    return context.goalBudget > wallet ? { at: context.goalBudget, kind: 'focus' } : null;
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
        return createHash('sha256').update(JSON.stringify(canonical(baseline))).digest('hex');
    } catch (error) { FailureLog.note('economy.codec:baseline_identity', error); return null; }
}
function incomeError(state, persona) {
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    return Learning.knowledgeEnabled() ? Learning.stageError(Learning.INCOME_ERROR_FLOOR + .25 * (1 - Number(persona?.understanding ?? .3)),
        Learning.INCOME_ERROR_FLOOR, state.stats?.lifelongKills ?? state.stats?.fightsWon ?? 0, Learning.gradeOfLevel(state.level)) : 0;
}
// The build's baseline (stats.wishSections): its time, its money thresholds (affordAt,
// fundedAt), its income error (the party forming's), the facts it decided on (the
// step's diff compares against them) and its kit lines. facts: the build's
// semanticFacts(state) when its caller already has them.
function snapshot(state, context, money = null, facts = null) {
    const wallet = PurchaseFunding.budget(state, money?.buyOrderEscrow || 0);
    const afford = affordAtOf(context, wallet);
    return { at: Number(context.timestamp), ...(afford ? { affordAt: afford } : {}),
        ...(context.leafBudget > 0 && context.leafBudget <= wallet ? { fundedAt: context.leafBudget } : {}),
        ...(facts || semanticFacts(state)), ...supplyFacts(state, context.statsPacket.kitRates, context.earning),
        incomeError: incomeError(state, context.persona) };
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
// recovery's level penalty, SpotRiskPolicy.recoveryFor), karma (1 while it has any:
// the karma wash, ColdKarmaPolicy.active), supply ([id, present] per
// stock item), stores (four identities), bagNeed (the bag fact: 2 at its floor, 1 at a
// cleanup count, PartyMarketBreak.bagFact).
// memory: the bot's interaction memory rows, null when the caller read none.
function factsOf(view, memory = null) {
    return { build: kitFact(view), level: view.kitHashes?.[2] ?? null, recipes: view.recipes ? hash(view.recipes) : null,
        relations: hash([view.clanId, ...(view.relationTargets || relationTargetIds(view, memory))]), clan: view.clanId,
        party: hash([view.party?.partyId, view.party?.role]),
        occupation: hash([view.spotId, view.activity === 'resting' ? 'hunting' : view.activity]),
        dead: view.dead, riskDeaths: view.riskDeaths, recovery: view.recovery, karma: view.karma,
        lines: linesOf(view.supply), stores: hash(view.stores),
        bag: hash([view.bagNeed]), bagNeed: view.bagNeed, kills: view.kills, stall: view.stall };
}
// The party fact of a bot in none (factsOf).
const NO_PARTY = hash([null, null]);
// The supply fact: per kind [kind, itemId, where the count stands against
// its line] (LINE_ABOVE, LINE_BELOW: under one hour of use, LINE_OUT: none
// left of a kind the bot uses), the line the kit rates' (StatsPacket.lineOf).
// Shots count the paid shot and the beginner grant a fight loads first. The
// Scroll of Escape has no line (situations.md B2). A bot no build rated has none.
const LINE_ABOVE = 0, LINE_BELOW = 1, LINE_OUT = 2;
function supplyOf(state) {
    // The spot's use by the one rule (EquipmentIncomeRoute.spotUseOf: the answer's on its spot, else the table's).
    const rates = state.stats?.kitRates, earning = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').spotUseOf(state);
    const plan = ShotStock.planForState(state);
    const potionId = Number(HealingPotionStock.purchasePotionFor(state).selfId);
    const row = (kind, itemId, count) => {
        const line = Packet.lineOf(rates, earning, kind);
        return [kind, itemId, !(line > 0) ? LINE_ABOVE : count <= 0 ? LINE_OUT : count < line ? LINE_BELOW : LINE_ABOVE];
    };
    return [row('shots', Number(plan.selfId), positive(state.inventory?.[plan.selfId]?.amount) + ShotStock.beginnerAmount(state, plan)),
        row('potions', potionId, positive(state.inventory?.[potionId]?.amount))];
}
// The supply facts against the kit rates and earning answer a build publishes
// (snapshot): its baseline reads its own lines, so publishing them raises nothing.
function supplyFacts(state, kitRates, earning) {
    const stats = { ...state.stats, ...(kitRates ? { kitRates } : {}), ...(earning !== undefined ? { earning } : {}) };
    const supply = supplyOf({ ...state, stats });
    return { lines: linesOf(supply) };
}
// The lines fact (factsOf): the shots' and the potions' place against their line, one number.
const linesOf = supply => (supply?.[0]?.[2] || 0) * 3 + (supply?.[1]?.[2] || 0);
// One kind's place in a lines fact (Situations.factNames).
const lineAt = (lines, kind) => kind === 'shots' ? Math.floor(lines / 3) : lines % 3;
// lazy: the market break reads the disposition rules, which read this module.
let MarketBreak = null;
// The far reader: the raw values of a saved state. recipes: the known recipe
// ids the build reads (WishProviders.recipeIds), null when the caller holds
// no recipe book.
function stateView(state, recipes = null) {
    const stats = state.stats || {};
    const view = kitView(state);
    const partyId = partyIdOf(state);
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
    view.karma = Number(Number(stats.karma) > 0);
    // The kill count and the gear plan's stall (GearStall: source_stalled at the crossing).
    view.kills = Stall.killsOf(state); view.stall = Stall.stallKills(state);
    view.supply = supplyOf(state);
    view.stores = storesOf(state);
    // What the bag holds against its floor and its cleanup counts (situations.md F2:
    // PartyMarketBreak.bagFact, no price, board or clock); its rise raises bag_full.
    view.bagNeed = (MarketBreak ||= invoke('GameServer/Bot/Population/PartyMarketBreak')).bagFact(state, view.kitHashes);
    return view;
}
// What the bot's clan asks of it and holds for it: the clan's material demand, the clan
// supply, whether the clan has a warehouse, the clan goal's crystals. The personal
// warehouse is the bot's own doing: no fact.
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
// A far bot (a gated place, Situations) owns more: hunting or resting on any ground,
// and any trip but a forced one (FORCED_TRIPS: a flight, a death pressure, a
// pushed-out spot, a party's call), so a pull to another spot or a flight's
// arrival raises nothing there. Near a player only the leaf's own trip and
// arrival are; death, recall, a pull, a flight or a yield stay events. Read by
// the held build's verdict and by the far step's round check (Situations.factNames'
// planned); its field-trip clause is EconomyContext.fieldActivity's.
function occupationPlanned(state, leaf) {
    const where = Situations.place(state);
    // Far from a player (a gated place) its own move is no event.
    if (ownMove(state, where) && Situations.gated(where)) return true;
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
module.exports = { FIELD_ACTIVITIES, partyIdOf, goalReached, moneyCrossings, LINK_INPUTS, inputVersions, routeVersions, movedInput, shotInputs, stateView, kit, kitMoved, incomeError,
    baselineIdentity, snapshot, semanticFacts, factsOf, relationTargetIds, NO_PARTY, LINE_BELOW, LINE_OUT, lineAt, supplyOf, linesOf, occupationPlanned, hash, isEmptyWishPlan, decisionRefusal };
