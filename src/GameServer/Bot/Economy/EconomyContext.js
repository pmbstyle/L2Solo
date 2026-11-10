'use strict';
const FailureLog = require('../../../FailureLog');
const ClassProgression = invoke('GameServer/ClassProgression');
const DataCache = invoke('GameServer/DataCache');
const Knowledge = require('../AI/KnowledgeLearning');
const Crystallization = require('./BotCrystallization');
const Floor = require('../Population/SurvivalFloor');

const GearThreat = require('./GearThreat');

const ItemIndex = require('../../Item/ItemTemplateIndex');
const Valuation = require('./EconomicValuation');
const Providers = require('./WishProviders');
const Sections = require('./DecisionSections');
const Situations = require('../Situations');
const Funding = require('./PurchaseFunding');
const Packet = require('./StatsPacket');
const SpotRiskPolicy = require('../Population/SpotRiskPolicy');
const ColdEconomyDecision = require('../Population/ColdEconomyDecision');
const Network = require('./WishNetwork');
const Agenda = require('./Agenda');
const PurchaseEvidence = require('./WishPurchaseEvidence');
const OccupationSources = invoke('GameServer/Bot/Population/ColdOccupationSources');
const { WishNetwork, remember, admitRoots, remainingQuantity, moneyQueue, cashCharge } = Network;
const { isMainThread } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const RecomputeGeneration = require('../Population/RecomputeGeneration');
const PartyAdmission = require('../Population/PartyAdmission');
const PopulationConfig = require('../Population/PopulationConfig');
const Recipes = require('../../Items/C4RecipeItems');
const CraftInputReservations = require('./CraftInputReservations');
const Bytes = require('./CompactBytes');
const { SELL } = require('../../AfkTrade/BoardIndex');
const BoardRules = require('../../AfkTrade/BoardRules');
const Diagnostics = require('./EconomyDiagnostics');
const PriceBelief = require('./PriceBelief');
const { fnv1a32 } = require('../Fnv1a');
const engine = new WishNetwork();
const Trip = require('./EconomicTrip');
const IncomeRoute = require('./EquipmentIncomeRoute');
const Disposition = require('./ItemDisposition');
const SpotEconomics = require('./SpotEconomics');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const WalkBack = invoke('GameServer/Bot/Economy/WalkBack');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const TravelRoutes = invoke('GameServer/Bot/Travel/TravelRoutes');
const GearProgression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const RestPotion = invoke('GameServer/Bot/AI/RestPotion');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const TradeIntent = require('./TradeIntent');
const Trace = require('../DecisionTrace');
// The bound of an event proof's packed and wire forms.
const PROOF_RAW_BYTES = 65536;
// The cold worker holds one plan per bot (~1,700), apart from the planner's in-flight builds: a
// 64-slot cache shrunk by them dropped a plan within ~2.5 s under a long cold queue, so every
// same-key rebuild found nothing held (L133). A worker entry is the plan only (perf C1), a party
// member's with its graph nodes; the main thread keeps the graph nodes too and stays at 64.
const RETAIN_LIMIT = isMainThread ? 64 : 2048;
let routeAnchors = new WeakMap();
let runtime = {};
const extensions = new Map();
function configure(providers = {}) { runtime = providers; reset(); }
function registerProvider(key, provider) {
    if (typeof provider !== 'function') throw new TypeError('invalid_economy_provider');
    extensions.set(key, provider); reset();
}
// actorKey -> { key, readIds, plan, stateRef, gearThreat } of bots: bounded
// (WishNetwork.remember). The plan is data (planOf); a reader gets view().
const cache = new Map();
// Groups apart, so a party composition that weighs many candidate groups
// never evicts the bots' own reviews: `group:<partyId>` -> { key, ids,
// context }, removed when the party ends (forgetGroup) and bounded besides by the
// background party cap (PartyAdmission.limit: one entry per party it admits);
// a proposed composition (`proposal:` party id) is built and not kept.
const groups = new Map();
const groupLimit = () => PartyAdmission.limit(PopulationConfig);
const positive = value => Math.max(0, Number(value) || 0);

function stateForActor(actor, session = actor?.session) {
    // lazy: cycle hot decision publication calls this native actor capture.
    const decisionStats = require('../AI/DecisionEvents').decisionStatsFor(session);
    const stored = session?.coldLifeState || {};
    const current = invoke('GameServer/Bot/Population/BotLifeState').cachedState?.(actor.fetchId?.());
    const physicalInventory = actor.backpack?.fetchItems?.() || [];
    const inventory = itemRows(physicalInventory);
    const hotKit = invoke('GameServer/Bot/Population/ColdCombatProfile').capture(actor);
    const state = { ...stored, characterId: actor.fetchId?.(), level: actor.fetchLevel?.(), inventory, physicalInventory,
        clanId: Number(actor.fetchClanId?.() ?? stored.clanId ?? stored.stats?.clanId ?? 0),
        craftLevel: actor.backpack?.fetchDwarvenCraftLevel?.(actor) ?? stored.craftLevel,
        acceptedIncoming: current?.acceptedIncoming || stored.acceptedIncoming || {},
        incomingPending: current ? current.incomingPending === true : stored.incomingPending === true,
        adena: actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0,
        sp: actor.fetchSp?.() ?? stored.sp,
        ...bodyPlace(session, stored),
        stats: { ...decisionStats, coldCombat: hotKit, hennas: [...(session?.hennas || stored.stats?.hennas || [])], soulCrystalQuest: session?.questStates?.get(350)?.isStarted() === true || stored.stats?.soulCrystalQuest, classId: actor.fetchClassId?.(), exp: actor.fetchExp?.(), karma: actor.fetchKarma?.(), pk: actor.fetchPk?.() },
        activity: session?.plan || 'hunting' };
    const loc = { locX: Number(actor.fetchLocX?.()), locY: Number(actor.fetchLocY?.()), locZ: Number(actor.fetchLocZ?.()) };
    if (!Object.values(loc).every(Number.isFinite)) Object.assign(loc, stored.loc || {});
    state.loc = loc;
    return routeState(state, session);
}
// Where a body stands and with whom, in a far row's fields (spotId, party): its current
// spot and its background party. One shape for every reader of a body as a row
// (stateForActor, DecisionEvents.heldSpotId). stored: its row (coldLifeState).
function bodyPlace(session, stored = session?.coldLifeState || {}) {
    return { spotId: session?.currentSpot?.id || stored.spotId,
        party: session?.hotBackgroundPartyId ? { partyId: session.hotBackgroundPartyId, role: stored.party?.role } : null };
}
// The live items of a backpack as a state's inventory rows, one per item id
// (stateForActor).
function itemRows(items) {
    const inventory = {};
    for (const item of items) {
        const id = Number(item.fetchSelfId?.());
        if (!id) continue;
        const amount = positive(item.fetchAmount?.());
        const equipped = !!item.fetchEquipped?.();
        const stackable = item.fetchStackable?.();
        const previous = inventory[id];
        inventory[id] = { selfId: id, amount: amount + positive(previous?.amount),
            equipped: equipped || previous?.equipped, equippedCount: Number(equipped) + positive(previous?.equippedCount),
            slot: equipped ? Number(item.fetchSlot?.()) : previous?.slot || 0,
            enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0, stackable,
            ...(stackable === true ? {} : { instances: [...(previous?.instances || []), { id: item.fetchId?.(), selfId: id, amount, equipped,
                slot: Number(item.fetchSlot?.() || 0), enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0 }] }) };
    }
    return inventory;
}
function routeState(state, session) {
    if (!session || typeof session !== 'object') return state;
    const frame = Trip.frame(state); frame.loc = null;
    // A decision (decisionSeq) or a raise (situationSeq) re-anchors it.
    const event = JSON.stringify([state.spotId, state.stats?.decisionSeq, state.stats?.situationSeq, frame]);
    const held = routeAnchors.get(session);
    const anchor = held?.event === event ? held : { event, loc: state.loc };
    routeAnchors.set(session, anchor);
    return { ...state, loc: anchor.loc };
}
const proofDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function activityIdentity(leaf) {
    if (!leaf) return null;
    const value = new ColdEconomyDecision.CompactActivity(leaf);
    // These are the card's derived execution/funding annotations, not a
    // different selected activity. Every native command field stays bound.
    delete value.heldAtDecision; delete value.r; delete value.craftReservations;
    return proofDigest(value);
}
// L70: the bot's own hunting/resting/travelling is not an economic event.
// Only this kind is equalised. One trip is the plan itself: leaving for the
// held leaf's own hunting spot or its own town (Sections.occupationPlanned);
// its trip record is dropped. The arrival is the occupation fact, read by
// the verdict's sections against the held leaf.
const { FIELD_ACTIVITIES } = Sections;
function fieldActivity(state, activity, leaf = null) {
    if (!activity || activity === state.activity || !FIELD_ACTIVITIES.has(activity) || !FIELD_ACTIVITIES.has(state.activity)) return state;
    return state.activity === 'traveling' && Sections.occupationPlanned(state, leaf)
        ? { ...state, activity, stats: { ...state.stats, travel: null } } : { ...state, activity };
}
// The decided facts of a request over resolved deps: the bot's memory and
// the recipe book the build reads (main: the database book; worker: the
// book main sent), so a build and its verdict read the same sources.
function requestFacts(state, deps) {
    return Sections.semanticFacts(state, deps.memory ?? null, Providers.recipeIds(state, deps));
}
// The build's input name (the weighing memo, the card's inputHash, the group
// key): its facts without the occupation, which the verdict reads against
// the held leaf, so a trip the leaf ordered does not rename the inputs; and
// the gear-threat mask the decision weighs and keeps, so the rebuild after a
// threat refusal never reuses the weighing made under the other mask.
const inputName = (facts, threat) => String(Sections.hash({ ...facts, occupation: null, threat }));
// The held plan's proof: who decided it and what. A
// card or a held entry serves while its identity holds: its owner, the recompute
// generation, the decision echo (decisionSeq, activityLeaf, focus) and the leaf's
// identity. Nothing else is judged per step: a plan is held until a situation wakes
// its build (Situations.woken), executors raise what ended its leaf (leafOutcome).
// { version 3, owner, at (its baseline's), generation, decision, activity, restartable }.
const PROOF_VERSION = 3;
// The first input a completed build lacks for a proof, '' if none.
function eventProofMissing(state, plan) {
    if (!plan || plan.pending) return 'pending';
    if (!plan.statsPacket?.wishSections) return 'sections';
    if (!RecomputeGeneration.current()) return 'generation';
    const baseline = plan.statsPacket.wishSections, leaf = plan.network?.activity;
    if (leaf === null ? plan.pending !== false || plan.intentPending !== false || plan.statsPacket.activityLeaf !== 0
        : !leaf?.activity) return 'leaf';
    if (!Number.isFinite(baseline.at)) return 'baseline';
    return '';
}
// Produced by the completed native build, shared by its cache entry and its card;
// never reconstructed from a later publication.
function captureEventProof(state, deps = {}, options = {}) {
    const plan = options.plan, missing = eventProofMissing(state, plan);
    // Diagnostics: per retained build, captured or the first missing input.
    if (Diagnostics.active()) Diagnostics.count('context', 'proof', missing || 'captured');
    if (missing) return null;
    const leaf = plan.network?.activity;
    return Object.freeze({ version: PROOF_VERSION, owner: Number(state.characterId), at: plan.statsPacket.wishSections.at,
        generation: RecomputeGeneration.current(),
        decision: Object.freeze([Number(plan.statsPacket.decisionSeq || 0),
            Number(plan.statsPacket.activityLeaf || 0), plan.network.focus?.[0] ?? null]),
        activity: activityIdentity(leaf),
        restartable: !!RecomputeGeneration.restorable() && typeof deps.memoryIdentity === 'string' && deps.sourceReady === true });
}
// '' when the proof still names the state's decision (leaf: the plan's or the card's
// leaf), else the first reason it does not: unproved, generation, activity, or the
// echo's (decision_seq, activity_leaf, wish_focus).
function proofIdentity(state, proof, leaf) {
    if (!proof || proof.version !== PROOF_VERSION || proof.owner !== Number(state.characterId)
        || !Array.isArray(proof.decision) || proof.decision.length !== 3
        || !proof.decision.slice(0, 2).every(value => Number.isSafeInteger(value) && value >= 0)
        || proof.decision[2] !== null && typeof proof.decision[2] !== 'string'
        || !(proof.activity === null ? !leaf && proof.decision[1] === 0 : typeof proof.activity === 'string' && !!leaf?.activity)) return 'unproved';
    const generation = RecomputeGeneration.current();
    if (!generation || proof.generation !== generation) return 'generation';
    if (activityIdentity(leaf) !== proof.activity) return 'activity';
    return Sections.decisionRefusal(state, ...proof.decision);
}
// A restart's saved proof: the recompute generation it was made under (a restore
// under another is refused); the rest is the accepted card's own identity.
function restartEventProof(proof, accepted) {
    if (proof?.version !== PROOF_VERSION || proof.restartable !== true || !accepted?.card
        || !RecomputeGeneration.restorable() || proof.generation !== RecomputeGeneration.restorable()
        || !/^[a-f0-9]{64}$/.test(proof.generation)
        || proof.owner !== accepted.characterId || proof.at !== accepted.baseline?.at
        || !Array.isArray(proof.decision) || proof.decision.length !== 3
        || proof.decision[0] !== accepted.decisionSeq || proof.decision[1] !== accepted.activityLeaf
        || proof.decision[2] !== accepted.focus || proof.activity !== activityIdentity(accepted.card.activity)
        || proof.activity === null && (accepted.card.activity !== null || proof.decision[1] !== 0)) return null;
    try {
        const write = Bytes.writer();
        write.byte(8); write.raw(Buffer.from(proof.generation, 'hex'));
        return write.finish();
    } catch (error) { FailureLog.note('economy.codec:proof_pack', error); return null; }
}
function restoreEventProof(prefix, accepted) {
    const generation = RecomputeGeneration.restorable();
    if (!generation || !(prefix instanceof Uint8Array) || prefix.byteLength > PROOF_RAW_BYTES || !accepted?.card) return null;
    try {
        const read = Bytes.reader(prefix);
        // A prefix of an earlier format (it carried the verdict's quantity proof) is refused once.
        if (read.byte() !== 8 || read.raw(32).toString('hex') !== generation) return null;
        if (!Number.isSafeInteger(accepted.characterId) || accepted.card.activity === null && accepted.activityLeaf !== 0
            || !Number.isFinite(accepted.baseline?.at)) return null;
        return Object.freeze({ version: PROOF_VERSION, restartable: true, owner: accepted.characterId, at: accepted.baseline.at,
            decision: Object.freeze([accepted.decisionSeq, accepted.activityLeaf, accepted.focus]),
            activity: activityIdentity(accepted.card.activity), generation });
    } catch (error) { FailureLog.note('economy.codec:proof_restore', error); return null; }
}
// The check of a held leaf where it is carried out: one row per kind of leaf answers
// "does it still stand?" (leafOutcome: the executor's situation; the agenda's next
// step). A row returns '' or its own frozen failure: the name (check:<name>).
// input = { heldUnits, current, prepared }: heldUnits = the own item's bag+incoming
// at the decision (a held build's entry; a card carries it on its leaf); current = a
// lazy basics reader; prepared = { liquidation } candidates already read.
// Execution still prepares its batch and checks via the command/CAS.
const failure = (name, link = name) => Object.freeze({ reason: `check:${name}`, link });
const EXCLUDED = failure('excluded'), MATERIAL_DONE = failure('material_done'), OFFER = failure('offer'), SALE = failure('sale');
const FILLED = failure('filled'), SHORT = failure('short'), CRAFT = failure('craft'), TARGET = failure('target');
const IMPROVEMENT = failure('improvement'), UNSUPPORTED = failure('unsupported');
const OFFER_NONE = failure('offer_none', 'offer_gone'), OFFER_TOWN = failure('offer_town', 'offer_gone');
const OFFER_PRICE = failure('offer_price', 'offer_gone'), OFFER_UNITS = failure('offer_units', 'offer_gone');
const KIT = failure('kit');
// A kit step buys the kit's item as the build read it. A weapon the plan's own steps
// bought and wore (no gear_changed: its own answer) or a level crossing moves the
// kit's shot or potion: the old item is no kit any more, the sale lists it as surplus,
// and a step that kept ordering it would buy again what the sale takes. The step ends;
// the next build buys the new item. A shot's kind (a spiritshot class's Blessed or plain)
// is the build's own choice (its earning answer at search), carried by the step's item:
// only the worn weapon's grade is checked against it, never the held earning answer.
// A step of the kit's root that buys a shot's craft input (Soul Ore, crystals) is no
// consumable of the kit and goes on.
function kitMoved(state, leaf) {
    const itemId = Number(leaf.itemId);
    if (leaf.rootKey === 'stock:shots') {
        const ShotStock = invoke('GameServer/Inventory/ShotStock');
        if (!ShotStock.SHOT_IDS.includes(itemId)) return false;
        const blessed = ShotStock.BLESSED_SPIRITSHOT_IDS.includes(itemId);
        return itemId !== Number(ShotStock.planForState(state, { blessed })?.selfId);
    }
    if (leaf.rootKey === 'stock:potions') {
        return HealingPotionStock.POTION_IDS.includes(itemId)
            && itemId !== Number(HealingPotionStock.purchasePotionFor(state).selfId);
    }
    return false;
}
const withHeldUnits = (leaf, heldUnits) => ColdEconomyDecision.ownItem(leaf) !== null && Number.isFinite(heldUnits)
    ? { ...leaf, heldAtDecision: heldUnits } : leaf;
