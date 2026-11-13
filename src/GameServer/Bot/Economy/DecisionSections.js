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
const GradeRule = require('../AI/GearGradeRule');
const { FIELD_ACTIVITIES } = Situations;
const partyIdOf = state => String(state.party?.partyId || state.partyId || '');
const CombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const positive = n => Math.max(0, Number(n) || 0);
const hash = value => fnv1a32(JSON.stringify(value));
// The decision links: the inputs each link reads. The route rows are measured only
// (EconomyContext's link shadow, developerDiagnostics). discrete: a version compared
// exactly; continuous: a value compared inside the answer's own range, else beyond the
// bot's own error (movedInput); events: what the link reads with no version.
const linkOf = (discrete, continuous, events) => Object.freeze({ discrete: Object.freeze(discrete),
    continuous: Object.freeze(continuous), events: Object.freeze(events) });
const LINK_INPUTS = Object.freeze({
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
// The route table's inputs (EconomicTrip.routeInputs): the whole key (route)
// and one version per field (LINK_INPUTS routeRows).
function routeVersions(state) {
    const route = invoke('GameServer/Bot/Economy/EconomicTrip').routeInputs(state);
    return { route: hash(route), 'route.activity': route.activity, 'route.region': route.currentRegion, 'route.loc': hash(route.loc),
        'route.scroll': route.inventory[736].amount, 'route.karma': route.stats.karma,
        'route.return': hash(route.stats.marketReturn), 'route.travel': hash(route.stats.travel) };
}
// The first input of a link that moved between two of its versions (routeVersions), '' when
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
// (level, station), the soul crystal quest and the karma flip that closes the
// towns. Effects and night are no economy input, so a buff or the day/night
// flip moves no fact; the clan is a relations fact; the recipe book is its own
// fact; the workshop's listing is the workshop decision's own answer (its fees
// and fills move no gear). Its parts do not read the clock.
function kitFact(view) {
    return hash([view.kitHashes, view.craftLevel, view.craftStationId,
        view.soulCrystalQuest, view.closesTowns]);
}
// The kit part of the far reader (stateView), without the bag scan.
function kitView(state) {
    const stats = state.stats || {};
    return { kitHashes: CombatProfile.kitEvents(state), gear: CombatProfile.gearOf(state),
        craftLevel: Number(state.craftLevel ?? stats.dwarvenCraftLevel) || 0, craftStationId: stats.craftStationId ?? null,
        soulCrystalQuest: !!stats.soulCrystalQuest, closesTowns: Karma.closesTowns(stats.karma) };
}
function kit(state) {
    return kitFact(kitView(state));
}
// The build's money thresholds: its wallet is read when it decides and wakes nothing
// else. goal_affordable:<kind> as the wallet stands at or above the build's threshold
// (baseline.affordAt { at, kind }, affordAtOf), out_of_money as it stands below the held
// leaf's funded row (baseline.fundedAt: the cumulative cost the money queue held for its
// root). The money situations of the wallet now against those armed thresholds
// (detect: a far step, a body's post). One comparison per step with the wallet as it
// stands, so money main adds between steps (an AFK sale paid, an escrow returned, a
// meeting settled) is heard at the next one. Raised while the wallet stands past a
// threshold: a raise on the woken build is no news, and the build it wakes re-arms both
// (a build arms affordAt only above the wallet, fundedAt only within it; the agenda's
// move drops the ones passed: unspent). Returns the names to raise. bag: the bag alone
// (PurchaseFunding.budget without the escrow), which a shop step's wait (bagAt) reads: a
// bid taken back moves money from the escrow to the bag, the wallet stays.
function moneyCrossings(wallet, baseline, bag = wallet) {
    const names = [];
    if (!baseline || !Number.isFinite(wallet)) return names;
    const afford = baseline.affordAt;
    // Potions wake the earning spot too; any other threshold is the build's alone (a
    // row saved with an older kind reads as focus).
    if (afford?.at > 0 && wallet >= afford.at) names.push(afford.kind === 'potions' ? 'goal_affordable:potions' : 'goal_affordable:focus');
    if (baseline.bagAt > 0 && bag >= baseline.bagAt && !names.includes('goal_affordable:focus')) names.push('goal_affordable:focus');
    if (baseline.fundedAt > 0 && wallet < baseline.fundedAt) names.push('out_of_money');
    return names;
}
// A held baseline taken again without a build (the agenda's move on a town visit,
// EconomyContext.advanced): the thresholds the wallet passed are spent (their raise woke
// that move), the rest stand until a build re-arms them.
function unspent(baseline, wallet, bag = wallet) {
    const reached = baseline?.affordAt?.at > 0 && wallet >= baseline.affordAt.at, short = baseline?.fundedAt > 0 && wallet < baseline.fundedAt;
    const paid = baseline?.bagAt > 0 && bag >= baseline.bagAt;
    if (!reached && !short && !paid) return baseline;
    const kept = { ...baseline };
    if (reached) delete kept.affordAt;
    if (short) delete kept.fundedAt;
    if (paid) delete kept.bagAt;
    return kept;
}
// What the wallet waits to reach, the first of: a broke
// bot's survival potions (the money for their missing line, the search's broke
// rule: it re-opens buying them and the spots that need them), an unarmed bot's
// weapon bridge (its price from the whole wallet, WishProviders' survival wish), its
// focus (the goal's cumulative cost) or, when nearer, the gear plan's market piece (its
// cumulative cost in the money queue); all wake the same decision, so all are kind focus.
// Re-armed by each build. wallet: PurchaseFunding.budget with the escrow in it.
function affordAtOf(context, wallet) {
    const potions = context.stock?.('potions');
    if (potions && potions.current < potions.line) {
        // The search's broke rule's own threshold (EquipmentIncomeRoute.drinksAt, cannotDrink).
        const at = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').drinksAt(potions.line, potions.current, potions.survivalPrice);
        if (at > wallet) return { at, kind: 'potions' };
    }
    const bridge = context.weaponBridge;
    if (bridge?.price > wallet) return { at: bridge.price, kind: 'focus' };
    // A C4 player goes to buy the piece he planned as soon as he can pay for it.
    const at = Math.min(...[context.goalBudget, context.plannedBudget].filter(cost => cost > wallet));
    return Number.isFinite(at) ? { at, kind: 'focus' } : null;
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
// fundedAt, bagAt: the least bag a shop step the queue funds but the bag cannot pay needs,
// network.bagShort, kind focus), its income error (the party forming's), the facts it
// decided on (the step's diff compares against them) and its kit lines. facts: the build's
// semanticFacts(state) when its caller already has them.
function snapshot(state, context, money = null, facts = null) {
    const wallet = PurchaseFunding.budget(state, money?.buyOrderEscrow || 0);
    const afford = affordAtOf(context, wallet);
    const bagAt = Number(context.network?.bagShort) || 0;
    return { at: Number(context.timestamp), ...(afford ? { affordAt: afford } : {}),
        ...(bagAt > PurchaseFunding.budget(state) ? { bagAt } : {}),
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
// fields (kitView; build: the whole kit, the build's caches' key; gear: the gear a
// fight turns on, ColdCombatProfile.gearOf, gear_changed), grade (the C4 expertise
// grade its level allows, GearGradeRule: grade_changed), outleveled (1 while the held
// earning spot lies past the deep-blue gap below it, SpotValueTable.outleveled:
// spot_outleveled), recipes (the sorted
// known recipe ids, null: none read), party (null: none; its partyId and
// role are the fact, its leaderId is not), clanId,
// relationTargets ([friend, enemy] ids; null: read here from memory), activity,
// spotId, stats.travel (occupationPlanned's shape) and stats.relations (the
// fallback rows without memory), dead, riskDeaths, recovery (the death
// recovery's level penalty, SpotRiskPolicy.recoveryFor), karma (1 while it has any:
// the karma wash, ColdKarmaPolicy.active), supply ([id, present] per
// stock item), stores (four identities), bagNeed (the bag fact: 2 at its floor, 1 at a
// cleanup count, PartyMarketBreak.bagFact), outgrown (the voluntary hunt floors the gear
// plan's routed source lies below, outgrownOf: source_stalled at each rise).
// memory: the bot's interaction memory rows, null when the caller read none.
function factsOf(view, memory = null) {
    return { build: kitFact(view), gear: view.gear ?? 0, grade: view.grade, outleveled: view.outleveled, recipes: view.recipes ? hash(view.recipes) : null,
        relations: hash([view.clanId, ...(view.relationTargets || relationTargetIds(view, memory))]), clan: view.clanId,
        party: hash([view.party?.partyId, view.party?.role]),
        occupation: hash([view.spotId, view.activity === 'resting' ? 'hunting' : view.activity]),
        dead: view.dead, riskDeaths: view.riskDeaths, recovery: view.recovery, karma: view.karma,
        lines: linesOf(view.supply), stores: hash(view.stores),
        bag: hash([view.bagNeed]), bagNeed: view.bagNeed, kills: view.kills, stall: view.stall, outgrown: view.outgrown };
}
// The supply fact: per kind [kind, itemId, where the count stands against
// its line] (LINE_ABOVE, LINE_BELOW: under one hour of use, LINE_OUT: none
// left of a kind the bot uses), the line the kit rates' (StatsPacket.lineOf).
// Shots count the paid shot and the beginner grant a fight loads first. The
// Scroll of Escape has no line (no survival item). A bot no build rated has none.
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
// The facts of the kit rates and earning answer a build publishes (snapshot): its
// baseline reads its own lines and its own spot, so publishing them raises nothing.
function supplyFacts(state, kitRates, earning) {
    const stats = { ...state.stats, ...(kitRates ? { kitRates } : {}), ...(earning !== undefined ? { earning } : {}) };
    const supply = supplyOf({ ...state, stats });
    return { lines: linesOf(supply), outleveled: outleveledOn(state, stats.earning) };
}
// lazy: the spot table's module reads the economy modules that read this one.
let Table = null;
const outleveledOn = (state, earning) => (Table ||= invoke('GameServer/Bot/AI/SpotValueTable')).outleveled(earning?.spotId, state.level);
// The lines fact (factsOf): the shots' and the potions' place against their line, one number.
const linesOf = supply => (supply?.[0]?.[2] || 0) * 3 + (supply?.[1]?.[2] || 0);
// One kind's place in a lines fact (Situations.factNames).
const lineAt = (lines, kind) => kind === 'shots' ? Math.floor(lines / 3) : lines % 3;
// lazy: the market break reads the disposition rules, which read this module.
let MarketBreak = null;
// The spot of the gear plan's source while the route's verdict takes it for a solo bot:
// the plan is active and its held verdict (routedSpotId: GearPlanSelection.withRoutedSource)
// names the plan's own source spot; a party member's hunt is its party's (null). Read
// by the outgrown fact (outgrownOf), never as where the bot goes (BotRoute.huntSpot).
function routedSourceOf(state) {
    const plan = state.stats?.equipmentPlan;
    return plan?.status === 'active' && plan.routedSpotId != null && plan.routedSpotId === String(plan.next?.spotId)
        && !partyIdOf(state) ? plan.routedSpotId : null;
}
// How far the bot has outgrown the routed source (routedSourceOf): how many voluntary
// hunt floors its npc stands below the bot's level (GearAcquisitionPlanner.sourceFloorsBelow:
// the ordinary hunt's seven levels, the earning route's fifteen), 0-2; 0 with no routed
// source. A level only moves it, never the bot's wish focus. Each rise raises source_stalled:
// the plan's review judges the route again. Gear plans only wake on a grade, gear or clan
// change, and a level inside one grade outgrows a source. The bands are our choice, not C4.
let Planner = null;
function outgrownOf(state) {
    return routedSourceOf(state) == null ? 0
        : (Planner ||= invoke('GameServer/Bot/AI/GearAcquisitionPlanner')).sourceFloorsBelow(state, state.stats.equipmentPlan);
}
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
    view.grade = GradeRule.gradeForLevel(state.level);
    view.outleveled = outleveledOn(state, stats.earning);
    // The kill count and the gear plan's stall (GearStall: source_stalled at the crossing).
    view.kills = Stall.killsOf(state); view.stall = Stall.stallKills(state);
    view.outgrown = outgrownOf(state);
    view.supply = supplyOf(state);
    view.stores = storesOf(state);
    // What the bag holds against its floor and its cleanup counts (the bag fact,
    // PartyMarketBreak.bagFact: no price, board or clock); its rise raises bag_full.
    view.bagNeed = (MarketBreak ||= invoke('GameServer/Bot/Population/PartyMarketBreak')).bagFact(state, view.kitHashes);
    return view;
}
// What the bot's clan asks of it and holds for it: the clan's material demand, the clan
// supply, whether the clan has a warehouse, the clan goal's crystals. The personal
// warehouse is the bot's own doing: no fact.
// A member hears what its clan asks for, not how much is left, near a player and far
// alike: one reading, so a baseline taken in one place compares with a state in another.
// owner: { characterId, clanId, stats } (a state is one).
function storesOf(owner) {
    const demand = owner.stats?.clanMaterialDemand ?? null;
    const into = [demand && Object.keys(demand), ClanSupply.requestIdentity(owner), ClanSupply.hasWarehouse(owner)];
    const crystals = owner.stats?.equipmentPlan?.clanGoal?.clanId && require('./ClanCrystalSupply').identity(owner);
    if (crystals) into.push(crystals);
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
// The one reading of an occupation against the held leaf (Recompute: own
// outputs are not inputs): the trip the leaf ordered under way (to its
// hunting spot arriving to hunt, or to its town), or the arrival where it
// led (its hunting spot, hunting or resting there; else its own activity).
// A far bot (a gated place, Situations) owns more: hunting or resting on any ground,
// any trip but a forced one (FORCED_TRIPS: a flight, a death pressure, a
// pushed-out spot, a party's call) and its town visit, so a pull to another spot,
// a flight's arrival or its own bag or supply trip's arrival raises nothing there. Near a player only the leaf's own trip and
// arrival are; death, recall, a pull, a flight or a yield stay events. Read by
// the held build's verdict and by the far step's round check (Situations.factNames'
// planned); its field-trip clause is EconomyContext.fieldActivity's.
function occupationPlanned(state, leaf) {
    const where = Situations.place(state);
    // Far from a player (a gated place) its own move is no event.
    if (ownMove(state, where) && Situations.gated(where)) return true;
    if (!leaf?.activity) return false;
    const hunt = leaf.activity === 'hunting';
    // A hunting leaf's spot: its own (a source it hunts), else the bot's held choice (the
    // mind key, stats.huntSpot: where the route sends a leaf that names none).
    const spotId = hunt ? leaf.spotId ?? state.stats?.huntSpot?.spotId ?? null : null;
    if (state.activity === 'traveling') {
        const travel = state.stats?.travel;
        if (!travel) return false;
        return hunt && spotId != null ? sameSpot(travel.spotId, spotId)
            && travel.arrivalActivity === 'hunting' && travel.townName == null
            : leafVisit(state, leaf);
    }
    // A hunting leaf with no spot of its own and no held choice names no arrival: any spot is an event.
    if (hunt) return spotId != null && (state.activity === 'hunting' || state.activity === 'resting')
        && sameSpot(state.spotId, spotId);
    return state.activity === leaf.activity;
}
// A trip the bot took itself, out or back, the ground it reached and the town visit it
// came to (the trip's start was its event, whichever errand its held leaf names); a
// flight, a pushed-out spot or a party's call (its market break) is the world's.
const FORCED_TRIPS = new Set(['unsafe_ground_evacuation', 'death_pressure_replan', 'party_spot_replan']);
function ownMove(state, where) {
    if (state.activity === 'shopping') return !state.stats?.partyMarketReturn;
    if (state.activity !== 'traveling') return Situations.field(where);
    const travel = state.stats?.travel;
    return !!travel && !travel.cause && !FORCED_TRIPS.has(travel.reason);
}
// A far bot's town trip or visit the held leaf ordered (leafTrip): a market trip
// (GoalExecutor's, arriving as arrived_town) or the visit it opened, forced when another
// errand owns it (a bag cleanup, a party's market break) or the world forced it (a caused
// trip, FORCED_TRIPS). Read by the round's check (occupationPlanned), the far arrival
// (Situations.detect: arrived_town:own) and the card a visit serves (ColdEconomyDecision.refusal).
// A crafting station, the warehouse craft return, Mammon or a meeting is no market trip.
function leafVisit(state, leaf) {
    const stats = state.stats || {};
    const errand = !!(stats.forcedMarketCleanup || stats.partyMarketReturn);
    if (state.activity === 'traveling') {
        const travel = stats.travel;
        return travel?.arrivalEvent === 'arrived_town'
            && leafTrip(leaf, travel.townName, errand || !!travel.cause || FORCED_TRIPS.has(travel.reason));
    }
    return state.activity === 'shopping' && !!stats.marketReturn && !!stats.townVisit
        && leafTrip(leaf, state.currentRegion, errand);
}
// One rule for "did the held leaf order this town trip", far (leafVisit) and near (a body's
// arrival, ShoppingState.arrive): a trip to the town the leaf's step names that no other
// errand owns and the world did not force (forced). A hunting leaf orders no town trip.
function leafTrip(leaf, town, forced) {
    return leaf?.town != null && leaf.activity !== 'hunting' && !forced && String(town) === String(leaf.town);
}
function sameSpot(spotId, planned) {
    return spotId != null && String(spotId) === String(planned);
}
// The kit fact each economy build records in its baseline moved between two
// states of one bot: a party member's kit event. A party member's step raises
// no hard event (they run in hunting rounds only); its own post-round build
// names the kit change in its baseline instead. A step with no build (a held
// decision) keeps the baseline, so it reads as no move.
function kitMoved(before, after) {
    return (before?.stats?.wishSections?.build ?? null) !== (after?.stats?.wishSections?.build ?? null);
}
module.exports = { FIELD_ACTIVITIES, partyIdOf, routedSourceOf, moneyCrossings, unspent, LINK_INPUTS, routeVersions, movedInput, stateView, kit, kitMoved, incomeError,
    baselineIdentity, snapshot, semanticFacts, factsOf, relationTargetIds, LINE_BELOW, LINE_OUT, lineAt, supplyOf, linesOf, occupationPlanned, leafVisit, leafTrip, hash, decisionRefusal };