// The hunting spot against the bot's marks (died here, was full, avoided a
// quarrel) and its death pressure: the one exclusion read of a decision.
function spotExcluded(state, leaf) {
    return SpotRiskPolicy.excludedSpotIdsForStates([state]).has(String(leaf.spotId)) ? EXCLUDED : '';
}
// A trade leaf's town route: known and its fees payable now.
const tripOf = (state, deps) => deps.tripCost || Trip.preparedReader(deps.routeRows || [], { hourAdena: positive(Packet.hourAdena(state.stats?.money)) });
function tradeRoute(state, leaf, deps) {
    const trip = tripOf(state, deps);
    const route = trip.details?.(leaf.town);
    return route?.known && Number.isFinite(route.fees) && route.fees <= positive(state.adena) ? { trip, route } : null;
}
// The offer a shopping step reads: the bot's town when it holds its offer, else the best.
const townOffer = (state, leaf, deps, trip, holds = true) => PurchaseEvidence.reader(state, { board: deps.board, trip }, deps, holds ? { town: leaf.town } : undefined)(leaf.itemId);
// A material hunt's count reached (its goal done).
const materialDone = (state, leaf, input) => ColdEconomyDecision.materialHunt(leaf)
    && ColdEconomyDecision.remainingToOrder(withHeldUnits(leaf, input.heldUnits), state) <= 0 ? MATERIAL_DONE : '';
const LEAF_CHECKS = Object.freeze({
    hunting: (state, leaf, deps, input) => spotExcluded(state, leaf) || materialDone(state, leaf, input),
    shopping: (state, leaf, deps, input) => {
        if (kitMoved(state, leaf)) return KIT;
        deps = resolved(state, deps, false);
        const trade = tradeRoute(state, leaf, deps);
        if (!trade || !(leaf.kind === 'buy' && leaf.itemId > 0 && leaf.amount > 0 && leaf.unitPrice > 0
            && ['npc', 'configured_store', 'afk'].includes(leaf.sourceType))) return OFFER;
        const held = withHeldUnits(leaf, input.heldUnits);
        const remaining = ColdEconomyDecision.remainingToOrder(held, state);
        if (!(remaining > 0)) return FILLED;
        // A bot holds its own offer: a better one elsewhere or a lower price breaks nothing.
        const holds = Situations.reactive(state);
        const offer = townOffer(state, leaf, deps, trade.trip, holds);
        if (!offer) return OFFER_NONE;
        if (!holds && (offer.sourceType !== leaf.sourceType || offer.town !== leaf.town)) return OFFER_TOWN;
        if (holds ? offer.unitPrice > leaf.unitPrice : offer.unitPrice !== leaf.unitPrice) return OFFER_PRICE;
        if (offer.availableUnits < remaining) return OFFER_UNITS;
        // The purse is read by the step's place in the money queue: its value per unit
        // stops a dearer seller, not a tight purse. The buyer's own rule (payable: its
        // bids' escrow counted, paid from the bag and the step's own bids it takes back),
        // so a step funded here is paid there.
        const stepBids = leaf.bids?.length ? Funding.stepBids(Funding.ownBids(deps.board?.ownerLines?.(Number(state.characterId))), leaf.bids) : 0;
        return Funding.payable(state, deps.buyOrderEscrow, Funding.nativeTerms(holds ? { ...held, valueHours: undefined } : held, leaf.itemId),
            null, stepBids) >= remaining * offer.unitPrice + trade.route.fees ? '' : SHORT;
    },
    selling: (state, leaf, deps, input) => {
        deps = resolved(state, deps, false);
        if (!tradeRoute(state, leaf, deps) || !(leaf.kind === 'liquidate' && leaf.funding === true && leaf.items?.length
            && OccupationSources.hasNpcSellerInTown(leaf.town))) return SALE;
        const own = () => input.prepared?.basics ? (input.prepared.basics.base = basics(state, deps)) : basics(state, deps);
        return (input.prepared?.liquidation || Providers.liquidationCandidates(state, input.current ? input.current() : own()))
            .some(row => leaf.items.includes(Number(row.selfId))) ? '' : SALE;
    },
    // This retains the chosen intention. The native executor still
    // prepares its actual batch and checks MP, materials and payment.
    crafting: (state, leaf) => Number.isSafeInteger(leaf.recipeId) && leaf.recipeId > 0
        && Recipes.resolveByRecipeId(leaf.recipeId) ? '' : CRAFT,
    pvp: (state, leaf) => Number.isSafeInteger(leaf.targetId) && leaf.targetId > 0
        && leaf.rootKey === `scores:${leaf.targetId}` ? '' : TARGET,
    helping: (state, leaf) => Number.isSafeInteger(leaf.targetId) && leaf.targetId > 0
        && leaf.rootKey === `care:${leaf.targetId}` ? '' : TARGET,
    improving: (state, leaf, deps, input) => {
        const improvement = leaf.improvement;
        if (!improvement || typeof improvement !== 'object' || Array.isArray(improvement)) return IMPROVEMENT;
        // A conversion ends when its product arrives, even during a town
        // visit that defers bag changes. A partial crystal batch also ends
        // this command: its consumed inputs need a fresh selection.
        if (ColdEconomyDecision.ownItem(leaf) !== null
            && ColdEconomyDecision.progressSince(withHeldUnits(leaf, input.heldUnits), state) > 0) return FILLED;
        // An enchant or a special ability names its object: it is still in the
        // bag under its item at the enchant level the decision read. Other
        // objects in the bag are no input; an exchange or a crystallization
        // names none (its inputs are bag rows).
        if (improvement.objectId == null) return '';
        const row = state.inventory?.[improvement.itemId];
        const object = row?.instances?.find(item => Number(item.id) === Number(improvement.objectId));
        return object && positive(object.enchant ?? row.enchant) === positive(improvement.from) ? '' : IMPROVEMENT;
    },
    resting: () => '',
    traveling: () => ''
});
// A completed native graph may choose no economic action (no leaf):
// execution keeps its ordinary hunt/rest/travel path after every shared check.
function leafCheck(state, leaf, deps, input) {
    if (!leaf) return '';
    const row = Object.hasOwn(LEAF_CHECKS, leaf.activity) ? LEAF_CHECKS[leaf.activity] : null;
    return row ? row(state, leaf, deps, input) : UNSUPPORTED;
}
// What a held leaf's execution proved on this state (the far step that carries it
// out, ColdSimulationWorker planLifecycle): the situation it raises, '' when the leaf
// stands. On a town visit every check: the step done (goal_done:visit) or refused
// (goal_failed:visit), the agenda moves on. In the field only the leaves the step
// itself carries out (a material hunt's count reached; an improvement whose product
// came; a craft, a fight, a care): goal_done:goal / goal_failed; a shop is checked
// where it happens, in town, a sale at the end of its visit (saleSpent). A hunt's
// spot ruled out is no outcome of the hunt: the spot's situations raised it
// (spot_dangerous, contest_lost, spot_unreachable) and wake the earning spot and the
// build. Cost: one check of the held leaf per far step, no build.
const DONE = new Set(['check:filled', 'check:material_done']);
const FIELD_CHECKED = new Set(['hunting', 'improving', 'crafting', 'pvp', 'helping']);
// A sale step is spent once a visit ended after the build took it (the sale's own visit,
// or the visit it was taken on, far or near: GoalExecutor.townLooked stamps townLook.at) and
// the bot heads back to its ground (not on a trip to a town, as a craft warehouse
// return): done when its items left the bag; refused when the kinds that stayed are on
// the sale retry the visit's sale wrote (stats.marketSellSeen: what it could not place),
// which keeps them out of the next build's sale until a new kind or a new or better buyer
// comes (ItemDisposition.saleRetryHolds, WishProviders.liquidationCandidates): no trip
// back for them. Kinds the visit never offered (its sale did not run) keep the step held:
// its own trip carries it out. Held past the visit, a sale taken in town, where it costs
// no trip, sent the bot back with its next loot. Temporary until the town plan holds the
// visit's sale.
function saleSpent(state, leaf) {
    const toGround = state.activity === 'hunting' || state.activity === 'resting'
        || state.activity === 'traveling' && state.stats?.travel?.arrivalActivity === 'hunting';
    if (!toGround || !(Number(state.stats?.townLook?.at) > Number(state.stats?.wishSections?.at || 0))) return '';
    const stayed = (leaf.items || []).filter(id => positive(state.inventory?.[id]?.amount) > 0);
    if (!stayed.length) return 'goal_done:goal';
    const tried = state.stats?.marketSellSeen?.items;
    return Array.isArray(tried) && stayed.every(id => tried.includes(Number(id))) ? 'goal_failed' : '';
}
// Whether the held plan of a bot on a town visit names a stop after its leaf (the
// agenda the build that sent it decided, WishNetwork.agendaOf): its leaf's end then
// moves on to it (deps.visitStop) with no build; with none left the visit's end wakes
// the build (goal_done:visit / goal_failed:visit), which takes the next leaf.
function visitStopsLeft(state, deps = {}) {
    const held = cache.get(actorKeyOf(state, deps));
    return Situations.onVisit(state) && (held?.plan.network?.agenda?.length || 0) > 0;
}
function leafOutcome(state, leaf, deps = {}, heldUnits = leaf?.heldAtDecision) {
    if (!leaf?.activity) return '';
    const visit = Situations.onVisit(state);
    if (!visit && leaf.activity === 'selling') return saleSpent(state, leaf);
    if (!visit && !FIELD_CHECKED.has(leaf.activity)) return '';
    const input = { heldUnits, current: null, prepared: {} };
    const failed = leaf.activity === 'hunting' ? materialDone(state, leaf, input) : leafCheck(state, leaf, deps, input);
    if (!failed) return '';
    const done = DONE.has(failed.reason);
    return visit ? done ? 'goal_done:visit' : 'goal_failed:visit' : done ? 'goal_done:goal' : 'goal_failed';
}
// Board reads of the review go through here while it is built, so each
// item it looked at is reported once (deps.onSourceRead: the occupation
// planner's dependencies). The market is no input of the held decision: it is
// heard at the soft point through the watch list. Later readers of
// context.board (a market look, a sale) report nothing.
function watchedBoard(board, watch) {
    if (!board) return board;
    return Object.assign(Object.create(board), {
        first: (selfId, ...rest) => { watch(selfId); return board.first(selfId, ...rest); },
        list: (selfId, ...rest) => { watch(selfId); return board.list(selfId, ...rest); },
        ...(board.heads ? { heads: (selfId, ...rest) => { watch(selfId); return board.heads(selfId, ...rest); } } : {}),
        ...(board.demandSnapshot ? { demandSnapshot: (selfId, ...rest) => {
            watch(selfId); return board.demandSnapshot(selfId, ...rest);
        }, demandTowns: selfId => { watch(selfId); return board.demandTowns(selfId); } } : {})
    });
}
function defaultProducerSource(state, board) {
    const index = invoke('GameServer/Bot/Population/ColdOccupationSources').recipeIndex(board);
    const level = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state), scope = index.scopeFor(level);
    return { recipes: index.rowsFor(level), scope, revision: index.revision(scope) };
}
// The deps a full resolve made, with the state it was made for: a check
// inside the same build (its LEAF_CHECKS rows) is given
// the build's own deps and does not resolve them again (a second producer
// source read and onSourceScope call). An entry dies with its deps object.
const resolvedFor = new WeakMap();
function resolved(state, deps, production = true) {
    if (state && resolvedFor.get(deps) === state) {
        if (Diagnostics.active()) Diagnostics.count('context', 'resolved', 'reused');
        return deps;
    }
    deps = { ...runtime, ...deps };
    if (typeof deps.board === 'function') deps.board = deps.board();
    if (!deps.board && isMainThread) deps.board = invoke('GameServer/AfkTrade/AfkTradeService').boardIndex();
    if (typeof deps.spots === 'function') deps.spots = deps.spots();
    if (typeof deps.memory === 'function') deps.memory = deps.memory(state.characterId);
    if (typeof deps.memoryIdentity === 'function') deps.memoryIdentity = deps.memoryIdentity(state.characterId);
    if (typeof deps.sourceReady === 'function') deps.sourceReady = deps.sourceReady();
    // Stock, survival and own shot-use readers need only the hunt foundation.
    // Production sources and recipe books belong to the full wish review.
    if (production) {
        if (typeof deps.knownRecipes === 'function') deps.knownRecipes = deps.knownRecipes(state.characterId);
        if (!deps.fixedProductionOffersFor) deps.fixedProductionOffersFor = invoke('GameServer/Bot/Population/ColdOccupationSources').fixedBuyerOffersFor;
        if (!deps.producerSource && deps.board) deps.producerSource = defaultProducerSource;
        if (typeof deps.producerSource === 'function') {
            const source = deps.producerSource(state, deps.board);
            deps.producerRecipes = source?.recipes;
            deps.producerRevision = source?.revision;
            if (source?.scope != null) deps.onSourceScope?.(source.scope);
        }
        if (isMainThread && !Object.hasOwn(deps, 'workshops')) {
            const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
            deps.workshops = Workshops.publicForRecipe;
        }
        if (isMainThread && !Object.hasOwn(deps, 'knownRecipes')) {
            const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
            if (Workshops.bookFor(state.characterId) !== null) deps.knownRecipes = Workshops.cachedRecipes(state.characterId);
        }
        if (isMainThread && !Object.hasOwn(deps, 'memory')) {
            // The bot's memory rows for its relations fact, bond and threat, the
            // rows the worker's snapshot carries, read without the snapshot's copy.
            // lazy: worker the main memory owner; the worker passes its own reader.
            deps.memory = invoke('GameServer/Social/InteractionMemoryRuntime').relationRows(Number(state.characterId));
        }
        if (isMainThread && !Object.hasOwn(deps, 'buyOrderEscrow')) {
            // lazy: worker native market records live on main; workers receive their existing context mirror.
            deps.buyOrderEscrow = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(state.characterId);
        }
        if (typeof deps.buyOrderEscrow === 'function') deps.buyOrderEscrow = deps.buyOrderEscrow(state.characterId);
    }
    if (!deps.spots && isMainThread) deps.spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    if (!deps.npcOffersFor && isMainThread) deps.npcOffersFor = id => {
        const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources');
        Sources.initialise(); return Sources.npcOffersFor(id);
    };
    if (production) resolvedFor.set(deps, state);
    return deps;
}
function personaOf(state, deps) {
    return deps.persona || invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
}
// peekBoard: the board the price beliefs read without watching it; peek(id)
// is the price price(id) answers, read into nothing (a kept gear list checks
// its prices with it: WishProviders). A belief peeked first serves the price
// read after it: price(id) reads id itself, so the watched board's read of
// the belief adds nothing.
function pricing(state, persona, board, timestamp, deps, read = () => {}, prices = new Map(), peekBoard = board) {
    const knowledgeEnabled = deps.knowledgeEnabled ?? Knowledge.knowledgeEnabled();
    const priceCtx = { characterId: state.characterId, understanding: persona.understanding ?? 0.3,
        marketTrades: state.marketTrades, knowledgeEnabled, board, timestamp };
    const beliefs = new Map(), peeked = new Map();
    const beliefFor = id => {
        if (!beliefs.has(Number(id))) beliefs.set(Number(id), PriceBelief.prior(id, priceCtx) || null);
        return beliefs.get(Number(id));
    };
    return { knowledgeEnabled, prices, beliefs, beliefFor, price: id => {
        read(id);
        if (!prices.has(Number(id))) {
            if (peeked.has(Number(id)) && !beliefs.has(Number(id))) beliefs.set(Number(id), peeked.get(Number(id)));
            const belief = beliefFor(id);
            prices.set(Number(id), belief ? Math.exp(belief.mu) : 0);
        }
        return prices.get(Number(id));
    }, peek: id => {
        id = Number(id);
        if (prices.has(id)) return prices.get(id);
        if (!beliefs.has(id) && !peeked.has(id)) peeked.set(id, PriceBelief.prior(id, { ...priceCtx, board: peekBoard }) || null);
        const belief = beliefs.has(id) ? beliefs.get(id) : peeked.get(id);
        return belief ? Math.exp(belief.mu) : 0;
    } };
}
// Price future carried scroll uses only if a review needs extra stock.
// Resolve the known hunt through the existing catalogue index; a merchant
// location during a town visit is never a future hunting origin.
// Below karma that closes towns the saving reads only the origin and the static
// town and gatekeeper tables, so a hunt spot's answer is kept on its catalogue
// object: the two route solves run once per spot, not in every build.
// solve false (the published rates, kitRates): undefined where the
// answer would need the route solves of an origin off the catalogue.
const spotScrollHours = new WeakMap();
function scrollHoursFor(state, spots, bestSpotId, solve = true) {
    if (invoke('GameServer/Karma').closesTowns(state.stats?.karma)) return 0;
    const spot = SpotIndex.spotById(spots, bestSpotId);
    if (!spot?.center) return solve ? scrollSavingHours(state, state.stats?.marketReturn?.loc
        || (state.activity === 'hunting' ? state.loc : null)) : undefined;
    if (spotScrollHours.has(spot)) return spotScrollHours.get(spot);
    const hours = scrollSavingHours(state, spot.center);
    spotScrollHours.set(spot, hours);
    return hours;
}
function scrollSavingHours(state, origin) {
    if (!origin || ![origin.locX, origin.locY, origin.locZ].every(Number.isFinite)
        || origin.locX === 0 && origin.locY === 0) return 0;
    const destination = TravelRoutes.landingTown(origin);
    const routeState = { ...state, loc: origin, inventory: { 736: { amount: 0 } } };
    const walking = ColdTrip.townPlan(routeState, destination);
    const recall = ColdTrip.townPlan({ ...routeState, inventory: { 736: { amount: 1 } } }, destination);
    return walking && recall && recall.scroll ? Math.max(0, walking.durationMs - recall.durationMs) / 3600000 : 0;
}
// The kit's live inputs (kitReader): the bot's shot and potion now, the
// units it holds of them (the shot with its beginner grant), its Scroll of
// Escape, whether karma closes the towns and its hour (the money packet's,
// else the caller's build's). known: the plan, potion and beginner amount a
// build already read.
function kitBag(state, known = {}) {
    const ShotStock = invoke('GameServer/Inventory/ShotStock'), plan = known.plan || ShotStock.planForState(state);
    const potionId = Number((known.potion || HealingPotionStock.purchasePotionFor(state)).selfId);
    const beginner = known.beginner ?? ShotStock.beginnerAmount(state, plan);
    return { plan, shotId: Number(plan.selfId), shots: positive(state.inventory?.[plan.selfId]?.amount) + beginner, beginner,
        potionId, potions: positive(state.inventory?.[potionId]?.amount), scrolls: positive(state.inventory?.[736]?.amount),
        closed: invoke('GameServer/Karma').closesTowns(state.stats?.karma),
        hour: positive(known.hour ?? Packet.hourAdena(state.stats?.money)) };
}
// The rates for the bot's items now. A build judged its shot verdict for the
// shot it read: after a weapon change the same spot's shots per hour are judged
// again at the new shot's price (ShotStock.usePolicy over the rates' use and the
// bot's hour, no build). A new potion (a level crossing) keeps the survival
// drinks per hour and drops the rest bottles judged for the old one until the
// next build. Unchanged items keep the rates object (its scroll memo).
function ratesNow(rates, state, bag, price) {
    if (!rates || bag.shotId === rates.shotId && bag.potionId === rates.potionId) return rates;
    let now = rates;
    if (bag.shotId !== rates.shotId) {
        const policy = invoke('GameServer/Inventory/ShotStock').usePolicy(state, { plan: bag.plan,
            bestTable: { shots: rates.shotUse }, hourAdena: bag.hour, unitPrice: price(bag.shotId) });
        now = { ...now, shotId: bag.shotId, shotsPay: policy.usePerHour > 0, shotsCanRestock: policy.purchaseUsePerHour > 0,
            shotBenefit: policy.rawUse > 0 ? policy.benefit / policy.rawUse : 0, policy: undefined };
    }
    if (bag.potionId !== rates.potionId) now = { ...now, potionId: bag.potionId, potionRestUse: 0 };
    return now;
}
// The one kit rule, hot and cold, worker and main: stock(kind),
// kitCost(id) and the survival reserve over the build's rates (kitRates: use
// per hour, benefit per unit, outing hours; StatsPacket.kitRates publishes
// them) and the live bag, wallet and prices. A kind's target is an outing's
// use for a kind worth carrying, never less than one hour of use (its
// line); shots that cannot be restocked keep what the bag holds; the rest
// bottles only as many as the wallet buys above the reserve. rates null (no
// build has rated the kit yet): the bag is held as it is, nothing is bought
// and the reserve is empty. Prices go through the caller's price reader, so
// each read joins the review's inputs. scrollHours: the hours a Scroll of
// Escape saves, read only when a scroll is priced (a build solves its route
// lazily). The scroll is no survival item: one is carried
// per outing when the walk it saves is worth more than it costs at the bot's
// hour, none in towns karma closes; a broke bot walks. It is no part of the
// reserve; a purchase pays it from money the queue does not hold (ScrollStock).
// One per outing is our rule, not C4.
// The survival kit is priced at the NPC's list price (StaticMerchantPricing.
// botNpcListPrice, kept per item), not the bot's estimate: the reserve holds
// that, and a restock's survival tranche spends that share (kitCost) at any
// counter; a town's tax above it, as any optional unit, is paid from the
// money above the reserve at its stock wish's rank (PurchaseFunding.
// stockAllowance, quoteScale). The estimate where no NPC sells the item.
function survivalPrice(id, price) {
    const list = Number(invoke('GameServer/Bot/Economy/StaticMerchantPricing').botNpcListPrice(id));
    return Number.isFinite(list) && list > 0 ? list : price(id);
}
function kitReader(rates, bag, wallet, price, scrollHours = () => positive(rates?.scrollHours)) {
    const held = !rates;
    // Shots are used while the bag holds some or a restock pays (ShotStock.usePolicy).
    const base = kind => {
        const shots = kind === 'shots';
        const itemId = shots ? bag.shotId : bag.potionId, current = shots ? bag.shots : bag.potions;
        const canRestock = !held && (shots ? rates.shotsCanRestock : true);
        const use = held ? 0 : !shots ? positive(rates.potionUse)
            : (current > 0 ? rates.shotsPay : canRestock) ? positive(rates.shotUse) : 0;
        const restUse = held || shots ? 0 : positive(rates.potionRestUse);
        const line = Math.ceil(use);
        // Forecast consumption may be fractional; both purchase tranches use
        // the same whole-unit survival stock so their sum remains executable.
        const survivalTarget = held ? current : canRestock ? line : Math.min(current, line);
        return { shots, itemId, current, canRestock, use, restUse, line, survivalTarget,
            survivalMissing: Math.max(0, survivalTarget - current), survivalPrice: survivalPrice(itemId, price),
            benefitPerUnit: use + restUse > 0 ? positive(shots ? rates.shotBenefit : rates.potionBenefit) : 0 };
    };
    const kit = [base('shots'), base('potions')];
    // The survival reserve: the kit's missing survival units at their list price.
    const hours = held ? 0 : positive(rates.outingHours);
    // The outing refill: the units one outing uses of a kind worth restocking,
    // never under its line (the bot's usual purchase). The reserve holds it at
    // the NPC list price whatever the bag holds now, so gear never takes the next
    // kit's money; a town counter spends of it what the bag misses.
    const refill = row => row.canRestock ? Math.max(row.line, Math.ceil(row.use * hours)) : 0;
    const reserve = kit.reduce((sum, row) => sum + refill(row) * row.survivalPrice, 0);
    const stock = kind => {
        if (kind === 'scrolls') {
            const current = bag.scrolls, unitPrice = price(736);
            const target = held ? current : bag.closed ? 0 : current >= 1 || scrollHours() * bag.hour > unitPrice ? 1 : 0;
            const missing = Math.max(0, target - current);
            const benefitPerUnit = current < target ? scrollHours() : 0;
            return { itemId: 736, usePerHour: 0, current, hours: Infinity, targetHours: hours, target,
                survivalTarget: 0, survivalMissing: 0, missing, unitPrice, survivalPrice: survivalPrice(736, price),
                benefitPerUnit, benefitHours: missing * benefitPerUnit, needed: false };
        }
        const row = kit[kind === 'shots' ? 0 : 1], { itemId, current, use, restUse, line } = row;
        // The rest bottles (RestPotion.stockUse) beside the survival use: an
        // outing's, at most what the wallet buys above the reserve.
        const restCap = restUse > 0 ? current + Math.floor(Math.max(0, positive(wallet) - reserve) / Math.max(1, price(itemId))) : 0;
        const wanted = Math.max(line, Math.ceil(use * hours), Math.min(Math.ceil((use + restUse) * hours), restCap));
        // Useful owned stock need not justify expensive replacement stock.
        const target = held ? current : row.canRestock ? wanted : Math.min(current, wanted);
        const missing = Math.max(0, target - Math.max(current, row.survivalTarget));
        // needed: a zero use has a zero survival target.
        return { itemId, ...(row.shots ? { beginnerCurrent: bag.beginner } : {}), current, line, refill: refill(row),
            target, survivalTarget: row.survivalTarget, missing, survivalMissing: row.survivalMissing, unitPrice: price(itemId),
            survivalPrice: row.survivalPrice, needed: current < row.survivalTarget,
            usePerHour: use, ...(row.shots && rates?.policy ? rates.policy : {}), hours: use > 0 ? current / use : Infinity,
            targetHours: hours, benefitPerUnit: row.benefitPerUnit, benefitHours: missing * row.benefitPerUnit };
    };
    // The kit's survival tranche: without a quote the reserve's own share
    // (its list price); with a known executable quote its whole missing units
    // at that quote, once (PurchaseFunding.survivalTranche: the counter counts
    // the share beside the queue's money and never refuses the kit itself).
    const kitCost = (id, unitPrice = null) => {
        const quoted = Number.isFinite(unitPrice) && unitPrice > 0;
        return kit.filter(row => row.itemId === Number(id)).reduce((sum, row) => sum
            + Math.max(0, refill(row) - row.current) * (quoted ? unitPrice : row.survivalPrice), 0);
    };
    return { stock, kitCost, reserve };
}
// The bot's hour, death and karma prices and its stock of shots and potions:
// the part of a review that needs no wish network. forState builds on it and
// basics() returns it alone, so a reader that wants only these never builds
// the network, and both give the same numbers.
// The earning spot: a build whose decision is due
// (earningDue: deps.decideEarning) searches (EquipmentIncomeRoute.search) and
// holds its answer (answerOf, published as statsPacket.earning, its bit cleared
// by Situations.decided); every other read takes the held answer's route at
// the inputs now (heldRoute: one row evaluation, no search). A cold step often
// builds basics() and then forState() for the same projected state: the build
// takes the basics' record (deps.preparedIncomeRoute) when it decides nothing
// or the record searched. Key: the same state object, timestamp and spots
// objects, mode, maxChecks and required gear flag; exact only because nothing
// yields or writes between the basics and the build of one step. The record
// keeps each price(id) the read made, in order, with its value: the build
// replays them through its own price first, so its read set, price and belief
// maps and board watch fill exactly as a fresh read would, and a price that
// came out different reads afresh. select returns plain data (no closure over price).
function incomeRouteFor(state, deps, timestamp, price, keep) {
    const decide = deps.decideEarning === true;
    const required = GearProgression.assess(state).required;
    const prepared = deps.preparedIncomeRoute;
    if (prepared && prepared.state === state && prepared.timestamp === timestamp && prepared.spots === deps.spots
        && prepared.mode === deps.mode
        && prepared.maxChecks === deps.maxChecks && prepared.required === required) {
        let same = true;
        for (let i = 0; i < prepared.reads.length; i += 2) {
            if (!Object.is(price(prepared.reads[i]), prepared.reads[i + 1])) same = false;
        }
        if (same && (prepared.searched || !decide)) { keep?.(prepared); return prepared; }
    }
    const reads = keep ? [] : null;
    const read = keep ? id => { const value = price(id); reads.push(id, value); return value; } : price;
    // The decision asks for the bot's own spot whatever its focus (required: the search's gate open); a party
    // member's foundation hunts with its party (no route: Hunt.huntIncome in the party mode).
    const found = decide ? IncomeRoute.search(state, { ...deps, timestamp, required: true, price: read }) : null;
    // The held answer is every solo bot's hunting spot; earns: the bot's hour is earned on it,
    // priced at the inputs now (heldRoute); else it levels there (its hour Hunt.huntIncome's: the foundation reads
    // only the answer's spot and charge policy, no row evaluated).
    const earns = IncomeRoute.earnsOnRoute(state, required);
    const route = found ? found.route : earns
        ? IncomeRoute.heldRoute(state, { spots: deps.spots, timestamp, price: read, mode: deps.mode }) : null;
    // searched: the route is this search's; earning: the answer it holds.
    const record = { state, timestamp, spots: deps.spots, mode: deps.mode, maxChecks: deps.maxChecks, required, reads, route, earns,
        searched: !!found, earning: found ? IncomeRoute.answerOf(found.route, timestamp, found.error, state) : state.stats?.earning ?? null };
    keep?.(record);
    return record;
}
// Is the earning spot to be decided in this build? Its
// decision is woken (a situation, or no held answer: Situations.woken), the
// bot hunts solo (a party member keeps its answer: the bit waits until it is
// solo again) and the worker holds the catalogue it searches. Main never
// decides it: it reads the held answer.
function earningDue(state, deps = {}) {
    if (isMainThread || Sections.partyIdOf(state) || ['party', 'duo'].includes(deps.mode)) return false;
    // The catalogue: the caller's, else the worker's runtime one (configure).
    const source = deps.spots ?? runtime.spots, spots = typeof source === 'function' ? source() : source;
    return Array.isArray(spots) && spots.length > 0 && Situations.woken(state.stats, 'earning_spot');
}
// The earning spot taken alone, when its own situations woke it and not the build's
// (a contest lost, the recovery lifted, a spot outleveled): the search a build runs
// (foundation's incomeRouteFor), at the bot's own prices, no wish network. Its answer
// wakes no dependant (where the bot hunts changes no purchase or trip its build holds):
// the held build serves on, its hunting leaf reads the held answer's spot and so
// does the spot it goes to when sent to hunt (BotRoute.huntSpotHeld). Far steps and near posts alike. Returns the mind keys it writes (the
// answer and the bits left; the spot marks stay, they last the outing), or null when it is not due here (main, a party member, an incoming projection waiting).
function decideEarning(state, deps = {}) {
    if (!earningDue(state, deps) || state.incomingPending) return null;
    deps = resolved(state, deps, false);
    const { price, timestamp } = personal(state, deps);
    const found = IncomeRoute.search(state, { ...deps, timestamp, required: true, price });
    const earning = Situations.withOwnFacts(state, IncomeRoute.answerOf(found.route, timestamp, found.error, state));
    return { earning, woken: Situations.decided(state.stats, 'earning_spot', { caller: deps.caller || 'economy_context',
        subject: state.characterId, answer: earning.spotId ?? 'none', was: state.stats?.earning?.spotId ?? 'none' }) };
}
// The bot's own fit for the spot of its hunting leaf:
// the route's one test, BotRoute.leafFitReader, as a yes or no per
// spot. Only in a worker build (the worker owns the leaf and its planning
// catalog; main's basics keep the table's pick, it reads them only for
// execution caps), for a solo bot (a party hunts its party's route; mode:
// the build's, as select reads it), with a catalog. The reader and its
// verdicts are kept per state object, catalog and timestamp (the frame and
// matchup profiles read only those): the basics and the build of one step
// share them. An entry dies with its state object.
const leafFits = new WeakMap();
function leafFit(state, deps, timestamp) {
    if (isMainThread || !Array.isArray(deps.spots) || !deps.spots.length
        || ['party', 'duo'].includes(deps.mode) || LevelingRoutes.modeForState(state) !== 'solo') return null;
    const kept = leafFits.get(state);
    if (kept && kept.spots === deps.spots && kept.timestamp === timestamp) return kept.fits;
    // lazy: cycle BotRoute > SpotProfiles > BotLifeState > DecisionEvents > EconomyContext
    const verdict = invoke('GameServer/Bot/Population/BotRoute').leafFitReader(state, { spots: deps.spots, timestamp });
    const verdicts = new Map();
    const fits = spotId => {
        const key = String(spotId);
        let fit = verdicts.get(key);
        if (fit === undefined) verdicts.set(key, fit = verdict(spotId) === 'fit');
        return fit;
    };
    leafFits.set(state, { spots: deps.spots, timestamp, fits });
    return fits;
}
function foundation(state, deps, persona, timestamp, price, keepRoute = null) {
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const tableRole = Table.roleFor(state);
    const income = incomeRouteFor(state, deps, timestamp, price, keepRoute), incomeRoute = income.route;
    let hunt;
    if (incomeRoute && income.earns) {
        // The search already passed this spot through the same ground and matchup reader.
        const row = incomeRoute.row;
        hunt = { perHour: incomeRoute.earning * Hunt.onSpotShare(state), perKill: row.kills > 0 ? row.income / row.kills : 0,
            expPerHour: row.exp * Hunt.onSpotShare(state), source: 'route', spotId: incomeRoute.spot.id,
            progressSpotId: incomeRoute.spot.id, answer: true, useShots: row.useShots };
    } else {
        hunt = Hunt.huntIncome(state, timestamp, deps.mode, leafFit(state, deps, timestamp));
        // A leveling bot hunts its held answer too (B12): its hour stays its own, the spot and charge policy the
        // answer's (this build's search, else stats.earning).
        const held = incomeRoute?.spot || IncomeRoute.heldSpot(state, deps.spots || [], deps.mode);
        if (held) hunt = { ...hunt, spotId: held.id, progressSpotId: held.id, answer: true,
            useShots: incomeRoute ? incomeRoute.row.useShots !== false : state.stats?.earning?.shots !== false };
    }
    const lostGearHours = hunt.perHour > 0 ? Valuation.pkDropValue(state, price) / hunt.perHour : 0;
    const bestSpotId = hunt.spotId || state.spotId;
    const walkBackHours = WalkBack.hours(bestSpotId, state, deps.spots || SpotService.spots);
    const deathHours = Valuation.deathHours(state, { ...hunt, lostGearHours, walkBackHours });
    const spotTable = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, hunt.useShots !== false) : null;
    const bestTable = spotTable || Table.best(tableRole, state.level, hunt.useShots !== false);
    const ShotStock = invoke('GameServer/Inventory/ShotStock');
    // The shot kind of this build's own earning answer when it took the decision (its search).
    const shotPlan = ShotStock.planForState(income.searched ? { ...state, stats: { ...state.stats, earning: income.earning } } : state);
    const shotItemId = shotPlan.selfId;
    const potion = HealingPotionStock.purchasePotionFor(state), potionItemId = potion.selfId;
    const hourAdena = Hunt.huntHour(hunt, state);
    const shotPolicy = ShotStock.usePolicy(state, { plan: shotPlan, bestTable,
        hourAdena, unitPrice: price(shotItemId) });
    const shotBenefit = shotPolicy.benefit;
    const beginnerCurrent = ShotStock.beginnerAmount(state, shotPlan);
    const shotUse = positive(state.inventory?.[shotItemId]?.amount) + beginnerCurrent > 0
        ? shotPolicy.usePerHour : shotPolicy.purchaseUsePerHour;
    const potionUse = positive(bestTable?.potions);
    // The bottles that save rest (a solo hunter's, RestPotion).
    const potionRest = spotTable && Hunt.situationOf(state, deps.mode) === 'solo'
        ? RestPotion.stockUse(state, { row: Table.cycle(bestSpotId, tableRole, state.level, hunt.useShots !== false),
            potion, hour: hourAdena, timestamp }) : { use: 0, hours: 0 };
    let bagHours = 2;
    const hasBagForecast = spotTable?.stacks !== null && spotTable?.stacks !== undefined;
    if (hasBagForecast) {
        const Data = DataCache;
        const race = state.stats?.race ?? (Data.classTemplates == null ? undefined : ClassProgression.firstClassRow(Data.classTemplates, state.stats?.classId || 0))?.template?.race;
        // ARCH-NOTE: size the E9 bag interval on the bag after its
        // planned kit stacks exist. Otherwise an empty shot/potion row uses
        // no slot, its refill uses one, and the shorter interval immediately
        // sells part of that refill back to the NPC. Existing stacks retain
        // the exact physical free-slot formula; zero-use stock reserves none.
        const plannedSlots = Number(shotUse > 0 && !positive(state.inventory?.[shotItemId]?.amount) && !beginnerCurrent)
            + Number(potionUse + potionRest.use > 0 && !positive(state.inventory?.[potionItemId]?.amount));
        // The kit is bought for the outing after the visit's sale: its bag is
        // the one the sale leaves (the loot carried in is no part of it), so a
        // bot arriving with a full bag of loot does not plan a half-hour outing.
        // A solo seller's next outing ends at the half-full sale while it holds
        // loot to sell; stock cannot be its own reason for an earlier visit, so
        // the whole usable kit is kept while reading the loot.
        let slotLimit = Floor.inventoryLimit(race), sold = 0;
        const keptAmounts = { [shotItemId]: positive(state.inventory?.[shotItemId]?.amount),
            ...HealingPotionStock.keptAmounts(state, { targetAmount: Infinity }),
            736: positive(state.inventory?.[736]?.amount) };
        // The cheap presence check first; the whole sale list (its slots) only for a bag that holds loot.
        const sale = { keptAmounts, preparedReservations: deps.saleReservations };
        if (Disposition.saleCandidates(state, { ...sale, presenceOnly: true })) {
            const saleLimit = Disposition.soloSaleSlotLimit(state);
            if (saleLimit !== null) slotLimit = Math.min(slotLimit, saleLimit);
            sold = Disposition.saleSlots(state, Disposition.saleCandidates(state, { ...sale, unlimited: true }));
        }
        const free = Math.max(0, slotLimit - (Floor.stateInventory(state, Data.items).slots - sold) - plannedSlots);
        bagHours = free === 0 ? 0 : spotTable.stacks > 0 ? free / spotTable.stacks : 24;
    }
    const Visits = invoke('GameServer/Bot/Economy/TownVisitInterval');
    // Bag space bounds a planned outing; it never chooses its duration.
    // Keep the existing initial estimate until actual town visits teach one.
    const targetHours = hasBagForecast
        ? Math.min(Visits.targetHours(state.stats), Visits.targetHours({}, bagHours))
        : Visits.targetHours(state.stats);
    // The kit's rates (kitReader; published as stats.kitRates): what stock()
    // and kitCost() read over the live bag, so a kept plan, a later view and
    // main answer them later without this build scope. policy: the auto-shot
    // verdict's use rates, read only in the build (DecisionEvents.nearFields).
    const allPotionUse = potionUse + potionRest.use;
    // The spot's use per hour by the one rule main reads too (EquipmentIncomeRoute.spotUseOf:
    // this build's answer on its spot, else the table at the bot's spot); the rest is the bot's
    // own. Rounded as published (StatsPacket.roundRates): the build reads what main reads.
    const use = IncomeRoute.spotUseOf(state, income.earning);
    const rates = { ...Packet.roundRates({ shotId: Number(shotItemId), shotUse: use.shotsPerHour,
        shotsPay: shotPolicy.usePerHour > 0,
        shotsCanRestock: shotPolicy.purchaseUsePerHour > 0, shotBenefit: shotPolicy.rawUse > 0 ? shotBenefit / shotPolicy.rawUse : 0,
        potionId: Number(potionItemId), potionUse: use.potionsPerHour, potionRestUse: potionRest.use,
        potionBenefit: allPotionUse > 0 ? (positive(bestTable?.deaths) * deathHours + positive(potionRest.hours)) / allPotionUse : 0,
        scrollHours: undefined, outingHours: targetHours }),
        policy: { ownedUsePerHour: shotPolicy.usePerHour, beginnerUsePerHour: shotPolicy.beginnerUsePerHour,
            paidUsePerHour: shotPolicy.paidUsePerHour } };
    const bag = kitBag(state, { plan: shotPlan, potion, beginner: beginnerCurrent, hour: hourAdena });
    const { stock, kitCost, reserve } = kitReader(rates, bag, Funding.budget(state), price,
        () => rates.scrollHours ??= scrollHoursFor(state, deps.spots, bestSpotId));
    // The published scroll hours (StatsPacket.kitRates): the build's own answer,
    // else the catalogue spot's cached one; a bot with no scroll solves its
    // route (main prices the scroll a visit may buy from them, B2).
    const scrollHours = () => rates.scrollHours ??= scrollHoursFor(state, deps.spots, bestSpotId, bag.scrolls < 1);
    return { tableRole, hunt, hourAdena, refillReserve: reserve, kitCost, rates,
        lostGearHours, bestSpotId, deathHours, bestTable, stock, scrollHours,
        earning: income.earning,
        riskWeight: Valuation.riskWeight(state, persona),
        expectedDeathHours: positive(bestTable?.deaths) * deathHours,
        karmaHours: Valuation.karmaHours(state, { ...hunt, lostGearHours, deathsPerHour: positive(bestTable?.deaths) }) };
}
// A kept foundation: the plan's pieces, its kit rates read over the live bag
// and wallet (kitReader).
function foundationFromPlan(state, plan, deps, price) {
    const bag = kitBag(state, { hour: plan.hourAdena });
    const { stock, kitCost, reserve } = kitReader(ratesNow(plan.rates, state, bag, price), bag, Funding.budget(state), price,
        () => plan.rates.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId));
    const scrollHours = () => plan.rates.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId, false);
    return { hunt: plan.hunt, hourAdena: plan.hourAdena, refillReserve: reserve,
        rates: plan.rates, stock, kitCost, scrollHours, lostGearHours: plan.lostGearHours, bestSpotId: plan.bestSpotId,
        earning: plan.earning,
        deathHours: plan.deathHours, riskWeight: plan.riskWeight,
        expectedDeathHours: plan.expectedDeathHours, karmaHours: plan.karmaHours };
}
// What the basics read before the income search: a sale or a bid asks no more.
function personal(state = {}, deps = {}) {
    deps = resolved(state, deps, false);
    const timestamp = Number(deps.timestamp || Date.now());
    const persona = personaOf(state, deps);
    const board = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    return { persona, price: pricing(state, persona, board, timestamp, deps).price, timestamp };
}
function basics(state = {}, deps = {}) {
    deps = resolved(state, deps, false);
    const { persona, price, timestamp } = personal(state, deps);
    let route = null;
    // The main thread records only on request (deps.keepIncomeRoute): its builds never read a record.
    const keep = !isMainThread || deps.keepIncomeRoute ? record => { route = record; } : null;
    const base = { persona, price, timestamp, ...foundation(state, deps, persona, timestamp, price, keep) };
    // Not enumerable: a view spread over these basics does not carry it (L120).
    Object.defineProperty(base, 'preparedIncomeRoute', { value: route });
    return base;
}
// A route table with a row for every town (EconomicTrip.prepare).
const fullRoute = rows => Array.isArray(rows) && rows.length === Trip.towns.length;
// The bot's held build's key (cache) and its group's.
const actorKeyOf = (state, deps) => deps.actorKey || `character:${Number(state.characterId || 0)}`;
// What a build reads beside the held entry: the gear threat, the facts, read once
// (the held leaf's own trip is read as the field activity it ordered,
// fieldActivity), and the build's input name.
// view: the facts' stateView (requestFacts' reads).
function heldReadsOf(state, deps, held) {
    const gearThreat = GearThreat.prepare(state, deps, held?.gearThreat);
    const current = fieldActivity(state, held?.activity, held?.plan.network?.activity);
    const view = Sections.stateView(current, Providers.recipeIds(current, deps));
    const facts = Sections.factsOf(view, deps.memory ?? null);
    return { gearThreat, current, facts, view, key: inputName(facts, gearThreat.mask) };
}
// The held entry and what a build reads beside it, over resolved deps, which it
// completes with the route rows and the gear-threat mask the build reads.
function heldReadsFor(state, deps) {
    if (typeof deps.routeRows === 'function') deps.routeRows = deps.routeRows(state);
    const held = cache.get(actorKeyOf(state, deps));
    // A valid completed card survives planner-slot reuse or card eviction;
    // the same route is repriced with the current hour value, never a wallet.
    if (!deps.routeRows && held?.plan.routeKey === Trip.key(state)) deps.routeRows = held.plan.routeRows;
    // A build never waits for its route. In the background thread a caller
    // whose own route preparation was refused (occupationFor mode wish at its
    // 64-request cap: the party goal query, the post-round economy ask, the
    // gear step) gets it here, in the same call. Main builds with an unknown
    // route instead (Die, GearPlanSelection, HealingPotionStock, ScrollStock,
    // ShotStock: no route request from main).
    if (!isMainThread && !deps.tripCost && !fullRoute(deps.routeRows)) {
        deps.routeRows = Trip.prepared(state);
        // Read live: a high share against context builds says the 64-request
        // cap refuses too often.
        if (Diagnostics.active()) Diagnostics.count('context', 'route', 'inline');
    }
    const reads = heldReadsOf(state, deps, held);
    deps.gearThreatMask = reads.gearThreat.mask;
    return { held, reads };
}
// The computed pieces a build keeps from its held entry while the facts each reads
// are the same (fact-keyed caches): the foundation (hunt
// income, risk, death and kit hours, kit rates: the kit, death, recovery, the shots'
// and potions' place against their lines (the lines fact; which shot and potion the kit
// names is in the kit fact), spot, party and clan, and the held earning answer it
// hunts: its spot and time), the source walk's ground verdict (the kit) and the quiet
// build's followed gear (the kit and a death); the route search's (the kit, party,
// clan, spot, risk) drops the held hunt spot when it moves.
const PIECE_FACTS = Object.freeze({
    foundation: ['build', 'dead', 'recovery', 'riskDeaths', 'lines', 'occupation', 'relations', 'party', 'earning'],
    ground: ['build'], gear: ['build', 'dead'], route: ['build', 'relations', 'party', 'occupation', 'riskDeaths', 'recovery']
});
const pieceKeys = (facts, earning) => Object.fromEntries(Object.entries(PIECE_FACTS).map(([piece, names]) =>
    [piece, Sections.hash(names.map(name => name === 'earning' ? [earning?.spotId ?? null, earning?.at ?? null] : facts[name] ?? null))]));
// Who decides and who reads. deps.decide: the bot's own
// decision point its gate let build (a woken build: ColdSimulationWorker's step, a
// party member's or a near body's); it builds and keeps. A caller that names the
// bot's own step (DECIDING) decides unless it says otherwise. Every other caller reads: the
// held entry while its identity holds (proofIdentity), else it builds; a reader's build
// is kept unless its caller keeps none (a meeting's goods, a deferred plan's page, a
// party's goal query, an item need).
const NO_KEEP = new Set(['meeting_prepare', 'economy_page', 'workerPartyGoal', 'item_need']);
const DECIDING = new Set(['step', 'member', 'party', 'karma', 'party_request']);
function forState(state = {}, deps = {}) {
    return Disposition.withReservations(() => buildForState(state, deps));
}
// The items a bot at work follows (a quiet build's gear): what the last review's
// roots and admission name, free ones too, its rare piece; the focus and the
// plan's target stand for themselves. A review weighs every candidate again.
let quietGearBuilds = 0;
const nodesBuilt = new WeakSet();
// The doors to a build: [built, served, left to the bot's step, read as held, moved down its agenda]
// per caller; no name reads hidden.
const doors = {};
const passed = (deps, how) => { (doors[deps.caller || 'hidden'] ||= [0, 0, 0, 0, 0])[how]++; };
// A named count beside the doors (the health line's why rows): `<door>|<reason>`.
const countDoor = name => { (doors[name] ||= [0])[0]++; };
function rootItems(projection) {
    const { admitted = [], rare } = projection.admission;
    return Int32Array.from(new Set([...projection.roots.map(Network.rootItem), ...admitted.map(row => Network.rootItem(row.key)), Number(rare) || 0].filter(Boolean)));
}
function followedGear(state, held) {
    const ids = new Set(held.gearFollowed);
    for (const id of Providers.followedGear(state)) if (id) ids.add(id);
    return ids;
}
// What the agenda moves to when the held leaf's step ended on a visit (Agenda.advance:
// why, the leaf check's reason): the visit's next stop, carried out with no build
// (deps.visitStop, the step's own move), or a woken build's first move. dropped:
// receives the steps it dropped. facts:
// the state's facts now, the move's baseline as a build's (Sections.snapshot): gear the
// visit bought and wore is the build's own answer, no gear_changed later.
function advanced(held, why, state, deps, dropped, facts) {
    const own = resolved(state, deps, false);
    return Agenda.advance(held, state, why, deps, {
        refused: leaf => leafCheck(state, leaf, deps, { heldUnits: leaf.heldAtDecision, current: null, prepared: {} }),
        bestOffer: leaf => townOffer(state, leaf, own, tripOf(state, own), false),
        progress: leaf => ColdEconomyDecision.progressSince(withHeldUnits(leaf, held.heldUnits), state),
        held: id => ColdEconomyDecision.heldFor(state, id),
        visitPays: (leaf, rest) => Valuation.visitPays({ moneyPrice: held.plan.network.moneyPrice, riskWeight: held.plan.riskWeight },
            [leaf, ...rest.filter(step => step.town === leaf.town)], tripOf(state, own).details?.(leaf.town)),
        dropped: (leaf, cause) => dropped.set(stepPlace(leaf), cause),
        identity: activityIdentity,
        baseline: kept => ({ ...Sections.unspent(kept, Funding.budget(state, deps.buyOrderEscrow), Funding.budget(state)), ...facts }) });
}
// A step by what it does and where, for the health line's repick row: a build after a
// dropped step that takes it again names two answers to one question that disagree.
const stepPlace = leaf => `${leaf.activity}|${leaf.kind}|${leaf.itemId}|${leaf.town}`;
// The decision links' counts,
// developerDiagnostics only; no decision reads them. Per bot, on its held
// entry (held.links, carried to the entry that replaces it, gone with the
// entry: evicted, forgotten or reset): what each link's answer was built on.
// link:<link>:<outcome>. routeRows is a shadow, the key's decision first: rebuilt:<input> both rebuild (the first input that
// moved); kept:quiet both keep; kept:mask-only the route key rebuilds what
// the key on its fields would keep; rebuilt:key-only:<input> the reverse, once
// per held answer; first: nothing to compare (its key is its inputs:
// test_economic_trip_marginal reads the table on the full state).
const linkTotals = {};
// The links still decided by masks: their rows split what the key would decide.
const SHADOW_LINKS = new Set(['routeRows']);
function linkCount(link, outcome) {
    Diagnostics.count('link', link, outcome);
    const row = linkTotals[link] ||= { rebuilt: 0, kept: 0, ...(SHADOW_LINKS.has(link) ? { maskOnly: 0, keyOnly: 0 } : {}),
        unjudged: 0 };
    const [what, why] = outcome.split(':');
    if (what === 'first' || what === 'resync') row.unjudged++;
    else { row[what]++; if (why === 'mask-only') row.maskOnly++; else if (why === 'key-only') row.keyOnly++; }
}
function linkStats() {
    const out = {};
    for (const [link, row] of Object.entries(linkTotals)) out[link] = { ...row };
    return out;
}
const linkJudged = (rebuiltToday, moved) => moved ? rebuiltToday ? `rebuilt:${moved}` : `rebuilt:key-only:${moved}`
    : rebuiltToday ? 'kept:mask-only' : 'kept:quiet';
// A link's own inputs of the versions: what held.links keeps (the route rows'
// 7 small values per bot, diagnostics only).
function linkOwn(link, versions) {
    const { discrete, continuous } = Sections.LINK_INPUTS[link], own = {};
    for (const name of discrete) own[name] = versions[name];
    for (const name of continuous) own[name] = versions[name];
    return own;
}
// The route rows at a rebuild.
function buildShadow(seen, held, routeKey, versions) {
    if (!seen.routeRows) linkCount('routeRows', 'first');
    else linkCount('routeRows', linkJudged(!!held && held.plan.routeKey !== routeKey, Sections.movedInput('routeRows', seen.routeRows, versions)));
    seen.routeRows = linkOwn('routeRows', versions);
}
function buildForState(state, deps) {
    const diagnostic = Diagnostics.active();
    const inputSequence = Number(state.stats?.decisionSeq || 0);
    if (diagnostic) Diagnostics.count('context', 'request');
    deps = resolved(state, deps);
    const timestamp = Number(deps.timestamp || Date.now());
    const actorKey = actorKeyOf(state, deps);
    // lazy: worker the board's owner lives on main; the worker passes its board.
    const sourceBoard = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    const decide = (deps.decide ?? DECIDING.has(deps.caller)) === true, keeps = decide || !NO_KEEP.has(deps.caller);
    const { held, reads } = heldReadsFor(state, deps);
    const { gearThreat, current, facts, key } = reads;
    // A woken build on a town visit first moves the agenda over the held entry
    // (temporary: until the town plan holds the visit's stops itself): the step its leaf check ended goes, the next one serves.
    const dropped = new Map();
    const visitEnd = decide && held && !deps.fullReview && Situations.onVisit(state)
        ? leafCheck(state, held.plan.network?.activity, deps, { heldUnits: held.heldUnits, current: null, prepared: {} }) : '';
    const next = visitEnd ? advanced(held, visitEnd.reason, state, deps, dropped, current === state ? facts : requestFacts(state, deps)) : null;
    // The step's next stop (deps.visitStop) that the agenda cannot move to (each stop
    // left refused or not worth its visit: Agenda.advance ends) is the visit's end: its
    // outcome raised wakes the build, as with no stop left (EconomyContext.visitStopsLeft).
    if (visitEnd && !next && deps.visitStop) state = { ...state,
        stats: Situations.raise({ ...state.stats }, deps.visitStop, null, Situations.place(state), state.characterId) };
    // A reader is served the held entry while its identity holds. A caller that needs
    // the member's graph nodes (a worker group solve) builds unless the held entry kept
    // them (the main thread keeps them, the worker a party member's).
    const holds = !decide && !!held && !proofIdentity(state, held.plan.eventProof, held.plan.network?.activity);
    if (next || holds && !(deps.withNodes && !held.projection)) {
        passed(deps, next ? 4 : 1);
        const entry = next || held;
        if (deps.onSourceRead) for (const id of entry.readIds) deps.onSourceRead(id);
        if (diagnostic) {
            Diagnostics.count('context', 'hit', held.key === key ? 'same_inputs' : 'own_result');
            // The timeline sees the served request too (tools/timeline).
            if (Trace.detailed(state.characterId)) Trace.detail({ owner: state.characterId,
                caller: deps.caller || 'economy_context', trigger: deps.trigger || 'request', phase: 'wish_context',
                reason: held.key === key ? 'hit_same_inputs' : 'hit_own_result', outcome: 'held',
                revision: state.simulation?.revision, wallet: positive(state.adena) });
            entry.links ||= held.links || {};
        }
        if (keeps) {
            entry.gearThreat = gearThreat;
            entry.stateRef = new WeakRef(state);
            remember(cache, actorKey, entry, RETAIN_LIMIT);
        }
        // A late price read of a held plan is reported as in its build.
        const late = id => deps.onSourceRead?.(Number(id));
        const served = view(state, entry.plan, deps, { board: sourceBoard, read: late, projection: entry.projection });
        // The visit's next stop (deps.visitStop): the held plan moves on, no decision is
        // taken. Else the agenda's move is the woken build's answer: it takes the build.
        if (next && deps.visitStop) Situations.note('town_plan:next_stop');
        else if (next) served.statsPacket.woken = Situations.decided(state.stats, 'build', { caller: deps.caller || 'economy_context',
            subject: state.characterId, answer: !Trace.on() ? null : next.plan.network.activity?.key });
        return served;
    }
    // The pieces kept from the held entry while the facts each reads are the same
    // (PIECE_FACTS). The foundation is reused with the prices and the horizon it was
    // priced with, and the persona and the town-visit rhythm with it.
    // The earning spot to decide (earningDue): its search runs in a rebuilt foundation.
    // Not while an incoming projection waits: that build returns before it publishes anything.
    const pieces = pieceKeys(facts, state.stats?.earning);
    const decideEarning = decide && earningDue(state, deps) && !state.incomingPending;
    const keptBase = held && held.pieces?.foundation === pieces.foundation && !decideEarning ? held.plan : null;
    // The source walk's per-spot ground verdict (GearAcquisitionPlanner.sourceGround).
    const keptGround = held?.pieces?.ground === pieces.ground ? held.sourceGround || null : null;
    // A build the gear plan did not wake weighs only the gear the bot follows:
    // every candidate is weighed only in the gear plan's own review (deps.fullReview).
    const heldGear = !deps.fullReview && held?.gearFollowed
        && held.pieces?.gear === pieces.gear ? followedGear(state, held) : null;
    if (heldGear) quietGearBuilds++;
    passed(deps, 0);
    // A build for the nodes alone names whose: a party's member or a candidate it asks to join,
    // and a held plan built for its nodes before (the same answer built again).
    const nodes = `nodes:${Sections.partyIdOf(state) ? 'member' : 'candidate'}${held && nodesBuilt.has(held) ? '_again' : ''}`;
    if (held && deps.withNodes) nodesBuilt.add(held);
    // Why a door built (a door other than the step here): a woken build, a reader's
    // unproved held entry, none held, or the nodes.
    const why = decide ? 'woken' : !held ? 'none_held' : deps.withNodes && holds ? nodes : 'unproved';
    if (deps.caller !== 'step') (doors[`${deps.caller || 'hidden'}|${why}`] ||= [0])[0]++;
    else if (diagnostic) Diagnostics.count('context', 'step_door', why);
    const started = diagnostic ? performance.now() : 0;
    // The build's cause, one of a few names (its duration layer).
    const diagnosticReason = !diagnostic ? null : !held ? keeps ? 'not_retained' : 'unkept_caller'
        : decide ? 'woken' : held.key !== key ? 'input_dependency_changed' : 'nodes_needed';
    if (diagnostic) Diagnostics.count('context', 'miss', diagnosticReason);
    let elapsed = 0;
    // The items the review read, each reported once (deps.onSourceRead, the
    // occupation planner's dependencies) and kept with the held entry
    // (held.readIds) so that a hit reports them again. No token: the market
    // is heard at the soft point through the watch list.
    let readIds = new Set();
    let building = true;
    // MVP-6 Bounds: while a gear candidate's arena is built its reads wait
    // in its own scope; the provider keeps the scopes whose descriptors
    // survive the final cut, so a rejected candidate's items never become
    // inputs of the review.
    let scope = null;
    const nodeScopes = [];
    // The build is one synchronous call and the bag does not move during it:
    // its id list is read once.
    let bagIds = null;
    const read = id => { id = Number(id);
        if (!(id > 0)) return;
        // Every open node scope notes the id once (an id the innermost holds,
        // every outer one holds too): a reused node reports it again.
        const top = nodeScopes[nodeScopes.length - 1];
        if (top && !top.items.has(id)) for (const local of nodeScopes) local.items.add(id);
        // After the build (a late read through its view) nothing is kept.
        if (!readIds) { deps.onSourceRead?.(id); return; }
        if (readIds.has(id)) return;
        if (scope) { scope.add(id); return; }
        readIds.add(id); deps.onSourceRead?.(id);
    };
    const watch = id => { if (building) read(id); };
    const persona = personaOf(state, deps);
    const board = watchedBoard(sourceBoard, watch);
    // A price is remembered, so every price read counts, also a late one
    // through context.price: its item joins the review's inputs.
    const { price, peek, prices, knowledgeEnabled } = pricing(state, persona, board, timestamp, deps, read,
        keptBase ? new Map(keptBase.prices) : new Map(), sourceBoard);
    // The income route record of this build (its own search or the basics'
    // one): its solo matchup profiles serve the providers' source route reader.
    let incomeRecord = null;
    // The rebuilt foundation searches the earning spot when its decision is due
    // (decideEarning), else it reads the held answer's route (a supply build, a
    // clan or friend change, a learned recipe).
    const base = keptBase ? foundationFromPlan(state, keptBase, deps, price)
        : foundation(state, { ...deps, decideEarning }, persona, timestamp, price, record => { incomeRecord = record; });
    // The earning spot decided here: its answer is published with the build (statsPacket.earning).
    const earningDecided = !keptBase && incomeRecord?.searched === true;
    // These facts still belong to the reused foundation: its items stay read.
    if (keptBase) for (const id of held.readIds) read(id);
    // A price read inside a node scope is noted as priced there too: a kept
    // gear list replays it as a price read (the price memo is part of the plan).
    const pricedRead = id => {
        for (const local of nodeScopes) local.priced.add(Number(id));
        return price(id);
    };
    const context = { inputKey: key, actorKey, state, timestamp, gearThreatMask: gearThreat.mask, heldGear, persona, board, hunt: base.hunt,
        price: pricedRead, peekPrice: peek, buyback,
        ...(keptBase ? { horizonHours: keptBase.horizonHours } : {}),
        riskWeight: base.riskWeight, bestSpotId: base.bestSpotId, deathHours: base.deathHours, lostGearHours: base.lostGearHours,
        karmaHours: base.karmaHours, expectedDeathHours: base.expectedDeathHours, stock: base.stock,
        // The earning answer this build holds (its own search's or the held one): the kit's per-spot use.
        earning: base.earning,
        refillReserve: base.refillReserve, kitCost: base.kitCost, hourAdena: base.hourAdena,
        // What a node read, so that a later candidate of this build reusing
        // the node reads it again: a rejected candidate's reads are not kept.
        nodeInputs: { begin: () => { const local = { items: new Set(), bag: new Set(), priced: new Set() }; nodeScopes.push(local); return local; },
            end: () => nodeScopes.pop(), read,
            bag: id => { if (!(Number(id) > 0)) return;
                for (const local of nodeScopes) local.bag.add(Number(id)); },
            wholeBag: () => { if (!nodeScopes.length) return;
                bagIds ??= Object.keys(state.inventory || {}).filter(id => Number(id) !== 57);
                for (const id of bagIds) context.nodeInputs.bag(id); },
            keep: input => { for (const id of input.items) read(id);
                for (const id of input.bag) context.nodeInputs.bag(id); } },
        readScope: { open: () => (scope = new Set()), close: () => { scope = null; },
            keep: kept => { for (const id of kept) read(id); } } };
    context.routeKey = Trip.key(state); context.routeRows = fullRoute(deps.routeRows) ? deps.routeRows : null;
    // The link shadow's record, carried to the entry this build keeps.
    const links = diagnostic ? held?.links || {} : undefined;
    if (diagnostic) {
        buildShadow(links, held, context.routeKey, Sections.routeVersions(state));
    }
    const tripHour = context.hourAdena;
    context.trip = deps.tripCost || Trip.preparedReader(context.routeRows || [], { hourAdena: tripHour });
    const readSpot = SpotEconomics.create(state, { ...deps, timestamp, persona, price, deathHours: context.deathHours,
        hunt: buildHunt(base.hunt) });
    context.spotValue = readSpot;
    if (state.incomingPending) {
        // ARCH-NOTE: an oversized incoming projection waits on the existing
        // settlement/preparation owner. Never replace unknown stock with zero
        // demand or renew the decision seed while that input is unavailable.
        context.network = { inputKey: key, queue: [], activity: null, plans: new Map(), demands: new Map(),
            focus: state.stats?.wishFocus || null, dormant: state.stats?.dormantWishes || [],
            moneyPrice: positive(Packet.moneyPrice(state.stats?.money)), hourAdena: context.hourAdena, available: 0,
            decisionSeq: state.stats?.decisionSeq || 0, activityLeaf: state.stats?.activityLeaf || 0 };
        context.moneyPrice = context.network.moneyPrice; context.gapHorizonHours = 0;
        context.watchList = []; context.intentPending = true;
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        context.statsPacket = { wishFocus: context.network.focus, dormantWishes: context.network.dormant,
            decisionSeq: context.network.decisionSeq, activityLeaf: context.network.activityLeaf,
            money: state.stats?.money || Packet.money({ hourAdena: 0, moneyPrice: 0, refillReserve: base.refillReserve, firstUnfundedPrice: 0 }), kitRates: state.stats?.kitRates || kitRates(base),
            dangerPrice: dangerPrice(base) };
        readIds = null;
        return view(state, planOf(context, base, { key, tripHour, prices }), deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip });
    }
    // One stock reader for the provider's gear witnesses and the network
    // build; the projection is read lazily once it exists (stock roots).
    context.wallet = Funding.budget(state, deps.buyOrderEscrow);
    const nativeStock = stockReader(state, rootKey => context.projection?.nodes.find(node => node.key === rootKey)?.object?.itemId, sourceBoard);
    context.stockFor = (id, rootKey) => nativeStock(id, rootKey);
    context.completionKey = Crystallization.completionKey(state);
    const extra = [...extensions.values()].flatMap(provider => provider(state, context) || []);
    if (diagnostic) {
        Diagnostics.count('context', 'caller', deps.caller || 'economy_context');
        Diagnostics.count('context', 'foundation', keptBase ? 'kept' : 'built');
    }
    // The held build's source facts (KeptSourceFacts) and gear candidates
    // (KeptGearCandidates): each judged by its own inputs.
    const projection = Providers.build(state, context, { ...deps, sourceGround: keptGround, keptFacts: held?.keptFacts || null,
        keptGear: held?.keptGear || null,
        nodes: [...(deps.nodes || []), ...extra], soloProfiles: incomeRecord?.route?.matchupProfiles });
    context.projection = projection;
    const networkKey = key;
    // A woken build re-weighs the held focus and step (WishNetwork reconsider): a
    // situation woke it. A reader's build keeps them, and so does a first build (no
    // held entry: a restart, an eviction): the published focus and step stand.
    const reconsider = decide && !!held;
    const network = engine.build({ actorKey, inputKey: networkKey, ...projection,
        remembered: keeps,
        stockFor: context.stockFor,
        completionKey: context.completionKey,
        characterId: state.characterId, decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
        wallet: context.wallet, bag: Funding.budget(state), ownBids: Funding.ownBids(sourceBoard?.ownerLines?.(Number(state.characterId))),
        refillReserve: base.refillReserve,
        reconsider,
        // Diagnostics only: the events that re-weigh (network:reconsider), 'quiet' for none.
        reconsiderReasons: !diagnostic ? null : [decide ? 'woken' : 'quiet'],
        playedHours: positive(state.stats?.playedHours), persona,
        previous: { focus: state.stats?.wishFocus, dormant: state.stats?.dormantWishes },
        hourAdena: context.hourAdena, riskWeight: context.riskWeight,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason || 'context_build' });
    context.inputKey = networkKey;
    context.horizonHours = projection.horizon;
    context.network = network;
    context.moneyPrice = network.moneyPrice;
    context.hourAdena = network.hourAdena;
    // Affordability removes a funding gap, not the benefit lost while waiting.
    const urgent = network.gap || network.queue.find(row => row.key === network.focus?.[0]) || network.queue[0];
    // At the precision the kit rates publish it (StatsPacket.roundRate): main's trader reads the same.
    context.gapHorizonHours = Packet.roundRate(!urgent ? 0 : urgent.key === 'stock:shots' ? base.stock('shots').targetHours
        : urgent.key === 'stock:potions' ? base.stock('potions').targetHours : projection.horizon);
    Object.assign(context, valueReaders(state, network, projection.values, persona, knowledgeEnabled,
        base.kitCost, () => context.statsPacket.money));
    context.watchList = TradeIntent.project(state, network, projection, id => context.worth(id) ?? price(id),
        BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.buy_ad, context.board, context.trip?.details, base.survivalReserve);
    context.intentPending = context.watchList === null;
    context.watchList ||= [];
    context.statsPacket = { wishFocus: network.focus, dormantWishes: network.dormant,
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        money: Funding.packetFor(network, context.hourAdena, base.refillReserve), kitRates: kitRates(base, context.gapHorizonHours),
        dangerPrice: dangerPrice(base) };
    // The decisions this build took (only this build's result carries them, never a plan served later): the build,
    // and the earning spot when it searched (its held answer published; the spot marks it read stay, they last the
    // outing, SpotRiskPolicy.LIFETIME; a mark raised meanwhile is a body's pending raise, applied again over this
    // answer: DecisionEvents.receive, the worker's next bag).
    // The bag's town trip too (a build bag_full wakes): its need, or
    // none (PartyMarketBreak.cleanupDecision), held in stats.cleanupDue until the trip starts.
    // Temporary: until the town visit's sell stop (an unload root) owns the bag's trip.
    // A reader's build takes no decision of the bot's: it clears nothing (counted).
    if (!decide) Situations.note(`build:reader:${deps.caller || 'economy_context'}`);
    const decided = !decide ? {} : { ...(earningDecided ? { earning: base.earning } : {}),
        cleanupDue: invoke('GameServer/Bot/Population/PartyMarketBreak').cleanupDecision(state, Number(context.timestamp) || Date.now()),
        woken: Situations.decided(state.stats, earningDecided ? ['earning_spot', 'build'] : 'build', { caller: deps.caller || 'economy_context',
            subject: state.characterId, answer: !Trace.on() ? null : { earning_spot: [base.earning?.spotId ?? 'none', state.stats?.earning?.spotId ?? 'none'],
                build: [network.activity?.key || network.focus?.[0], held?.plan.network?.activity?.key || held?.plan.network?.focus?.[0]] } }) };
    // The money queue's cumulative costs (its money thresholds, Sections.snapshot): the
    // focus's and the gear plan's market piece's (goal_affordable:focus), the held leaf's
    // funded row's (out_of_money).
    const gearPlan = state.stats?.equipmentPlan;
    const planned = gearPlan?.strategy === 'market' && gearPlan.status === 'active' ? Number(gearPlan.target?.selfId) || 0 : 0;
    let cumulative = base.refillReserve;
    for (const wish of network.queue) {
        cumulative += cashCharge(wish);
        if (wish.key === network.focus?.[0]) context.goalBudget = cumulative;
        if (planned && !context.plannedBudget && Network.rootItem(wish.key) === planned) context.plannedBudget = cumulative;
        if (wish.key === network.activity?.rootKey && wish.funded) context.leafBudget = cumulative;
    }
    // The build's facts for its baseline: the request's when they were read
    // over this state itself (no held leaf's field activity in between).
    context.statsPacket.wishSections = Sections.snapshot(state, context, { buyOrderEscrow: deps.buyOrderEscrow },
        current === state ? facts : requestFacts(state, deps));
    building = false;

    if (diagnostic) {
        Diagnostics.count('context', 'build', diagnosticReason);
        // Builds per worker step (one step's requests share its timestamp):
        // repeat = a second build of the same bot in one step (the goal: 0).
        if (!isMainThread) Diagnostics.count('context', 'step_build', held?.plan.timestamp === timestamp ? 'repeat' : 'first');
        // Per reason too: a wave's builds cost ~3x a calm one's (2026-10-15);
        // the split says whether lost retention or a moved input is the dear one.
        elapsed = performance.now() - started;
        Diagnostics.duration('context', elapsed);
        Diagnostics.duration(`context:${diagnosticReason}`, elapsed);
    }
    // The build's record carries its cause (tools/timeline): the miss reason and the time it took.
    if (diagnostic && Trace.detailed(state.characterId)) Trace.detail({ owner: state.characterId,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason,
        phase: 'wish_context', reason: diagnosticReason, inputHash: fnv1a32(networkKey),
        durationMs: Math.round(elapsed * 100) / 100,
        sequence: inputSequence, decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        revision: state.simulation?.revision, wallet: positive(state.adena), escrow: positive(deps.buyOrderEscrow),
        available: network.available, reserve: base.refillReserve, wishKey: network.focus?.[0],
        gate: decide ? 'woken' : 'reader',
        heldFocus: held?.plan.network.focus?.[0], freshFocus: network.focus?.[0],
        heldLeaf: held?.plan.network.activity?.key, freshLeaf: network.activity?.key });
    const plan = planOf(context, base, { key, tripHour, projection, knowledgeEnabled, prices });
    // A step's count is taken here: what reaches the bag on the way is its progress.
    if (plan.network.agenda) plan.network.agenda = plan.network.agenda.map(step => withHeldUnits(step, ColdEconomyDecision.heldFor(state, step.itemId)));
    // Its place in the money queue, as the card stamps it: a material has no packet row of its own.
    if (plan.network.activity?.kind === 'buy') {
        Funding.stampRatio(plan.network.activity, plan.network.queue.find(wish => wish.key === plan.network.activity.rootKey));
    }
    const repick = plan.network.activity && dropped.get(stepPlace(plan.network.activity));
    if (repick) countDoor(`agenda_repick|${repick}`);
    // The ground verdict, the kept source facts and gear candidates belong
    // only to the held build entry (bounded by RETAIN_LIMIT, each ground by 2
    // bits per planning spot, the facts by KeptSourceFacts.LIMIT, the gear by
    // KeptGearCandidates). A planning view or a group closure must never
    // retain a second copy.
    const retainedGround = projection.sourceGround, retainedFacts = projection.keptFacts, retainedGear = projection.keptGear;
    projection.sourceGround = null; projection.keptFacts = null; projection.keptGear = null;
    if (keeps) {
        if (diagnostic && !cache.has(actorKey) && cache.size >= RETAIN_LIMIT) Diagnostics.count('context', 'eviction', 'capacity');
        // The main thread keeps the graph nodes as before (its group solve
        // reads them on a hit); the worker keeps a party member's too (its
        // party goal query reads them on a hit), a solo bot's plan only
        // (perf C1).
        plan.eventProof = captureEventProof(state, deps, { plan });
        // What the card stamps on its leaf, read by its executors: the own item's
        // bag+incoming at the decision (heldAtDecision) and a craft's reserved
        // inputs (craftReservations).
        const leaf = plan.network?.activity;
        remember(cache, actorKey, { key,
            heldUnits: ColdEconomyDecision.heldAtDecisionOf(leaf, state),
            craftReservations: leaf?.activity === 'crafting' ? CraftInputReservations.heldCraftRows(state, plan.network.craftNeeds) : undefined,
            readIds: Int32Array.from(readIds), plan, stateRef: new WeakRef(state), gearThreat, links,
            // A quiet build sees only the followed gear: a list it shortened is no review.
            gearFollowed: heldGear ? held.gearFollowed : rootItems(context.projection),
            activity: state.activity, pieces,
            sourceGround: retainedGround, keptFacts: retainedFacts, keptGear: retainedGear, mp: Number(state.vitals?.mp),
            projection: (isMainThread || Sections.partyIdOf(state)) ? projection : null }, RETAIN_LIMIT);
    }
    // A party's question built the nodes of a plan that stands: the plan keeps them, as
    // a member's own build does, and the next question reads them.
    else if (deps.withNodes && holds && !held.projection && Sections.partyIdOf(state)) held.projection = projection;
    readIds = null;
    const built = view(state, plan, deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip, projection });
    Object.assign(built.statsPacket, decided);
    // The route search's facts moved since the held build (worker-local, never
    // posted): the worker drops the held hunt spot (BotRoute.drop).
    built.routeMoved = !held || held.pieces?.route !== pieces.route;
    return built;
}
// Plan as data (perf C1). A built context's closures hold the wish network,
// the projection and the whole build scope (~60 KB per bot); what its readers
// act on is a few KB of results. The cache keeps this plan, and every reader,
// the building caller included, gets view(state, plan, deps): the same fields
// and functions, answered from the plan, the state it is given and the kit
// data, without a second wish build.
// Plan nodes keep only what post-build readers walk: the materials of the
// decision card (ColdEconomyDecision.capture), TradeIntent.project and
// npcOwnsPurchase, WishProviders.personalCraftPlan. Shared nodes stay shared.
// A requirement row without its plan is looked up by key in network.plans
// (personalCraftPlan); `unresolved` collects those keys for the kept map.
const NODE_FIELDS = ['kind', 'sourceType', 'quoted', 'executable', 'recipeId', 'missingAmount', 'improvement', 'unseal', 'batches', 'keyInputs',
    'unitPrice', 'town', 'availableUnits'];
function planTrimmer(unresolved = new Set()) {
    const seen = new Map();
    const trim = plan => {
        if (!plan || typeof plan !== 'object') return plan;
        if (seen.has(plan)) return seen.get(plan);
        // Absent fields stay absent and an empty requirement list is one
        // shared frozen array: a bot keeps ~20 nodes, most of them buys.
        const out = {};
        for (const field of NODE_FIELDS) if (plan[field] !== undefined) out[field] = plan[field];
        if (plan.workshop) out.workshop = { characterId: plan.workshop.characterId, price: plan.workshop.price,
            loc: plan.workshop.loc, townName: plan.workshop.townName,
            ...(plan.workshop.publicStation ? { publicStation: true } : {}) };
        seen.set(plan, out);
        if (plan.grossRequirements) out.grossRequirements = plan.grossRequirements.map(row => ({ key: row.key,
            amount: row.amount, ...(row.once ? { once: true } : {}) }));
        if (plan.intentionPath !== undefined) out.intentionPath = trim(plan.intentionPath);
        if (plan.execution) out.execution = { ...trim(plan.execution), availableUnits: plan.execution.availableUnits };
        if (plan.requirements) out.requirements = !plan.requirements.length ? Agenda.NO_REQUIREMENTS : plan.requirements.map(row => {
            if (!row.plan) unresolved.add(row.key);
            return { key: row.key, amount: row.amount, plan: trim(row.plan) };
        });
        return out;
    };
    return trim;
}
// Queue rows keep the fields read after the build (funding, the money packet
// ratio, the card, trade intents, gear and companion choices). network.plans
// keeps the item plans (TradeIntent.npcOwnsPurchase asks by `item:<id>`) and
// the plans of requirement rows that have none. A selected crystal operation
// also keeps its one root: owned inputs can remove it from the money queue.
// craftNeeds: the selected craft's inputs, walked once on the full network
// for the card and the held verdict (absent when the root is no craft).
function compactNetwork(network) {
    const unresolved = new Set(), trim = planTrimmer(unresolved);
    const facts = wish => ({ key: wish.key, need: wish.need, object: wish.object, price: wish.price, reserved: wish.reserved,
        valueHours: wish.valueHours, ratio: wish.ratio, funded: wish.funded,
        supported: wish.supported, resolved: wish.resolved, progressionPriority: wish.progressionPriority });
    const row = wish => ({ ...facts(wish), plan: trim(wish.plan) });
    const queue = (network.queue || []).map(row);
    const at = network.gap ? (network.queue || []).indexOf(network.gap) : -1;
    const leaf = network.activity;
    const activity = !leaf ? leaf : { ...leaf,
        ...(leaf.requirements ? { requirements: leaf.requirements.map(item => ({ ...item, plan: trim(item.plan) })) } : {}),
        ...(leaf.intentionPath ? { intentionPath: trim(leaf.intentionPath) } : {}) };
    const all = network.plans || new Map(), plans = new Map();
    for (const [key, plan] of all) if (key.startsWith('item:')) plans.set(key, trim(plan));
    if (leaf?.rootKey?.startsWith('power:') && ['crystallize', 'luxury_exchange', 'mammon_unseal'].includes(leaf.kind)
        && all.has(leaf.rootKey)) plans.set(leaf.rootKey, trim(all.get(leaf.rootKey)));
    for (const key of unresolved) if (!plans.has(key) && all.has(key)) plans.set(key, trim(all.get(key)));
    const craftNeeds = CraftInputReservations.selectedCraftNeeds(network);
    // The network's input key is the plan's key with its market (~2 KB of
    // text per bot, L104): view() gives it back from them, in its place.
    return { ...network, inputKey: undefined, queue, gap: !network.gap ? network.gap : at >= 0 ? queue[at] : row(network.gap), activity, plans,
        ...(network.agenda ? { agenda: network.agenda.map(Agenda.stepRow), later: network.later.map(facts) } : {}),
        ...(craftNeeds.length ? { craftNeeds } : {}) };
}
// The build's prices of what the plan's own numbers were made from (the
// kit, the queue, the watch list): a later view starts from them, so its
// stock rows, kit costs and the reserve it funds its queue with agree.
// Other items are priced by the view (~8 of ~140 prices per bot are kept).
function planPrices(prices, rates, context) {
    const ids = [736, rates.shotId, rates.potionId,
        ...(context.network?.queue || []).map(row => row.object?.itemId), ...(context.watchList || []).map(row => row.itemId)];
    const kept = new Map();
    for (const id of ids) if (prices.has(Number(id))) kept.set(Number(id), prices.get(Number(id)));
    return kept;
}
function planOf(context, base, { key, tripHour, projection = null, knowledgeEnabled, prices }) {
    const stockRoots = new Map();
    for (const node of projection?.nodes || [])
        if (node.key.startsWith('stock:') && !stockRoots.has(node.key)) stockRoots.set(node.key, node.object?.itemId);
    return { pending: !projection, key, actorKey: context.actorKey, timestamp: context.timestamp,
        gearThreatMask: context.gearThreatMask, persona: context.persona, hunt: context.hunt,
        riskWeight: context.riskWeight, bestSpotId: context.bestSpotId, earning: base.earning,
        deathHours: context.deathHours,
        lostGearHours: context.lostGearHours, karmaHours: context.karmaHours, expectedDeathHours: context.expectedDeathHours,
        refillReserve: context.refillReserve, rates: base.rates, hourAdena: context.hourAdena,
        routeKey: context.routeKey, routeRows: context.routeRows, tripHour,
        network: compactNetwork(context.network), moneyPrice: context.moneyPrice, gapHorizonHours: context.gapHorizonHours,
        watchList: context.watchList, intentPending: context.intentPending, statsPacket: context.statsPacket,
        wallet: context.wallet, horizonHours: context.horizonHours, values: projection?.values, stockRoots, knowledgeEnabled,
        prices: planPrices(prices, base.rates, context), gearPlanMemo: undefined };
}
// What a review's stock reader, usefulness, worth and purchase budget read:
// one copy for the build and every later view of its plan.
function stockReader(state, rootItem, board = null) {
    board ||= isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null;
    const reserved = invoke('GameServer/Bot/AI/PersonalGearProgression').preparedAmounts(state);
    // Production actions cannot consume the collected personal gear kit.
    // Their purchase graph must see that same free stock, or an input trip
    // reaches the seller with no surviving need for its own reserved goods.
    let productionReserved;
    const supply = state.stats?.equipmentPlan?.clanGoal?.clanId && require('./ClanCrystalSupply').requirement(state);
    const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
    const active = Warehouse.ready() && Warehouse.hasItems(state) && require('./CraftWarehousePolicy').planFor(state);
    const bank = active ? require('./CraftWarehousePolicy').available(state, Object.values(Warehouse.inventory(state))).warehouse : null;
    const bankRoot = active && `power:${Number(active.plan.target.selfId)}:${Number(active.plan.target.slot)}`;
    const escrow = new Map();
    for (const line of board?.ownerLines?.(Number(state.characterId)) || []) {
        if (line.storeType === SELL && line.custodyPolicy !== 1 && !Number(line.enchant || 0))
            escrow.set(Number(line.selfId), Number(escrow.get(Number(line.selfId)) || 0) + positive(line.count));
    }
    const retainedBanks = new Map();
    if (Warehouse.ready() && Warehouse.hasItems(state) && state.stats?.equipmentPlan?.inputPreparation) {
        const remaining = { ...Disposition.storedEquipmentAmounts(state).retained }, seen = new Set();
        for (let saved = state.stats.equipmentPlan.inputPreparation; saved && !seen.has(saved); saved = saved.inputPreparation) {
            seen.add(saved);
            const assigned = {};
            for (const [id, need] of Object.entries(Disposition.equipmentMaterialAmounts(state, saved))) {
                assigned[id] = Math.min(Number(remaining[id] || 0), need);
                remaining[id] = Number(remaining[id] || 0) - assigned[id];
            }
            retainedBanks.set(`power:${Number(saved.target?.selfId)}:${Number(saved.target?.slot)}`, assigned);
        }
    }
    // lazy: optional clan supply
    const read = (id, rootKey) => ({ owned: supply?.key === rootKey ? require('./ClanCrystalSupply').stock(state, id)
        : rootKey.startsWith('stock:') && rootItem(rootKey) === id
        ? positive(state.inventory?.[id]?.amount) : invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {},
            rootKey.startsWith('resale:') ? productionReserved ||= Disposition.reservedEquipmentAmounts(state) : reserved),
    incoming: positive(state.acceptedIncoming?.[id]) + (rootKey === bankRoot && Number(id) !== Number(active.plan.target.selfId)
        ? positive(bank?.[id]) : positive(retainedBanks.get(rootKey)?.[id]))
        // Own backed quotes remain owned inputs, but must be reclaimed before
        // execution. Never count a finished item or a conditional ad twice.
        + (/^power:\d+:\d+$/.test(rootKey) && Number(rootKey.split(':')[1]) !== Number(id)
            ? positive(escrow.get(Number(id))) : 0) });
    return read;
}
function valueReaders(state, network, values, persona, knowledgeEnabled, kitCost, money) {
    const itemUsefulness = id => invoke('GameServer/Bot/Population/ColdEconomyDecision').personalUsefulness(
        network.demands.get(`item:${id}`) || values.get(Number(id)) || 0,
        state, persona.understanding, knowledgeEnabled, id);
    return { itemUsefulness,
        worth: id => network.moneyPrice > 0 ? itemUsefulness(id) / network.moneyPrice : null,
        purchaseBudget: id => {
            const wish = network.queue.find(row => Number(row.object?.itemId) === Number(id));
            return Funding.spendable({ ...state, stats: { ...state.stats, money: money() } }, 0,
                Funding.stockTerms(wish, id, kitCost(id)));
        } };
}
// The build's hunt as the spot reader's hour baseline: a leaf-fit or plain
// hunt. An income-route hunt is not one (its exp is the route spot's share and
// it may hunt without shots): the reader then keeps its own bare hunt.
function buildHunt(hunt) {
    return hunt?.source === 'route' ? undefined : hunt;
}
// Spot values are read inside a build (providers); a later view makes its
// reader only when asked.
function lazySpotValue(state, plan, deps) {
    let reader;
    return (...args) => (reader ||= SpotEconomics.create(state,
        { ...deps, timestamp: plan.timestamp, persona: plan.persona, deathHours: plan.deathHours, hunt: buildHunt(plan.hunt) }))(...args);
}
const buyback = id => invoke('GameServer/Items/NpcSellRules')
    .npcBuyPrice(Number(ItemIndex.find(DataCache.items, id)?.template?.price || 0));
// One reader's context over a plan. `built` carries the building call's own
// readers (prices with their memo, kit, spot value, trip, the projection);
// a later view makes its own from the plan. The state is the caller's, held
// only by this view. Functions read the plan, never a build scope.
function view(state, plan, deps, built = {}) {
    // A later view starts from the build's prices of the plan's own items.
    const price = built.price || pricing(state, plan.persona, built.board, plan.timestamp, deps, built.read, new Map(plan.prices)).price;
    // The plan's kit rates over the bag, wallet and prices of this view's state:
    // one basis for its stock, kit costs and the reserve its queue is funded with.
    let kit = built.kit;
    if (!kit) {
        const bag = kitBag(state, { hour: plan.hourAdena });
        const read = kitReader(ratesNow(plan.rates, state, bag, price), bag, Funding.budget(state), price,
            () => plan.rates.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId));
        kit = { stock: read.stock, kitCost: read.kitCost, refillReserve: read.reserve };
    }
    const { stock, kitCost, refillReserve: reserve } = kit;
    // Reprice funding against this physical wallet. Reuse of benefit/source
    // calculations is never a retained permission to spend an old balance.
    const funding = moneyQueue(plan.network.queue, Funding.budget(state, deps.buyOrderEscrow),
        reserve, plan.hourAdena > 0 ? 1 / plan.hourAdena : 0);
    const inputKey = plan.key;
    const network = { ...plan.network, inputKey, ...funding };
    const statsPacket = plan.pending ? plan.statsPacket : { ...plan.statsPacket,
        money: Funding.packetFor(network, plan.hourAdena, reserve) };
    const context = { inputKey, actorKey: plan.actorKey, state,
        timestamp: plan.timestamp, gearThreatMask: plan.gearThreatMask, persona: plan.persona, board: built.board, hunt: plan.hunt,
        price, buyback, riskWeight: plan.riskWeight, bestSpotId: plan.bestSpotId,
        deathHours: plan.deathHours, lostGearHours: plan.lostGearHours, karmaHours: plan.karmaHours,
        expectedDeathHours: plan.expectedDeathHours, stock, refillReserve: reserve, kitCost,
        hourAdena: plan.hourAdena, routeKey: plan.routeKey, routeRows: plan.routeRows,
        // The caller's route of this state; the plan's only from where it was built.
        trip: built.trip || deps.tripCost || Trip.preparedReader(deps.routeRows
            || (plan.routeKey === Trip.key(state) ? plan.routeRows : null) || [], { hourAdena: plan.tripHour }),
        spotValue: built.spotValue || lazySpotValue(state, plan, deps),
        network, moneyPrice: network.moneyPrice, gapHorizonHours: plan.gapHorizonHours,
        watchList: Agenda.bidsAfter(plan.watchList, network.filled), intentPending: plan.intentPending, statsPacket };
    // The plan is the identity of one decision for memos kept beside it
    // (a refused trip, the gear plan choice), not this view object.
    Object.defineProperty(context, 'plan', { value: plan });
    Object.defineProperty(context, 'eventProof', { value: () => plan.eventProof || null });
    Object.defineProperty(context, 'gearPlanMemo', { get: () => plan.gearPlanMemo, set: memo => { plan.gearPlanMemo = memo; } });
    if (plan.pending) {
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        return context;
    }
    context.wallet = Funding.budget(state, deps.buyOrderEscrow);
    context.stockFor = stockReader(state, rootKey => plan.stockRoots.get(rootKey), built.board);
    // A later view of an entry without its nodes (a worker's solo bot) has
    // the usefulness values only; a group solve that needs the members'
    // nodes rebuilds them (forGroup).
    context.projection = built.projection || { values: plan.values };
    context.horizonHours = plan.horizonHours;
    Object.assign(context, valueReaders(state, network, plan.values, plan.persona, plan.knowledgeEnabled,
        kitCost, () => context.statsPacket.money));
    // Reprice retained craft inputs and recipe investments against this
    // wallet: the source graph may stand while the money queue changes.
    if (state.stats?.shotRecipeDemand || state.stats?.equipmentPlan?.inputPreparation || state.stats?.equipmentPlan?.clanGoal
        || state.stats?.equipmentPlan?.strategy === 'craft' && state.stats?.equipmentPlan?.status === 'active'
        || state.stats?.equipmentPlan?.status === 'deferred' && state.stats?.equipmentPlan?.reason === 'wish_focus') {
        const watch = TradeIntent.project(state, network, context.projection,
            id => context.worth(id) ?? price(id), BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.buy_ad,
            context.board, context.trip?.details, context.survivalReserve);
        if (watch) context.watchList = Agenda.bidsAfter(watch, network.filled);
    }
    return context;
}
// What a fight's danger moment weighs (DangerRule), for the cold fight, which
// reads the bot's packet: a read of the view's basics would build them.
function dangerPrice(base) {
    return Packet.dangerPrice({ deathHours: base.deathHours, riskWeight: base.riskWeight });
}
// stats.kitRates, the build's kit rates published with its money packet
// (layout in StatsPacket): main and every later read run kitReader over them
// with the live bag (keptKit, keptTargets). gapHorizonHours: how long the
// plan's urgent want may wait for a price, main's trader reads it.
// scrollHours: the hours a Scroll of Escape saves (scrollHoursFor), three
// significant digits; unpriced when the build did not price it and its origin
// is off the catalogue (no route solve for the row: main then prices the
// scroll at no saving).
function kitRates(base, gapHorizonHours = 0) {
    const hours = base.scrollHours();
    return Packet.kitRates({ ...base.rates, gapHorizonHours,
        scrollHours: Number.isFinite(hours) ? Number(positive(hours).toPrecision(3)) : null });
}
// The bot's missing shot stack as crafters see it (stats.shotDemand, read by
// MarketDemandIndex and CraftWorkshopService): null when the stock rule wants
// none or has no shot row (a bot without shots), the previous row (its age
// kept) while item, amount and cap hold. The far step's output (ColdSimulationWorker planLifecycle), over the step's own
// economy and its money packet. Escrow 0 and worth ?? price, as the
// main-thread review read them: a worth of 0 (an item off the bot's wish
// card) caps the spend at 0, only no worth falls back to the price.
// Only the activities the main-thread review posted for; any other step
// keeps the previous row as it is. Posted only below the shots' line (in the
// field the line is the bot's only shot need) or in town (the outing's refill).
const SHOT_DEMAND_ACTIVITIES = ['hunting', 'resting', 'shopping', 'grouped'];
function shotDemand(economy, state, timestamp, previous = null) {
    if (!SHOT_DEMAND_ACTIVITIES.includes(state.activity)) return previous;
    const stock = economy.stock('shots');
    if (!stock?.needed && state.activity !== 'shopping') return null;
    const missing = stock.survivalMissing + stock.missing;
    if (!missing) return null;
    const price = stock.unitPrice;
    if (!(price > 0)) return previous;
    const funded = { ...state, stats: { ...state.stats, money: economy.statsPacket.money } };
    const maxSpend = Math.min(Funding.spendable(funded, 0, { itemId: stock.itemId, survivalCost: economy.kitCost(stock.itemId) }),
        missing * (economy.worth(stock.itemId) ?? price));
    if (previous && previous.itemId === stock.itemId && previous.amount === missing && previous.maxSpend === maxSpend) return previous;
    return { itemId: stock.itemId, amount: missing, maxSpend, at: timestamp };
}
// The kit on main and in a read outside a build: one rule for what a bot
// keeps from a sale and what it buys (our model choice, not C4): the build's
// published rates (stats.kitRates) over the live bag and wallet (kitReader),
// so a town errand's restock and the sale list read the rates the worker
// decided under spot occupancy, never a second earning-spot read. A bot no
// build has rated yet (no row) buys no kit and keeps its bag as it is,
// counted kit:unrated (no fallback to the basics).
// kit:unrated counts each unrated bot once (not each read): how many bots read a kit before
// their first build. Always counted (health line); the set holds at most one id a bot, cleared by forget.
const unratedBots = new Set();
function ratesOf(state, quiet) {
    const rates = Packet.ratesOf(state.stats?.kitRates, IncomeRoute.spotUseOf(state));
    if (!rates && !quiet && !unratedBots.has(state.characterId)) {
        unratedBots.add(state.characterId);
        Situations.note(`kit:unrated@${isMainThread ? 'main' : 'worker'}`);
    }
    return rates;
}
// The kit a purchase reads (ShotStock, HealingPotionStock and ScrollStock
// restocks, NpcRestockPlan, ColdMarketService funding, the card view):
// stock, kitCost, refillReserve and price, priced at the bot's prices.
// options.quote(id): a town's own price (NpcRestockPlan.quoteFor), read before
// the bot's: a visit's amounts are priced where it buys (its funding stays at
// the bot's own estimate, E187: visitStock). options.rates: a build's own
// rates (the worker's fresh build), read instead of the published row.
function keptKit(state = {}, deps = {}, options = {}) {
    let read = null;
    const own = id => (read ||= personal(state, deps).price)(id);
    const quote = options.quote;
    const price = !quote ? own : id => { const local = Number(quote(id)); return local > 0 ? local : own(id); };
    const bag = kitBag(state);
    const rates = options.rates !== undefined ? options.rates : ratesOf(state);
    const { stock, kitCost, reserve } = kitReader(ratesNow(rates, state, bag, price), bag, Funding.budget(state), price);
    return { stock, kitCost, refillReserve: reserve, price };
}
// A restock's stock row of a kind: its amounts from the visit's kit (kit: at the
// town's quotes; else the funding context's own) and the estimate its wish is
// ranked at, always the funding context's (the bot's own price, E187).
function visitStock(context, kit, kind) {
    const own = context.stock(kind);
    return { row: kit ? kit.stock(kind) : own, estimate: own.unitPrice };
}
// The sale's kept stock (ItemDisposition.saleCandidates): each kind's stock
// row (itemId, target, beginnerCurrent), no price read. The wallet does not
// bound what is kept: the rest bottles' cap never falls below the bottles held.
const NO_PRICE = () => 0;
function keptTargets(state = {}) {
    const bag = kitBag(state);
    const { stock } = kitReader(ratesNow(ratesOf(state), state, bag, NO_PRICE), bag, Infinity, NO_PRICE);
    return { potions: stock('potions'), shots: stock('shots') };
}
// Whether the sale keeps the rated kit (keptTargets reads its rates, not the
// bag as it is): BotAfkMarketService's shop key leaves the fired shots out only then.
function saleKitPublished(state = {}) {
    return ratesOf(state, true) !== null;
}
function refillReserve(state = {}) {
    return Array.isArray(state.stats?.money) ? positive(Packet.refillReserve(state.stats.money)) : basics(state).refillReserve;
}
function forGroup(group, members, deps = {}) {
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('context_group', 'request');
    const selected = (members || []).slice(0, 9);
    const prepared = deps.memberContexts;
    if (prepared !== undefined && (!Array.isArray(prepared) || prepared.length !== selected.length
        || prepared.some((context, i) => !context?.projection?.nodes || context.state !== selected[i])))
        throw new Error('party_member_context_mismatch');
    const contexts = prepared || selected.map(state => forState(state, { ...deps, caller: 'groupContext' }));
    const first = contexts[0];
    if (!first) {
        if (diagnostic) Diagnostics.count('context_group', 'miss', 'empty_group');
        return null;
    }
    const actorKey = `group:${group.id || group.partyId}`;
    const proposal = deps.rememberGroup === false || String(group.id || group.partyId || '').startsWith('proposal:');
    const wallet = positive(group.adena ?? group.wallet);
    // Each member's network key (its decided facts) and its plan's echo
    // (decision sequence, leaf, focus): the facts do not move with a member's
    // own decision, so with the echo equal keys are equal member plans (perf
    // C1: a member's later view is a new object over the same plan). A party
    // keeps its group answer until a member's facts, decision sequence, leaf
    // or focus move, or a situation is raised on it (its situationSeq).
    const key = [wallet, ...contexts.map(({ inputKey, statsPacket: packet }, i) =>
        `${inputKey}:${packet?.decisionSeq}:${Number(selected[i]?.stats?.situationSeq) || 0}:${packet?.activityLeaf}:${packet?.wishFocus?.[0]}`)].join('|');
    const held = proposal ? null : groups.get(actorKey);
    if (held?.key === key) {
        if (diagnostic) Diagnostics.count('context_group', 'hit', 'same_members');
        return remember(groups, actorKey, held, groupLimit()).context;
    }
    const started = diagnostic ? performance.now() : 0;
    if (diagnostic) Diagnostics.count('context_group', 'miss', proposal ? 'uncached_proposal'
        : !held ? 'not_retained' : 'input_dependency_changed');
    const nodes = [], roots = [];
    // Each member keeps its actual wishes/effects. Namespaced dependencies
    // enter the group's one purse and one engine, never a second evaluator.
    // A worker solo bot's later view (a formation candidate's) keeps only its
    // usefulness values: the same call that made it builds again asking for
    // the nodes (perf C1).
    const sources = contexts.map((context, i) => context.projection?.nodes ? context.projection
        : forState(selected[i], { ...deps, caller: 'groupContext', withNodes: true }).projection);
    for (let i = 0; i < contexts.length; i++) {
        const source = sources[i];
        const prefix = `${i}:`;
        // The group solve has no stock reader: a member's path with gross
        // inputs only (Task 2 readers) orders what the member does not hold
        // for one batch, and pays its held units at their exit value.
        const held = new Map(source.nodes.map(node => [node.key, node]));
        const missing = path => {
            const requirements = [];
            let ownValue = 0;
            for (const row of path.grossRequirements) {
                const id = row.key.startsWith('item:') ? Number(row.key.slice(5)) : 0;
                const stock = id ? contexts[i].stockFor?.(id, '') || {} : {};
                const { toOrder: order, toExecute } = remainingQuantity({ required: row.amount,
                    freePhysical: positive(stock.owned), acceptedIncoming: positive(stock.incoming) });
                const node = held.get(row.key);
                ownValue += (row.amount - toExecute) * positive(Number.isFinite(node?.exitValue) ? node.exitValue : node?.price);
                if (order > 0) requirements.push({ ...row, amount: order });
            }
            return { requirements, ownInputOpportunityValue: positive(path.ownInputOpportunityValue) + ownValue };
        };
        for (const node of source.nodes) nodes.push({ ...node, key: prefix + node.key,
            paths: (node.paths || []).map(path => {
                const own = path.requirements || !path.grossRequirements ? null : missing(path);
                return { ...path, ...own, ...(path.town ? { tripScope: contexts[i].actorKey } : {}),
                requirements: (own?.requirements || path.requirements || [])
                .map(row => ({ ...row, key: prefix + row.key })),
                ...(path.grossRequirements ? { grossRequirements: path.grossRequirements.map(row => ({ ...row, key: prefix + row.key })) } : {}) };
            }) });
        roots.push(...source.roots.map(key => prefix + key));
    }
    const byKey = new Map(nodes.map(node => [node.key, node]));
    roots.sort((a, b) => positive(byKey.get(b).valueHours) / Math.max(1, positive(byKey.get(b).price))
        - positive(byKey.get(a).valueHours) / Math.max(1, positive(byKey.get(a).price)));
    // MVP-6: the same admission as one member's projection; a root whose
    // union does not fit is pending and the smaller ones still proceed.
    const { roots: admitted, kept } = admitRoots(roots, byKey, { label: 'group' });
    const network = engine.build({ actorKey, inputKey: key, remembered: false, nodes: nodes.filter(node => kept.has(node.key)), roots: admitted,
        wallet, playedHours: positive(group.playedHours), persona: group.persona || first.persona,
        previous: { focus: group.wishFocus, dormant: group.dormantWishes },
        hourAdena: contexts.reduce((sum, context) => sum + context.hunt.perHour, 0),
        moneyPaths: sources[0].moneyPaths, riskWeight: first.riskWeight });
    const groupHunt = { ...first.hunt, perHour: contexts.reduce((sum, member) => sum + member.hunt.perHour, 0),
        expPerHour: contexts.reduce((sum, member) => sum + member.hunt.expPerHour, 0) };
    const context = { ...first, actorKey, inputKey: key, network, hunt: groupHunt, groupIncomePerHour: groupHunt.perHour,
        moneyPrice: network.moneyPrice,
        hourAdena: network.hourAdena, statsPacket: { wishFocus: network.focus, dormantWishes: network.dormant } };
    context.itemUsefulness = id => contexts.reduce((sum, member) => sum + member.itemUsefulness(id), 0);
    context.worth = id => network.moneyPrice > 0 ? context.itemUsefulness(id) / network.moneyPrice : null;
    if (diagnostic) {
        Diagnostics.count('context_group', 'build');
        Diagnostics.duration('context_group', performance.now() - started);
    }
    if (!proposal) {
        if (diagnostic && !groups.has(actorKey) && groups.size >= groupLimit())
            Diagnostics.count('context_group', 'eviction', 'capacity');
        remember(groups, actorKey, { key, ids: contexts.map(member => Number(member.state.characterId)), context }, groupLimit());
    }
    return context;
}
function preparedRouteRows(state) {
    const plan = cache.get(`character:${Number(state.characterId)}`)?.plan;
    return plan?.routeKey === Trip.key(state) ? plan.routeRows : null;
}
function forgetGroup(partyId) {
    if (groups.delete(`group:${partyId}`) && Diagnostics.active()) Diagnostics.count('context_group', 'eviction', 'group_release');
}
function forgetContext(id, reason = 'explicit_invalidation', expectedState = null) {
    id = Number(id);
    const key = `character:${id}`;
    if (expectedState && cache.get(key)?.stateRef.deref() !== expectedState) return;
    // Publication replaces the facts object, not the economic decision. The
    // next reader's verdict validates the held build against the state.
    if (reason !== 'state_publication') {
        if (cache.delete(key) && Diagnostics.active()) { Diagnostics.count('context', 'eviction', reason); }
        engine.forget(key, reason);
    }
    for (const [groupKey, held] of groups) {
        if (held.ids.includes(id)) {
            groups.delete(groupKey);
            if (Diagnostics.active()) Diagnostics.count('context_group', 'eviction', reason);
        }
    }
}
function forget(id) {
    forgetContext(id);
    unratedBots.delete(id);
    invoke('GameServer/Bot/Population/ColdCombatProfile').forgetBuild(id);
}
function reset() {
    if (Diagnostics.active() && cache.size) Diagnostics.count('context', 'eviction', 'reset', cache.size);
    if (Diagnostics.active() && groups.size) Diagnostics.count('context_group', 'eviction', 'reset', groups.size);
    cache.clear(); groups.clear(); engine.clear(); routeAnchors = new WeakMap(); unratedBots.clear();
}
function size() { return { context: cache.size, engine: engine.cache.size, groups: groups.size }; }

module.exports = { visitStopsLeft, decideEarning, quietGearBuildCount: () => quietGearBuilds, buildDoors: () => ({ ...doors, ...Agenda.counts() }), countDoor,
    heldBuild: (state, deps = {}) => cache.has(actorKeyOf(state, deps)), earningDue, linkStats, FIELD_ACTIVITIES, captureEventProof, proofIdentity, restartEventProof, restoreEventProof, size, forState, forGroup, forgetGroup, basics, personal, stockReader, kitReader, kitBag, kitRates, keptKit, visitStock, keptTargets, saleKitPublished, shotDemand, stateForActor, bodyPlace, preparedRouteRows, RETAIN_LIMIT, leafCheck, leafOutcome, refillReserve, forgetContext, forget, reset, configure, registerProvider };
