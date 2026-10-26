'use strict';
const ClassProgression = invoke('GameServer/ClassProgression');
const DataCache = invoke('GameServer/DataCache');
const Roles = require('../AI/BotRoles');
const Knowledge = require('../AI/KnowledgeLearning');
const Crystallization = require('./BotCrystallization');
const Floor = require('../Population/SurvivalFloor');

const GearThreat = require('./GearThreat');

const ItemIndex = require('../../Item/ItemTemplateIndex');
const Valuation = require('./EconomicValuation');
const Providers = require('./WishProviders');
const Sections = require('./DecisionSections');
const Funding = require('./PurchaseFunding');
const SpotRiskPolicy = require('../Population/SpotRiskPolicy');
const ColdEconomyDecision = require('../Population/ColdEconomyDecision');
const Network = require('./WishNetwork');
const PurchaseEvidence = require('./WishPurchaseEvidence');
const OccupationSources = invoke('GameServer/Bot/Population/ColdOccupationSources');
const { WishNetwork, remember, admitRoots, remainingQuantity, moneyQueue, cashCharge,
    createQuantityInputs, quantityInputsHold, eachQuantityRow } = Network;
const { isMainThread } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const RecomputeGeneration = require('../Population/RecomputeGeneration');
const Warehouse = require('./PersonalWarehouseIndex');
const ClanSupply = require('../../Clan/ClanSupplyPolicy');
const Recipes = require('../../Items/C4RecipeItems');
const CraftInputReservations = require('./CraftInputReservations');
const Bytes = require('./CompactBytes');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const BoardRules = require('../../AfkTrade/BoardRules');
const Diagnostics = require('./EconomyDiagnostics');
const PriceBelief = require('./PriceBelief');
const { fnv1a32 } = require('../Fnv1a');
const engine = new WishNetwork();
const Trip = require('./EconomicTrip');
const IncomeRoute = require('./EquipmentIncomeRoute');
const SpotEconomics = require('./SpotEconomics');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const WalkBack = invoke('GameServer/Bot/Economy/WalkBack');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const TravelRoutes = invoke('GameServer/Bot/Travel/TravelRoutes');
const GearProgression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const TradeIntent = require('./TradeIntent');
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
// context }, removed when the party ends (forgetGroup) and bounded besides;
// a proposed composition (`proposal:` party id) is built and not kept.
const groups = new Map();
const GROUP_LIMIT = 256;
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
        spotId: session?.currentSpot?.id || stored.spotId,
        stats: { ...decisionStats, coldCombat: hotKit, hennas: [...(session?.hennas || stored.stats?.hennas || [])], soulCrystalQuest: session?.questStates?.get(350)?.isStarted() === true || stored.stats?.soulCrystalQuest, classId: actor.fetchClassId?.(), exp: actor.fetchExp?.(), karma: actor.fetchKarma?.(), pk: actor.fetchPk?.() },
        party: session?.hotBackgroundPartyId ? { partyId: session.hotBackgroundPartyId, role: stored.party?.role } : null,
        activity: session?.plan || 'hunting' };
    const loc = { locX: Number(actor.fetchLocX?.()), locY: Number(actor.fetchLocY?.()), locZ: Number(actor.fetchLocZ?.()) };
    if (!Object.values(loc).every(Number.isFinite)) Object.assign(loc, stored.loc || {});
    state.loc = loc;
    return routeState(state, session);
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
    const event = JSON.stringify([state.spotId, state.stats?.decisionSeq, frame]);
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
const FIELD_ACTIVITIES = new Set(['hunting', 'resting', 'traveling']);
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
// The held leaf's own purchase item stays exact: its order counts only the
// rise since the decision (remainingToOrder), so use inside a band would buy short.
function bandsHold(state, bands = [], leaf = null) {
    if (!Array.isArray(bands) || bands.length > 128) return false;
    const bought = leaf?.activity === 'shopping' ? Number(leaf.itemId) || 0 : 0;
    for (const band of bands) {
        if (!Array.isArray(band) || band.length !== 4) return false;
        const [id, low, high, original] = band;
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(low) || low < 0
            || high !== null && (!Number.isFinite(high) || high < low)
            || !Number.isFinite(original) || original < low || high !== null && original > high) return false;
        const amount = Number(state.inventory?.[id]?.amount);
        if (bought && Number(id) === bought ? amount !== original
            : !(amount >= low) || high !== null && !(amount <= high)) return false;
    }
    return true;
}
// The event part of the one verdict "the held plan is still valid" (L70),
// read by the verdict (heldBuildVerdict), which checks a raised event
// (wishDirty) itself before. Only hard checks: a crafter's MP and hard money
// (below the lower bound or a moved funding mark). Soft money, income and
// the market are the soft point's (DecisionSections.softEvents, the end of
// the step), never here.
// held: { baseline, mp, nativeCraftContinuation } of the last actual decision.
// Every failing check names itself in `why` (an array or null), in order.
const miss = (why, reason) => { why?.push(reason); return false; };
function heldEventsQuiet(state, held, deps = {}, why = null) {
    const stats = state.stats || {};
    let quiet = true;
    if (!held.nativeCraftContinuation && Number(state.craftLevel ?? stats.dwarvenCraftLevel) > 0
        && Number(state.vitals?.mp) !== Number(held.mp)) quiet = miss(why, 'crafter_mp');
    if (Sections.moneyChanged(state, held.baseline, deps.buyOrderEscrow, false)) quiet = miss(why, 'money');
    return quiet;
}
// A quantity proof row (WishNetwork createQuantityInputs layout) of the
// leaf's own progress: a stock row of its own root on its item, or a
// scalar row of its item. Another root's stock row on that item is that
// root's input (a wished material reaching its count).
const ownQuantityRow = (row, rootKey, own) => row[0] === 'stock' || row[0] === 'stockPhysical'
    ? row[1] === rootKey && row[2] === own : row[1] === own;
// The first input a completed build lacks for an event proof, '' if none.
function eventProofMissing(state, deps, plan) {
    if (!plan || plan.pending) return 'pending';
    if (!plan.quantityInputs) return 'quantity_inputs';
    if (!plan.liquidationInputs) return 'liquidation_inputs';
    if (extensions.size) return 'extensions';
    if (deps.nodes?.length) return 'nodes';
    if (state.incomingPending) return 'incoming_pending';
    if (!plan.statsPacket?.wishSections) return 'sections';
    if (!Warehouse.contentIdentity(state)) return 'warehouse';
    if (!ClanSupply.contentIdentity(state)) return 'clan_supply';
    if (!RecomputeGeneration.current()) return 'generation';
    const baseline = plan.statsPacket.wishSections, leaf = plan.network?.activity;
    if (leaf === null ? plan.pending !== false || plan.intentPending !== false || plan.statsPacket.activityLeaf !== 0
        : !leaf?.activity) return 'leaf';
    if (!Number.isFinite(baseline.at) || !Sections.observationBaselineValid(baseline)) return 'baseline';
    return '';
}
// This proof is produced by the completed native build, shared by its cache
// entry and compact execution card. It is never reconstructed from a later
// publication.
function captureEventProof(state, deps = {}, options = {}) {
    const plan = options.plan, missing = eventProofMissing(state, deps, plan);
    // Diagnostics: per retained build, captured or the first missing input.
    if (Diagnostics.active()) Diagnostics.count('context', 'proof', missing || 'captured');
    if (missing) return null;
    const baseline = plan.statsPacket.wishSections, leaf = plan.network?.activity;
    return Object.freeze({ version: 2, owner: Number(state.characterId), at: baseline.at,
        generation: RecomputeGeneration.current(),
        decision: Object.freeze([Number(plan.statsPacket.decisionSeq || 0),
            Number(plan.statsPacket.activityLeaf || 0), plan.network.focus?.[0] ?? null]),
        activity: activityIdentity(leaf),
        quantities: plan.quantityInputs, liquidation: plan.liquidationInputs,
        stockRoots: Object.freeze([...plan.stockRoots]),
        bands: plan.quantityBands || [], hourAdena: plan.hourAdena,
        // A restored prefix currently excludes process-local owner versions.
        // Unsupported owners abstain; an empty numeric revision is not proof.
        restartable: !!RecomputeGeneration.current() && typeof deps.memoryIdentity === 'string'
            && deps.sourceReady === true });
}

// options.collect (the decision point, forState): a refusal that names
// sections ORs them into touchedSections and the checks go on; one that
// names none stops with every section. Otherwise (every other caller) the
// first refusal answers. The first refusal stays the reason either way.
// refuse always returns `out`; a sections refusal stops only outside
// collect mode: `if (cond && refuse(...) && !collect) return out`.
function heldBuildVerdict(state, proof, deps = {}, options = {}) {
    // Diagnostics: verdicts computed (every caller), against the ones a build
    // served from the card's verdict of its step (forState, handedVerdict).
    if (Diagnostics.active()) Diagnostics.count('context', 'held_verdict', 'computed');
    const collect = options.collect === true;
    // touchedSections: the pieces to rebuild; movedSections: only the
    // sections refusals named (a refusal naming none adds nothing to it);
    // firstSections: the sections the first refusal named, what a run that
    // stops there answers (eventProofHolds); leaf: the identity of the leaf
    // it judged, unset when it stopped before.
    const out = { valid: false, reason: '', touchedSections: 0, movedSections: 0, firstSections: 0, leaf: undefined };
    const refuse = (reason, names) => {
        const first = !out.reason;
        out.reason ||= reason;
        if (!names) {
            if (collect) out.touchedSections = Sections.COMPUTED.weighing;
            return out;
        }
        const bits = typeof names === 'number' ? names : Sections.sectionMask(names);
        out.touchedSections |= bits; out.movedSections |= bits;
        if (first) out.firstSections = bits;
        return out;
    };
    if (!proof || proof.version !== 2 || proof.owner !== Number(state.characterId)
        || !Array.isArray(proof.decision) || proof.decision.length !== 3
        || !proof.decision.slice(0, 2).every(value => Number.isSafeInteger(value) && value >= 0)
        || proof.decision[2] !== null && typeof proof.decision[2] !== 'string'
        || !Array.isArray(proof.stockRoots) || proof.stockRoots.length > 40
        || !proof.stockRoots.every(row => Array.isArray(row) && row.length === 2
            && typeof row[0] === 'string' && Number.isSafeInteger(row[1]) && row[1] > 0)
        || !(proof.activity === null ? options.leaf === null && proof.decision[1] === 0
            : typeof proof.activity === 'string' && !!options.leaf?.activity)
        || !Array.isArray(proof.bands) || !Array.isArray(proof.liquidation?.rows)
        || proof.liquidation.rows.length > 8 || !proof.liquidation.rows.every(row => Array.isArray(row)
            && row.length === 2 && Number.isSafeInteger(row[0]) && row[0] > 0 && Number.isFinite(row[1]) && row[1] > 0)
        || !Number.isFinite(proof.hourAdena) || proof.hourAdena < 0) return refuse('unproved');
    const baseline = options.baseline;
    if (!Sections.observationBaselineValid(baseline) || !Number.isFinite(proof.at)) return refuse('baseline');
    // The baseline belongs to this proof (identity of `at`, not an order of
    // two times: a request's own clock is no decision input).
    if (proof.at !== baseline.at) return refuse('baseline_at');
    const generation = RecomputeGeneration.current();
    if ((!generation || proof.generation !== generation) && refuse('generation', ['build', 'sources']) && !collect) return out;
    out.leaf = activityIdentity(options.leaf);
    if (out.leaf !== proof.activity && refuse('activity', ['sources']) && !collect) return out;
    // A raised event (reconcile bumps the sequence with it) is named by its
    // sections before the echo.
    const dirty = Number(state.stats?.wishDirty) || 0;
    if (dirty && refuse('wish_dirty', dirty) && !collect) return out;
    const echo = Sections.decisionRefusal(state, ...proof.decision);
    // Collecting past raised bits: every raise (DecisionEvents markSections,
    // raiseSections) bumps decisionSeq with its bits, so a moved sequence is
    // that raise, already named by its bits; read as sources it would rebuild
    // the source walk on every event. The leaf and the focus are still
    // compared: a moved one lights sources, as the echo does.
    if (echo && collect && dirty) {
        const leafOrFocus = Sections.decisionRefusal(state, Number(state.stats?.decisionSeq || 0), proof.decision[1], proof.decision[2]);
        if (leafOrFocus) refuse(leafOrFocus, ['sources']);
    } else if (echo && refuse(echo, ['sources']) && !collect) return out;
    deps = resolved(state, deps);
    if (!Warehouse.contentIdentity(state) || !ClanSupply.contentIdentity(state)) return refuse('unready');
    const current = fieldActivity(state, options.activity, options.leaf);
    // An occupation move the held leaf ordered (its trip, its arrival) is its own output.
    const changed = Sections.factEvents(name => baseline[name], options.facts || requestFacts(current, deps), false, null,
        Sections.occupationPlanned(state, options.leaf));
    if (changed.length && refuse('sections', changed) && !collect) return out;
    // The gear-threat mask the decision weighed: only its flip between
    // "physical only" and "both" changes a decision. A baseline kept before
    // the mask was recorded has none to compare.
    if (baseline.threat !== undefined && baseline.threat !== (deps.gearThreatMask ?? GearThreat.maskFor(current, deps))
        && refuse('observation', ['occupation', 'benefits', 'sources']) && !collect) return out;
    const why = [];
    if (!heldEventsQuiet(state, { baseline, mp: options.mp, nativeCraftContinuation: deps.nativeCraftContinuation === true }, deps, why))
        for (const name of why) if (refuse(name, name === 'money' ? ['money'] : ['sources']) && !collect) return out;
    if (!bandsHold(state, proof.bands, options.leaf) && refuse('bands', ['supply', 'sources']) && !collect) return out;
    const roots = new Map(proof.stockRoots);
    const leaf = options.leaf;
    // A held build passes its entry's fields; a card carries them on its leaf.
    const heldUnits = options.heldUnits ?? leaf?.heldAtDecision;
    const craftReservations = options.craftReservations ?? leaf?.craftReservations;
    // A held craft's reserved inputs may only grow before it runs: a stock
    // row holds while its owned+incoming does not fall (its own delivery
    // moves incoming into the bag), a physical row while its count does not.
    // Every root needing the input carries the same physical row: unlike the
    // own item, the tolerance is not scoped to the leaf's root.
    // A loss below what the decision reserved stays a quantity event.
    const reserved = leaf?.activity === 'crafting' && Array.isArray(craftReservations) ? craftReservations : null;
    const isReserved = id => reserved?.some(row => row[0] === id) === true;
    const stockAmount = (kind, key, id, currentOwned, originalOwned) => {
        if (kind === 'stockPhysical' && isReserved(id) && currentOwned >= originalOwned) return originalOwned;
        if (roots.get(key) !== id) return currentOwned;
        const band = proof.bands?.find(row => row[0] === id);
        return band && originalOwned === band[3] && currentOwned >= band[1]
            && (band[2] === null || currentOwned <= band[2]) ? originalOwned : currentOwned;
    };
    // Own outputs are not inputs: the leaf's own item moves with its progress.
    // It holds while the bot keeps what it held at the decision; the order's
    // completion is the activity check below, a loss is a quantity event.
    const own = ColdEconomyDecision.ownItem(leaf) !== null && Number.isFinite(heldUnits) ? leaf.itemId : null;
    if (own !== null && ColdEconomyDecision.heldFor(state, own) < heldUnits && refuse('quantity', ['sources', 'money']) && !collect) return out;
    // The proof is held packed and read as a stream: no rows array.
    const ownRow = own === null ? null : row => ownQuantityRow(row, leaf.rootKey, own);
    const stock = stockReader(state, key => roots.get(key));
    // A reserved input's stock row holds while its owned+incoming does not fall.
    const stockFor = !reserved ? stock : (id, rootKey, row) => {
        const current = stock(id, rootKey);
        return isReserved(id) && current.owned + current.incoming >= row[3] + row[4] ? { owned: row[3], incoming: row[4] } : current;
    };
    const moved = [];
    if (!quantityInputsHold(proof.quantities, { ...Providers.quantityReaders(state), stockFor }, stockAmount, ownRow, moved)
        && (moved.length ? refuse('quantity', ['sources', 'money']) && !collect : refuse('unproved'))) return out;
    const liquidation = Providers.liquidationInputs(state, proof.liquidation?.basis);
    // The leaf's own item and a craft's reserved inputs are not sales: their
    // count moves with the leaf's progress, held above by the quantity check.
    const sale = own === null && !reserved ? null : row => row[0] !== own && !isReserved(row[0]);
    const originalSales = sale ? proof.liquidation.rows.filter(sale) : proof.liquidation.rows;
    const currentSales = liquidation.proof && (sale ? liquidation.proof.rows.filter(sale) : liquidation.proof.rows);
    let changedLoot = false;
    const sameSales = currentSales && currentSales.length === originalSales.length
        && currentSales.every(([id, count], at) => {
            const original = originalSales[at];
            if (id !== original?.[0]) return false;
            if (count === original[1]) return true;
            changedLoot = true;
            const band = proof.bands?.find(row => row[0] === id);
            const item = ItemIndex.find(DataCache.items, id);
            // Only the existing finite unused-loot error band. Unlimited
            // surplus stock is sale capacity, not economic noise.
            return band && band[2] !== null && /^Other\.(Material|Arrow)/.test(String(item?.template?.kind || ''))
                && count - original[1] === positive(state.inventory?.[id]?.amount) - band[3];
        });
    if ((!sameSales || changedLoot && !choiceBagValueHolds(state, proof.bands, baseline, proof.hourAdena))
        && refuse('liquidation', ['sources', 'money']) && !collect) return out;
    // The leaf's own check (LEAF_CHECKS): a check:<name> refusal names its sections.
    const failed = leafCheck(state, leaf, deps, { heldUnits, current: null, prepared: { liquidation: liquidation.candidates } });
    if (failed && refuse(failed.reason, failed.sections) && !collect) return out;
    out.valid = !out.reason;
    return out;
}
// options.verdict receives what a run stopping at the first refusal answers,
// in either mode (touched = moved = the first refusal's sections): the card's
// verdict that joins the build's mask (forState, deps.eventVerdict). A
// refusal in collect mode (a card refused right before a build of the same
// step on the same state) also hands the whole verdict on with what it
// judged (`collected`, handedVerdict). A held card hands nothing: it is
// executed. The step's own verdict on the held build (heldWorkshop) hands
// itself, valid or not, to the build of its step, across the workshop ask.
// The hand-off of a verdict (`collected`): only what handedVerdict compares,
// no deps or options. leaf: the leaf the verdict judged (the card's compact
// one, or the held leaf itself, heldWorkshop); reads: the held build's reads
// it was judged with (heldReadsOf), handed by the step's own verdict only.
function collectedOf(verdict, state, proof, options, deps, reads = null) {
    return { verdict, state, proof, baseline: options.baseline, activity: options.activity, mp: options.mp,
        units: options.heldUnits ?? options.leaf?.heldAtDecision ?? null,
        reservations: options.craftReservations ?? options.leaf?.craftReservations,
        routeRows: deps.routeRows, tripCost: deps.tripCost, leaf: options.leaf, reads };
}
function eventProofHolds(state, proof, deps = {}, options = {}) {
    const verdict = heldBuildVerdict(state, proof, deps, options);
    if (options.verdict) {
        const first = verdict.firstSections;
        Object.assign(options.verdict, { valid: verdict.valid, reason: verdict.reason, touchedSections: first, movedSections: first });
        if (options.collect === true && !verdict.valid) options.verdict.collected = collectedOf(verdict, state, proof, options, deps);
    }
    if (!verdict.valid) options.why?.push(verdict.reason);
    return verdict.valid;
}
// The card's verdict of this step (eventProofHolds `collected`) or the
// step's own pre-verdict (heldWorkshop), served as
// the build's held verdict when it judged the same held entry on the same
// inputs: the same state object and proof, the proof's own baseline and
// activity, a leaf of the same identity, the same own units, reserved inputs
// (a craft leaf), crafter MP and trip rows. The deps it read beside these are
// the build's own: the caller spreads the card's deps into the build's
// (ColdSimulationWorker withEventVerdict), and the gear-threat mask
// is GearThreat's answer for the same state and deps. Else null: computed.
// The verdict lives with the step's deps, nothing keeps it.
const reservedRows = rows => rows?.length ? JSON.stringify(rows) : '';
// The card judged its leaf's compact form (ColdEconomyDecision.CompactActivity),
// of the same identity as the held leaf; the held leaf reads as it only where
// the compact form keeps what the verdict reads: the item (the compact one
// falls back to the wish object's), the sale rows (cut to 8) and the funding
// mark (made true). A verdict that judged the held leaf itself reads it.
function readsAsCompact(leaf) {
    if (!leaf) return true;
    const object = typeof leaf.object === 'number' ? leaf.object : leaf.object?.itemId;
    return (leaf.itemId ?? 0) === Number(leaf.itemId || object || 0) && !(leaf.items?.length > 8)
        && (!leaf.funding || leaf.funding === true);
}
function handedVerdict(handed, state, held, deps) {
    if (!handed || !held || handed.state !== state || handed.proof !== held.plan.eventProof) return null;
    const leaf = held.plan.network?.activity;
    if (handed.baseline !== held.plan.statsPacket.wishSections || handed.activity !== held.activity
        || !Object.is(handed.mp, held.mp) || handed.routeRows !== deps.routeRows || handed.tripCost !== deps.tripCost
        || handed.units !== (held.heldUnits ?? leaf?.heldAtDecision ?? null)
        || leaf?.activity === 'crafting' && reservedRows(handed.reservations)
            !== reservedRows(held.craftReservations ?? leaf.craftReservations)
        || !(handed.leaf === leaf || readsAsCompact(leaf))) return null;
    // The held leaf's identity is its proof's (captureEventProof, the same plan).
    return handed.verdict.leaf !== undefined && handed.verdict.leaf === handed.proof.activity ? handed.verdict : null;
}
function restartEventProof(proof, accepted) {
    if (proof?.version !== 2 || proof.restartable !== true || !accepted?.card
        || Object.keys(proof).some(key => !['version', 'owner', 'at', 'generation', 'decision', 'activity',
            'quantities', 'liquidation', 'stockRoots', 'bands', 'hourAdena', 'restartable'].includes(key))
        || !RecomputeGeneration.current() || proof.generation !== RecomputeGeneration.current()
        || !/^[a-f0-9]{64}$/.test(proof.generation)
        || proof.owner !== accepted.characterId || proof.at !== accepted.baseline?.at
        || !Array.isArray(proof.decision) || proof.decision.length !== 3
        || proof.decision[0] !== accepted.decisionSeq || proof.decision[1] !== accepted.activityLeaf
        || proof.decision[2] !== accepted.focus || proof.activity !== activityIdentity(accepted.card.activity)
        || proof.activity === null && (accepted.card.activity !== null || proof.decision[1] !== 0)) return null;
    const quantities = proof.quantities;
    if (!(quantities instanceof Uint8Array)) return null;
    try {
        // Version, the recompute generation (a restore under another one is
        // refused), the soft facts in the shared exact byte form, then the
        // quantity owner's opaque bytes to the end.
        const write = Bytes.writer();
        write.byte(7); write.raw(Buffer.from(proof.generation, 'hex'));
        if (!Providers.packLiquidationInputs(proof.liquidation, write)) return null;
        write.list(proof.stockRoots, row => {
            if (!Array.isArray(row) || row.length !== 2) throw Error('restart stock root');
            write.text(row[0]); write.uint(row[1]);
        });
        write.list(proof.bands, row => {
            if (!Array.isArray(row) || row.length !== 4) throw Error('restart band');
            write.uint(row[0]); write.number(row[1]); write.number(row[2], true); write.number(row[3]);
        });
        write.number(proof.hourAdena);
        write.raw(quantities);
        const bytes = write.finish();
        return bytes.byteLength <= PROOF_RAW_BYTES ? bytes : null;
    } catch (_) { return null; }
}
function restoreEventProof(prefix, accepted) {
    const generation = RecomputeGeneration.current();
    // No minimum length: every short read below throws and refuses the whole prefix.
    if (!generation || !(prefix instanceof Uint8Array)
        || prefix.byteLength > PROOF_RAW_BYTES || !accepted?.card) return null;
    try {
        const read = Bytes.reader(prefix);
        // A prefix of format 6 (it carried the deleted recipe producers' scope) is refused once.
        if (read.byte() !== 7 || read.raw(32).toString('hex') !== generation) return null;
        const liquidation = Providers.unpackLiquidationInputs(read);
        const stockRoots = Object.freeze(read.list(() => Object.freeze([read.text(), read.uint()])));
        const bands = Object.freeze(read.list(() => Object.freeze([read.uint(), read.number(), read.number(true), read.number()])));
        const hourAdena = read.number();
        // The packed quantity proof stays packed; a prefix it cannot read is refused here.
        const packed = Uint8Array.from(read.rest());
        const quantities = eachQuantityRow(packed, () => true) ? packed : null;
        if (!quantities || !Number.isSafeInteger(accepted.characterId)
            || accepted.card.activity === null && accepted.activityLeaf !== 0
            || !Number.isFinite(accepted.baseline?.at)) return null;
        return Object.freeze({ version: 2, restartable: true, owner: accepted.characterId, at: accepted.baseline.at,
            decision: Object.freeze([accepted.decisionSeq, accepted.activityLeaf, accepted.focus]),
            activity: activityIdentity(accepted.card.activity), generation,
            quantities, liquidation, stockRoots, bands, hourAdena });
    } catch (_) { return null; }
}
function wireEventProof(proof) {
    if (!proof || proof.version !== 2
        || (proof.activity === null ? proof.decision?.[1] !== 0 : typeof proof.activity !== 'string')) return null;
    try {
        if (!(proof.quantities instanceof Uint8Array)) return null;
        // Packed quantities cross as canonical base64 (receiveEventProof), so
        // this JSON size is the wire's.
        const wire = { ...proof, quantities: Buffer.from(proof.quantities).toString('base64') };
        return Buffer.byteLength(JSON.stringify(wire)) <= PROOF_RAW_BYTES ? wire : null;
    } catch (_) { return null; }
}
// The proof from its wire form or in process; null when its packed
// quantities are malformed or above their bound.
function receiveEventProof(proof) {
    const value = proof?.quantities, cap = Network.QUANTITY_INPUT_BYTES;
    const quantities = value instanceof Uint8Array ? value.byteLength <= cap ? value : null : Bytes.fromBase64(value, cap);
    return quantities ? { ...proof, quantities } : null;
}
function quantityBands(state, context, projection) {
    const bands = [], stock = new Map();
    for (const kind of ['shots', 'potions', 'scrolls']) {
        const row = context.stock(kind);
        if (row?.itemId && row.target > 0) stock.set(Number(row.itemId), [Math.max(1, Math.ceil(row.target - positive(row.beginnerCurrent))),
            kind === 'shots' ? row : null]);
    }
    const reserved = invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(state);
    const used = new Set((projection?.nodes || []).filter(node => node.key.startsWith('item:')).map(node => Number(node.key.slice(5))));
    const error = Sections.incomeError(state, context.persona);
    for (const [id, row] of Object.entries(state.inventory || {})) {
        const amount = positive(row.amount), itemId = Number(id), template = ItemIndex.find(DataCache.items, itemId);
        if (!amount || row.equipped || row.equippedCount || row.protected || row.protectedAmount || row.reservedAmount
            || row.acceptedCustomer || row.assignedClan || row.available === false || positive(reserved[id])
            || (row.stackable ?? template?.etc?.stackable) !== true) continue;
        if (stock.has(itemId)) {
            const [target, shots] = stock.get(itemId);
            if (amount >= target) bands.push([itemId, target, null, amount]);
            else if (shots && shots.unitPrice > 0) {
                // Shots between the survival line and the target: each unit
                // only moves the restock wish's amount, price and value
                // together. Consumption below the bot's own error (money and
                // hours) is noise; the survival line (survival reserve,
                // `needed`) and an empty stack (use rate, planned slot) stay
                // hard, and any rise is the purchase's own event.
                const floor = Math.max(1, Math.ceil(shots.survivalTarget - positive(shots.beginnerCurrent)));
                const allowance = Math.floor(Math.min(positive(context.hourAdena) * error / shots.unitPrice,
                    shots.benefitPerUnit > 0 ? error / shots.benefitPerUnit : Infinity));
                const low = Math.max(floor, amount - allowance);
                if (amount >= floor && low < amount) bands.push([itemId, low, amount, amount]);
            }
            continue;
        }
        // Only existing free stacks absent from every admitted requirement.
        // A book, recipe, target, new stack or unknown item keeps exact facts.
        const kind = String(template?.template?.kind || row.kind || '');
        if (used.has(itemId) || state.clanId || state.stats?.clanId || positive(state.stats?.karma)
            || !/^Other\.(Material|Arrow)/.test(kind)) continue;
        const unitValue = positive(context.buyback(itemId));
        if (!(unitValue > 0)) continue;
        const allowance = Math.floor(positive(context.hourAdena) * error / unitValue);
        bands.push([itemId, kind.startsWith('Other.Arrow') ? 1 : amount, amount + allowance, amount]);
    }
    return bands;
}
function choiceBagValue(state, bands, price = buyback) {
    return bands.reduce((value, [id, , high]) => value + (high === null ? 0
        : positive(state.inventory?.[id]?.amount) * positive(price(id))), 0);
}
function choiceBagValueHolds(state, bands, baseline, hourAdena, value = choiceBagValue(state, bands)) {
    return Number.isFinite(baseline?.bagValue)
        && Math.abs(value - baseline.bagValue)
            <= positive(hourAdena) * positive(baseline.incomeError);
}
// The cheap check of a held decision: one row per kind of leaf answers "does
// it still stand?" at the decision point (heldBuildVerdict). A row returns ''
// or its own frozen failure: the name (check:<name>) and the sections the
// build that follows re-weighs. input = { heldUnits, current, prepared }:
// heldUnits = the own item's bag+incoming at the decision (a held
// build's entry; a card carries it on its leaf); current = a lazy basics
// reader; prepared = { liquidation } candidates already read by the verdict.
// Execution still prepares its batch and checks via the command/CAS.
const failure = (name, ...sections) => Object.freeze({ reason: `check:${name}`, sections: Object.freeze(sections) });
const EXCLUDED = failure('excluded', 'occupation', 'sources'), MATERIAL_DONE = failure('material_done', 'sources');
const OFFER = failure('offer', 'sources', 'money'), SALE = failure('sale', 'sources', 'supply');
const CRAFT = failure('craft', 'sources', 'supply'), TARGET = failure('target', 'relations');
const IMPROVEMENT = failure('improvement', 'sources'), UNSUPPORTED = failure('unsupported', 'sources');
const withHeldUnits = (leaf, heldUnits) => ColdEconomyDecision.ownItem(leaf) !== null && Number.isFinite(heldUnits)
    ? { ...leaf, heldAtDecision: heldUnits } : leaf;
// The hunting spot against the bot's marks (died here, was full, avoided a
// quarrel) and its death pressure: the one exclusion read of a decision.
function spotExcluded(state, leaf) {
    return SpotRiskPolicy.excludedSpotIdsForStates([state]).has(String(leaf.spotId)) ? EXCLUDED : '';
}
// A trade leaf's town route: known and its fees payable now.
function tradeRoute(state, leaf, deps) {
    const trip = deps.tripCost || Trip.preparedReader(deps.routeRows || [], { hourAdena: positive(state.stats?.money?.[0]) });
    const route = trip.details?.(leaf.town);
    return route?.known && Number.isFinite(route.fees) && route.fees <= positive(state.adena) ? { trip, route } : null;
}
const LEAF_CHECKS = Object.freeze({
    hunting: (state, leaf, deps, input) => spotExcluded(state, leaf)
        || (ColdEconomyDecision.materialHunt(leaf)
            && ColdEconomyDecision.remainingToOrder(withHeldUnits(leaf, input.heldUnits), state) <= 0 ? MATERIAL_DONE : ''),
    shopping: (state, leaf, deps, input) => {
        deps = resolved(state, deps, false);
        const trade = tradeRoute(state, leaf, deps);
        if (!trade || !(leaf.kind === 'buy' && leaf.itemId > 0 && leaf.amount > 0 && leaf.unitPrice > 0
            && ['npc', 'configured_store', 'afk'].includes(leaf.sourceType))) return OFFER;
        const held = withHeldUnits(leaf, input.heldUnits);
        const remaining = ColdEconomyDecision.remainingToOrder(held, state);
        if (!(remaining > 0)) return OFFER;
        const offer = PurchaseEvidence.reader(state, { board: deps.board, trip: trade.trip }, deps)(leaf.itemId);
        if (!offer || offer.sourceType !== leaf.sourceType || offer.town !== leaf.town
            || offer.unitPrice !== leaf.unitPrice || offer.availableUnits < remaining) return OFFER;
        return Funding.spendable(state, deps.buyOrderEscrow, Funding.nativeTerms(held, leaf.itemId))
            >= remaining * offer.unitPrice + trade.route.fees ? '' : OFFER;
    },
    selling: (state, leaf, deps, input) => {
        deps = resolved(state, deps, false);
        if (!tradeRoute(state, leaf, deps) || !(leaf.kind === 'liquidate' && leaf.funding === true && leaf.items?.length
            && OccupationSources.hasNpcSellerInTown(leaf.town))) return SALE;
        return (input.prepared?.liquidation || Providers.liquidationCandidates(state, input.current ? input.current() : basics(state, deps)))
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
    improving: (state, leaf) => {
        const improvement = leaf.improvement;
        if (!improvement || typeof improvement !== 'object' || Array.isArray(improvement)) return IMPROVEMENT;
        // An enchant or a special ability names its object: it is still in the
        // bag under its item at the enchant level the decision read. Other
        // objects in the bag are no input; an exchange or a crystallization
        // names none (its inputs are bag rows, held by the quantity proof).
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
        ...(board.heads ? { heads: (selfId, ...rest) => { watch(selfId); return board.heads(selfId, ...rest); } } : {})
    });
}
// The decision's watch list, read by the soft point (DecisionSections
// .softEvents): the wish roots it would buy (their sell lines, storeType 1)
// and its sale rows (their buy lines, 3), each [itemId, storeType, reference
// price, error], at most Sections.MARKET_WATCH. buyValue/sellValue: the
// build's price of an item on that side; errorOf: the bot's error on it.
// The reference is the better of that price and the board head the build
// saw (excluding the bot's own line): the head is one input of the price
// belief, so a far cheaper ask stays below the believed price after the
// rebuild and would cross at every step; the decision already weighed it.
// Only a newer, clearly better line crosses. recipe: the build's productive
// workshop recipe (a crafter's); its product's buy lines and its materials'
// sell lines are watched too, after the wishes and sales, so a crossing
// raises money and the kept workshop is asked again (Sections.COMPUTED.workshop).
function marketWatchRows(queue, sales, board, ownerId, buyValue, sellValue, errorOf, recipe = null) {
    const rows = [], exclude = { excludeOwner: ownerId };
    const add = (id, storeType, value) => {
        if (rows.length >= Sections.MARKET_WATCH || !(id > 0) || !(value > 0)
            || rows.some(row => row[0] === id && row[1] === storeType)) return;
        const head = board?.first(id, storeType, exclude)?.price;
        const reference = !(head > 0) ? value : storeType === SELL ? Math.min(value, head) : Math.max(value, head);
        // Rounded: the baseline is saved with the bot (a few bytes per row).
        rows.push([id, storeType, Math.round(reference), Math.round(errorOf(id) * 1000) / 1000]);
    };
    for (const wish of queue) { const id = Number(wish.object?.itemId); if (id > 0) add(id, SELL, buyValue(id)); }
    for (const [id] of sales) add(Number(id), BUY, sellValue(id));
    // Last: the workshop's rows never push a wish or a sale out of the cap.
    if (recipe) {
        add(Number(recipe.productId), BUY, sellValue(Number(recipe.productId)));
        for (const row of recipe.materials || []) add(Number(row.selfId), SELL, buyValue(Number(row.selfId)));
    }
    return rows;
}
function defaultProducerSource(state, board) {
    const index = invoke('GameServer/Bot/Population/ColdOccupationSources').recipeIndex(board);
    const level = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state), scope = index.scopeFor(level);
    return { recipes: index.rowsFor(level), scope, revision: index.revision(scope) };
}
// The deps a full resolve made, with the state it was made for: a check
// inside the same build (heldBuildVerdict, its LEAF_CHECKS rows) is given
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
        if (isMainThread && !Object.hasOwn(deps, 'workshop')) deps.workshop = craftIncome(state);
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
function pricing(state, persona, board, timestamp, deps, read = () => {}, prices = new Map()) {
    const knowledgeEnabled = deps.knowledgeEnabled ?? Knowledge.knowledgeEnabled();
    const priceCtx = { characterId: state.characterId, understanding: persona.understanding ?? 0.3,
        marketTrades: state.marketTrades, knowledgeEnabled, board, timestamp };
    const beliefs = new Map();
    const beliefFor = id => {
        if (!beliefs.has(Number(id))) beliefs.set(Number(id), PriceBelief.prior(id, priceCtx) || null);
        return beliefs.get(Number(id));
    };
    return { knowledgeEnabled, prices, beliefs, beliefFor, price: id => {
        read(id);
        if (!prices.has(Number(id))) {
            const belief = beliefFor(id);
            prices.set(Number(id), belief ? Math.exp(belief.mu) : 0);
        }
        return prices.get(Number(id));
    } };
}
// Price future carried scroll uses only if a review needs extra stock.
// Resolve the known hunt through the existing catalogue index; a merchant
// location during a town visit is never a future hunting origin.
// Below karma that closes towns the saving reads only the origin, the static
// town and gatekeeper tables and the travel mode (ColdTrip.honest), so a hunt
// spot's answer is kept on its catalogue object per travel mode: the two
// route solves run once per spot, not in every build.
const spotScrollHours = new WeakMap();
function scrollHoursFor(state, spots, bestSpotId) {
    if (invoke('GameServer/Karma').closesTowns(state.stats?.karma)) return 0;
    const spot = SpotIndex.spotById(spots, bestSpotId);
    if (!spot?.center) return scrollSavingHours(state, state.stats?.marketReturn?.loc || (state.activity === 'hunting' ? state.loc : null));
    const honest = ColdTrip.honest();
    const held = spotScrollHours.get(spot);
    if (held?.honest === honest) return held.hours;
    const hours = scrollSavingHours(state, spot.center);
    spotScrollHours.set(spot, { honest, hours });
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
// stock(kind) and kitCost(id) over the kit data of one review: the build and
// every later view of its plan answer from the same numbers. Prices go
// through the caller's price reader, so each read joins the review's inputs.
function kitReader(data, price, scrollUseHours) {
    const stock = kind => {
        if (kind === 'scrolls') {
            const current = data.scrolls,
                target = invoke('GameServer/Bot/Travel/ScrollStock').TARGET_AMOUNT, survivalTarget = 1;
            const missing = Math.max(0, target - Math.max(current, survivalTarget));
            const benefitPerUnit = current < target ? scrollUseHours() : 0;
            return { itemId: 736, usePerHour: 0, current, hours: Infinity, targetHours: data.targetHours, target,
                survivalTarget, survivalMissing: Math.max(0, survivalTarget - current), missing,
                unitPrice: price(736), benefitPerUnit, benefitHours: missing * benefitPerUnit, needed: current < target };
        }
        const shots = kind === 'shots';
        const row = shots ? data.shots : data.potions;
        const { itemId, use, current } = row;
        const wantedTarget = Math.max(Math.ceil(use), Math.ceil(use * data.targetHours));
        // Useful owned stock need not justify expensive replacement stock.
        const target = row.canRestock ? wantedTarget : Math.min(current, wantedTarget);
        // Forecast consumption may be fractional; both purchase tranches use
        // the same whole-unit survival stock so their sum remains executable.
        const survivalTarget = row.canRestock ? Math.ceil(use) : Math.min(current, Math.ceil(use));
        const survivalMissing = Math.max(0, survivalTarget - current);
        const missing = Math.max(0, target - Math.max(current, survivalTarget));
        const benefitPerUnit = use > 0 ? row.benefit / use : 0;
        const benefitHours = missing * benefitPerUnit;
        return { itemId: Number(itemId), usePerHour: use, ...(shots ? { ownedUsePerHour: row.ownedUsePerHour, beginnerCurrent: row.beginnerCurrent,
                beginnerUsePerHour: row.beginnerUsePerHour, paidUsePerHour: row.paidUsePerHour } : {}),
            current, hours: use > 0 ? current / use : Infinity,
            targetHours: data.targetHours, target, survivalTarget, missing, survivalMissing, unitPrice: price(itemId), benefitPerUnit, benefitHours,
            needed: use > 0 && current < survivalTarget };
    };
    const kit = [stock('shots'), stock('potions')];
    const escapeCost = data.closed ? 0 : price(736) * Math.max(0, 1 - data.scrolls);
    // A known executable quote pays whole missing units once. The personal
    // price estimate still values an unseen option; it must not underfund
    // a concrete merchant's mandatory stock and trigger repeated tiny fills.
    const kitCost = (id, unitPrice = null) => {
        const quoted = Number.isFinite(unitPrice) && unitPrice > 0;
        if (Number(id) === 736 && data.closed) return 0;
        if (Number(id) === 736) return quoted ? unitPrice * Math.max(0, 1 - data.scrolls) : escapeCost;
        return kit.filter(row => row.itemId === Number(id)).reduce((sum, row) => sum
            + row.survivalMissing
                * (quoted ? unitPrice : row.unitPrice), 0);
    };
    return { stock, kitCost, kit, escapeCost };
}
// The bot's hour, death and karma prices and its stock of shots and potions:
// the part of a review that needs no wish network. forState builds on it and
// basics() returns it alone, so a reader that wants only these never builds
// the network, and both give the same numbers.
// ARCH-NOTE: PERF (L120): the income route search (EquipmentIncomeRoute.select)
// is most of a foundation. A cold step often builds basics() and then
// forState() for the same projected state; the second build takes the
// first one's route through deps.preparedIncomeRoute instead of searching
// again. Key: the same state object, timestamp and spots objects,
// mode, maxChecks and required gear flag. Select also reads module state
// (SpotRiskPolicy exclusions, SpotValueTable tables,
// LevelingRoutes, the ColdCombatProfile kit store), so the reuse is exact only because
// nothing yields or writes between the basics and the build of one step: a
// record must never cross an await or a write to the bot's spot marks.
// The record keeps each price(id) select made, in order, with
// its value: the build replays them through its own price first, so its
// read set, price and belief maps and board watch fill exactly as a fresh
// search would, and a price that came out different searches afresh. The
// record travels only by deps (the cold worker passes its basics' record);
// select returns plain data (no closure over price).
function incomeRouteFor(state, deps, timestamp, price, keep) {
    const required = GearProgression.assess(state).required;
    const prepared = deps.preparedIncomeRoute;
    if (prepared && prepared.state === state && prepared.timestamp === timestamp && prepared.spots === deps.spots
        && prepared.mode === deps.mode
        && prepared.maxChecks === deps.maxChecks && prepared.required === required) {
        let same = true;
        for (let i = 0; i < prepared.reads.length; i += 2) {
            if (!Object.is(price(prepared.reads[i]), prepared.reads[i + 1])) same = false;
        }
        if (same) { keep?.(prepared); return prepared.route; }
    }
    const reads = keep ? [] : null;
    const route = IncomeRoute.select(state, { ...deps, timestamp, required,
        price: keep ? id => { const value = price(id); reads.push(id, value); return value; } : price });
    keep?.({ state, timestamp, spots: deps.spots, mode: deps.mode,
        maxChecks: deps.maxChecks, required, reads, route });
    return route;
}
// The bot's own fit for the spot of its hunting leaf (docs/architecture.md §2
// route): the route's one test, BotRoute.leafFitReader, as a yes or no per
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
    const tableRole = Roles.tableRoleFor(state);
    const incomeRoute = incomeRouteFor(state, deps, timestamp, price, keepRoute);
    let hunt;
    if (incomeRoute) {
        // select already passed this spot through the same ground and matchup reader.
        const row = incomeRoute.row;
        hunt = { perHour: row.income * Hunt.onSpotShare(state), perKill: row.kills > 0 ? row.income / row.kills : 0,
            expPerHour: row.exp * Hunt.onSpotShare(state), source: 'route', spotId: incomeRoute.spot.id,
            progressSpotId: incomeRoute.spot.id, useShots: row.useShots };
    } else hunt = Hunt.huntIncome(state, timestamp, deps.mode, leafFit(state, deps, timestamp));
    const lostGearHours = hunt.perHour > 0 ? Valuation.pkDropValue(state, price) / hunt.perHour : 0;
    const bestSpotId = hunt.spotId || state.spotId;
    const walkBackHours = WalkBack.hours(bestSpotId, state, deps.spots || SpotService.spots);
    const deathHours = Valuation.deathHours(state, { ...hunt, lostGearHours, walkBackHours });
    const spotTable = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, hunt.useShots !== false) : null;
    const bestTable = spotTable || Table.best(tableRole, state.level, hunt.useShots !== false);
    const ShotStock = invoke('GameServer/Inventory/ShotStock');
    const shotPlan = ShotStock.planForState(state);
    const shotItemId = shotPlan.selfId;
    const potionItemId = invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId;
    const withoutShots = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, false) : null;
    const shotPolicy = ShotStock.usePolicy(state, { plan: shotPlan, bestTable, withoutShots,
        hourAdena: Hunt.huntHour(hunt, state), unitPrice: price(shotItemId) });
    const shotBenefit = shotPolicy.benefit;
    const beginnerCurrent = ShotStock.beginnerAmount(state, shotPlan);
    const shotUse = positive(state.inventory?.[shotItemId]?.amount) + beginnerCurrent > 0
        ? shotPolicy.usePerHour : shotPolicy.purchaseUsePerHour;
    const potionUse = positive(bestTable?.potions);
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
            + Number(potionUse > 0 && !positive(state.inventory?.[potionItemId]?.amount));
        let slotLimit = Floor.inventoryLimit(race);
        const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
        const saleLimit = Disposition.soloSaleSlotLimit(state, timestamp);
        if (saleLimit !== null) {
            // Stock cannot be its own reason for an earlier town visit. Keep
            // the entire usable kit while checking known free saleable loot.
            const keptAmounts = { [shotItemId]: positive(state.inventory?.[shotItemId]?.amount),
                ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: Infinity }),
                736: positive(state.inventory?.[736]?.amount) };
            if (Disposition.saleCandidates(state, { keptAmounts, preparedReservations: deps.saleReservations,
                presenceOnly: true })) slotLimit = Math.min(slotLimit, saleLimit);
        }
        const free = Math.max(0, slotLimit - Floor.stateInventory(state, Data.items).slots - plannedSlots);
        bagHours = free === 0 ? 0 : spotTable.stacks > 0 ? free / spotTable.stacks : 24;
    }
    const Visits = invoke('GameServer/Bot/Economy/TownVisitInterval');
    // Bag space bounds a planned outing; it never chooses its duration.
    // Keep the existing initial estimate until actual town visits teach one.
    const targetHours = hasBagForecast
        ? Math.min(Visits.targetHours(state.stats), Visits.targetHours({}, bagHours))
        : Visits.targetHours(state.stats);
    // The kit as data (perf C1): what stock() and kitCost() read, so a kept
    // plan answers them later without this build scope.
    const kitData = { targetHours, scrolls: positive(state.inventory?.[736]?.amount),
        closed: invoke('GameServer/Karma').closesTowns(state.stats?.karma), scrollHours: undefined,
        shots: { itemId: shotItemId, use: shotUse, current: positive(state.inventory?.[shotItemId]?.amount) + beginnerCurrent,
            canRestock: shotPolicy.purchaseUsePerHour > 0, benefit: shotBenefit, ownedUsePerHour: shotPolicy.usePerHour,
            beginnerCurrent, beginnerUsePerHour: shotPolicy.beginnerUsePerHour, paidUsePerHour: shotPolicy.paidUsePerHour },
        potions: { itemId: potionItemId, use: potionUse, current: positive(state.inventory?.[potionItemId]?.amount),
            canRestock: true, benefit: positive(bestTable?.deaths) * deathHours } };
    const { stock, kitCost, kit, escapeCost } = kitReader(kitData, price,
        () => kitData.scrollHours ??= scrollHoursFor(state, deps.spots, bestSpotId));
    const reserve = escapeCost + kit.reduce((sum, row) => sum + row.survivalMissing * row.unitPrice, 0);
    return { tableRole, hunt, hourAdena: Hunt.huntHour(hunt, state), survivalReserve: reserve, kitCost, kit: kitData,
        lostGearHours, bestSpotId, deathHours, bestTable, stock,
        riskWeight: Valuation.riskWeight(state, persona),
        expectedDeathHours: positive(bestTable?.deaths) * deathHours,
        karmaHours: Valuation.karmaHours(state, { ...hunt, lostGearHours, deathsPerHour: positive(bestTable?.deaths) }) };
}
function foundationFromPlan(state, plan, deps, price) {
    const { stock, kitCost } = kitReader(plan.kit, price,
        () => plan.kit.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId));
    return { hunt: plan.hunt, hourAdena: plan.hourAdena, survivalReserve: plan.survivalReserve,
        kit: plan.kit, stock, kitCost, lostGearHours: plan.lostGearHours, bestSpotId: plan.bestSpotId,
        deathHours: plan.deathHours, riskWeight: plan.riskWeight,
        expectedDeathHours: plan.expectedDeathHours, karmaHours: plan.karmaHours };
}
function basics(state = {}, deps = {}) {
    deps = resolved(state, deps, false);
    const timestamp = Number(deps.timestamp || Date.now());
    const persona = personaOf(state, deps);
    const board = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    const { price } = pricing(state, persona, board, timestamp, deps);
    let route = null;
    // The main thread records only on request (deps.keepIncomeRoute): its builds never read a record.
    const keep = !isMainThread || deps.keepIncomeRoute ? record => { route = record; } : null;
    const base = { persona, price, timestamp, ...foundation(state, deps, persona, timestamp, price, keep) };
    // Not enumerable: a view spread over these basics does not carry it (L120).
    Object.defineProperty(base, 'preparedIncomeRoute', { value: route });
    return base;
}
function stockFor(state, kind, deps = {}) { return basics(state, deps).stock(kind); }
// A route table with a row for every town (EconomicTrip.prepare).
const fullRoute = rows => Array.isArray(rows) && rows.length === Trip.towns.length;
// The bot's held build's key (cache) and its group's.
const actorKeyOf = (state, deps) => deps.actorKey || `character:${Number(state.characterId || 0)}`;
// What the verdict on the held build compares against its own entry.
function heldOptionsOf(held) {
    return { baseline: held?.plan.statsPacket.wishSections, activity: held?.activity,
        leaf: held?.plan.network?.activity, heldUnits: held?.heldUnits, craftReservations: held?.craftReservations,
        mp: held?.mp };
}
// What a build and its verdict read beside the held entry: the gear threat,
// the facts, read once (the held leaf's own trip is read as the field
// activity it ordered, fieldActivity), and the build's input name.
function heldReadsOf(state, deps, held) {
    const gearThreat = GearThreat.prepare(state, deps, held?.gearThreat);
    const current = fieldActivity(state, held?.activity, held?.plan.network?.activity);
    const facts = requestFacts(current, deps);
    return { gearThreat, current, facts, key: inputName(facts, gearThreat.mask) };
}
// The one verdict on the held build (heldBuildVerdict), collecting: the
// sections of all its refusals, no held build or an unproved one = every
// section. Over resolved deps, which it completes with the route rows and
// the gear-threat mask the build reads. handed: the step's collected
// verdict, served when it judged this entry on the same inputs
// (handedVerdict), else null and the verdict is computed here; the step's
// own verdict also hands its reads, made on the same state and deps. Read
// by the build (forState) and, before it, by the worker step's workshop
// (heldWorkshop).
function heldVerdictFor(state, deps) {
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
    const collected = deps.eventVerdict?.collected;
    const handed = handedVerdict(collected, state, held, deps);
    const reads = handed && collected.reads || heldReadsOf(state, deps, held);
    deps.gearThreatMask = reads.gearThreat.mask;
    const verdict = handed || heldBuildVerdict(state, held?.plan.eventProof, deps,
        { ...heldOptionsOf(held), facts: reads.facts, collect: true });
    return { held, reads, verdict, handed };
}
// The sections a build rebuilds (forState's mask): the raised bits, the
// prepared card's verdict (cardVerdict, its first refusal) and the held
// build's own verdict (heldVerdict, collected).
function verdictMask(state, cardVerdict, heldVerdict) {
    return (Number(state.stats?.wishDirty) || 0) | (Number(cardVerdict?.touchedSections) || 0)
        | (Number(heldVerdict?.touchedSections) || 0);
}
function forState(state = {}, deps = {}) {
    const diagnostic = Diagnostics.active();
    const inputSequence = Number(state.stats?.decisionSeq || 0);
    if (diagnostic) Diagnostics.count('context', 'request');
    deps = resolved(state, deps);
    const timestamp = Number(deps.timestamp || Date.now());
    const actorKey = actorKeyOf(state, deps);
    // lazy: worker the board's owner lives on main; the worker passes its board.
    const sourceBoard = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    const { held, reads, verdict: eventVerdict, handed } = heldVerdictFor(state, deps);
    const { gearThreat, current, facts, key } = reads;
    // Read once: the hand-off ends here, served or not.
    if (deps.eventVerdict?.collected) deps.eventVerdict.collected = null;
    if (diagnostic && handed) Diagnostics.count('context', 'held_verdict', 'reused');
    // A valid held build is served. A caller that needs the member's graph
    // nodes (a worker group solve) builds unless the held entry kept them
    // (the main thread keeps them, the worker a party member's).
    if (eventVerdict.valid && !(deps.withNodes && !held.projection)) {
        if (deps.onSourceRead) for (const id of held.readIds) deps.onSourceRead(id);
        if (diagnostic) {
            Diagnostics.count('context', 'hit', held.key === key ? 'same_inputs' : 'own_result');
            // The timeline sees the served request too (tools/timeline).
            if (Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
                caller: deps.caller || 'economy_context', trigger: deps.trigger || 'request', phase: 'wish_context',
                reason: held.key === key ? 'hit_same_inputs' : 'hit_own_result', outcome: 'held',
                revision: state.simulation?.revision, wallet: positive(state.adena) });
        }
        if (deps.rememberContext !== false) {
            held.gearThreat = gearThreat;
            held.stateRef = new WeakRef(state);
            remember(cache, actorKey, held, RETAIN_LIMIT);
        }
        // A late price read of a held plan is reported as in its build.
        const late = id => deps.onSourceRead?.(Number(id));
        return view(state, held.plan, deps, { board: sourceBoard, read: late, projection: held.projection });
    }
    // The mask: the sections that moved since the held build (the raised
    // bits, the prepared card's verdict, this verdict's refusals). A computed
    // piece (Sections.COMPUTED) is rebuilt when one of its sections is in it,
    // else reused from the held build.
    const mask = verdictMask(state, deps.eventVerdict, eventVerdict);
    // The foundation is reused with the prices and the horizon it was priced with.
    // Reads no section names, reused with it: the persona and the town-visit
    // rhythm. The walk's unnamed reads, reused with its memo until a source
    // section is raised:
    // hunt efficiency and clock, spot risk and the active spot exclusions
    // (they expire by time), exp, persona, market trades, craft station,
    // the equipment plan and the crafter's MP.
    const keptBase = held && !(mask & Sections.COMPUTED.foundation) ? held.plan : null;
    const keptSources = held?.sourceSections && !(mask & Sections.COMPUTED.sources) ? held : null;
    // The source walk's per-spot ground verdict, outside the memo's size cap:
    // its own section rule (GearAcquisitionPlanner.sourceGround).
    const keptGround = !(mask & Sections.COMPUTED.sourceGround) ? held?.sourceGround || null : null;
    const started = diagnostic ? performance.now() : 0;
    // The build's cause, one of a few names (its duration layer). An
    // input-name mismatch is named as a dependency change; it does not claim
    // which historical event caused it.
    const diagnosticReason = !diagnostic ? null : !held ? deps.rememberContext === false ? 'unkept_caller' : 'not_retained'
        : held.key !== key ? 'input_dependency_changed'
        : !eventVerdict.valid ? 'held_refused' : 'nodes_needed';
    if (diagnostic) Diagnostics.count('context', 'miss', diagnosticReason);
    // A held refusal split by the verdict's first reason and by whether the
    // caller keeps the build: it picks which refusal to make cheaper.
    if (diagnosticReason === 'held_refused') {
        Diagnostics.count('context', deps.rememberContext === false ? 'held_refusal_unkept' : 'held_refusal', eventVerdict.reason || 'none');
    }
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
    const bagToken = id => JSON.stringify([state.inventory?.[id] || null, state.acceptedIncoming?.[id] || 0]);
    const bagIds = () => Object.keys(state.inventory || {}).filter(id => Number(id) !== 57);
    // ARCH-NOTE: PERF: the build is one synchronous call (its generators are
    // drained inside it). The bag (state.inventory rows, state.acceptedIncoming)
    // is not mutated during the build: an item's bag token and the bag's id
    // list are built once per build. A late read through the view (after
    // either return below) builds it fresh, as its inputs may have moved
    // since. Dies at return.
    let tokensLive = true, liveBagIds = null, liveBagKeys = null;
    const bagTokens = new Map();
    const endTokens = () => { tokensLive = false; bagTokens.clear(); liveBagIds = liveBagKeys = null; };
    const bagTokenOf = id => {
        if (!tokensLive) return bagToken(id);
        const at = String(id); // the property key bagToken reads
        let token = bagTokens.get(at);
        if (token === undefined) bagTokens.set(at, token = bagToken(id));
        return token;
    };
    const wholeBagIds = () => tokensLive ? liveBagIds ??= bagIds() : bagIds();
    const wholeBagKeys = () => tokensLive ? liveBagKeys ??= JSON.stringify(wholeBagIds().slice().sort())
        : JSON.stringify(bagIds().sort());
    const read = id => { id = Number(id);
        if (!(id > 0)) return;
        // Every open node scope notes the id once (an id the innermost holds,
        // every outer one holds too): a memoized node reports it again.
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
    const cash = Sections.bounds(positive(state.adena));
    const budget = Sections.bounds(Funding.budget(state, deps.buyOrderEscrow));
    const board = watchedBoard(sourceBoard, watch);
    // A price is remembered, so every price read counts, also a late one
    // through context.price: its item joins the review's inputs.
    const { price, prices, beliefs, beliefFor, knowledgeEnabled } = pricing(state, persona, board, timestamp, deps, read,
        keptBase ? new Map(keptBase.prices) : new Map());
    // The income route record of this build (its own search or the basics'
    // one): its solo matchup profiles serve the providers' source route reader.
    let incomeRecord = null;
    const base = keptBase ? foundationFromPlan(state, keptBase, deps, price)
        : foundation(state, deps, persona, timestamp, price, record => { incomeRecord = record; });
    // These facts still belong to the reused foundation: its items stay read.
    if (keptBase) for (const id of held.readIds) read(id);
    const quantityInputs = createQuantityInputs();
    const context = { inputKey: key, actorKey, state, timestamp, gearThreatMask: gearThreat.mask, persona, board, hunt: base.hunt, price, buyback,
        quantityInputs,
        // The gear nomination's basis (the equipment plan's target, the power
        // focus) is a source walk input no section names: a focus moves only
        // with a build or the echo, so it is reused with the walk.
        nominationBasis: keptSources?.plan.nominationBasis || Providers.nominationBasis(state),
        ...(keptBase ? { horizonHours: keptBase.horizonHours } : {}),
        riskWeight: base.riskWeight, bestSpotId: base.bestSpotId, deathHours: base.deathHours, lostGearHours: base.lostGearHours,
        karmaHours: base.karmaHours, expectedDeathHours: base.expectedDeathHours, stock: base.stock,
        survivalReserve: base.survivalReserve, kitCost: base.kitCost, hourAdena: base.hourAdena,
        walletBoundary: cash.watch,
        budgetBoundary: budget.watch,
        // The per-node source memo: its inputs are the bag only (prices and
        // spots are none; a raised section of the walk voids the memo, the
        // mask). The item ids a node read are kept without a token, only so
        // that a reused node reports them again (deps.onSourceRead).
        nodeInputs: { begin: () => { const local = { items: new Set(), bag: new Map() }; nodeScopes.push(local); return local; },
            end: () => nodeScopes.pop(),
            bag: id => { if (!(Number(id) > 0) || !nodeScopes.length) return;
                const token = bagTokenOf(id);
                const top = nodeScopes[nodeScopes.length - 1];
                if (token === undefined || top.bag.get(Number(id)) !== token) for (const local of nodeScopes) local.bag.set(Number(id), token); },
            wholeBag: () => { if (!nodeScopes.length) return;
                for (const id of wholeBagIds()) context.nodeInputs.bag(id);
                const token = wholeBagKeys();
                const top = nodeScopes[nodeScopes.length - 1];
                if (token === undefined || top.bag.get(-1) !== token) for (const local of nodeScopes) local.bag.set(-1, token); },
            holds: input => (input.bag || []).every(([id, token]) => (id === -1 ? wholeBagKeys() : bagTokenOf(id)) === token),
            keep: input => { for (const id of input.items || []) read(id);
                for (const [id] of input.bag || []) if (id === -1) context.nodeInputs.wholeBag(); else context.nodeInputs.bag(id); } },
        readScope: { open: () => (scope = new Set()), close: () => { scope = null; },
            keep: kept => { for (const id of kept) read(id); } } };
    // A worker build given no workshop keeps the held build's (keptWorkshop).
    const workshop = Object.hasOwn(deps, 'workshop') ? deps.workshop : isMainThread
        ? craftIncome(state, { hourAdena: base.hourAdena, worth: price, timestamp }) : keptWorkshop(held, mask, state);
    context.workshop = workshop || { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
    const productive = workshop?.known !== false && workshop?.incomePerHour > 0 && Number.isFinite(workshop.incomePerHour)
        && workshop.cycleHours > 0 && Number.isFinite(workshop.cycleHours);
    if (productive) { watch(workshop.productId); context.hourAdena = Math.max(context.hourAdena, workshop.incomePerHour); }
    context.routeKey = Trip.key(state); context.routeRows = fullRoute(deps.routeRows) ? deps.routeRows : null;
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
            moneyPrice: positive(state.stats?.money?.[1]), hourAdena: context.hourAdena, available: 0,
            decisionSeq: state.stats?.decisionSeq || 0, activityLeaf: state.stats?.activityLeaf || 0 };
        context.moneyPrice = context.network.moneyPrice; context.gapHorizonHours = 0;
        context.watchList = []; context.intentPending = true;
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        context.statsPacket = { wishFocus: context.network.focus, dormantWishes: context.network.dormant,
            decisionSeq: context.network.decisionSeq, activityLeaf: context.network.activityLeaf,
            money: state.stats?.money || [0, 0, base.survivalReserve, 0], stockTargets: state.stats?.stockTargets || stockTargets(base) };
        endTokens(); readIds = null;
        return view(state, planOf(context, base, { key, tripHour, prices }), deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip });
    }
    // One stock reader for the provider's gear witnesses and the network
    // build; the projection is read lazily once it exists (stock roots).
    context.wallet = Funding.budget(state, deps.buyOrderEscrow);
    const nativeStock = stockReader(state, rootKey => context.projection?.nodes.find(node => node.key === rootKey)?.object?.itemId);
    context.stockFor = (id, rootKey) => quantityInputs.stock(id, rootKey, nativeStock(id, rootKey));
    context.completionKey = Crystallization.completionKey(state, quantityInputs);
    const extra = [...extensions.values()].flatMap(provider => provider(state, context) || []);
    const sourceSections = keptSources ? held.sourceSections : null;
    if (diagnostic) {
        // The mask first: no_memo is a build whose sections kept the walk.
        Diagnostics.count('source_memo', sourceSections ? 'hit' : 'miss', sourceSections ? 'held'
            : !held ? 'no_held' : mask & Sections.COMPUTED.sources ? 'sections' : 'no_memo');
        Diagnostics.count('context', 'caller', deps.caller || 'economy_context');
        Diagnostics.count('context', 'foundation', keptBase ? 'kept' : 'built');
    }
    const projection = Providers.build(state, context, { ...deps, sourceSections, sourceGround: keptGround, nodes: [...(deps.nodes || []), ...extra],
        soloProfiles: incomeRecord?.route?.matchupProfiles });
    context.projection = projection;
    if (productive) projection.moneyPaths.push({ activity: 'crafting', kind: 'production', recipeId: workshop.recipeId,
        object: workshop.productId, incomePerHour: workshop.incomePerHour,
        cycleHours: workshop.cycleHours, repeatable: true });
    const networkKey = key;
    const choiceBands = quantityBands(state, context, projection);
    // Unused free loot is compared with the last decision's own value/error:
    // with no section moved the accepted bag value stays.
    const bagValue = choiceBagValue(state, choiceBands, context.buyback);
    const acceptedSections = state.stats?.wishSections;
    context.choiceBagValue = mask === 0 && choiceBagValueHolds(state, choiceBands, acceptedSections, context.hourAdena, bagValue)
        ? acceptedSections.bagValue : bagValue;
    // An event re-weighs the held focus and step (WishNetwork reconsider): a
    // section that moved (raised, or named by a refusal). A first build or an
    // unproved held build (no section named, mask = every piece) keeps them.
    // By intent not verdictMask: an unproved verdict's sections rebuild, never re-weigh.
    const moved = (Number(state.stats?.wishDirty) || 0) | (Number(deps.eventVerdict?.touchedSections) || 0)
        | (held ? eventVerdict.movedSections : 0);
    const reconsider = moved !== 0;
    const network = engine.build({ actorKey, inputKey: networkKey, ...projection,
        remembered: deps.rememberContext !== false,
        stockFor: context.stockFor,
        completionKey: context.completionKey,
        characterId: state.characterId, decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
        wallet: context.wallet, survivalReserve: base.survivalReserve,
        reconsider,
        // Diagnostics only: the events that re-weigh (network:reconsider), 'quiet' for none.
        reconsiderReasons: !diagnostic ? null : moved ? Sections.sectionNames(moved) : ['quiet'],
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
    context.gapHorizonHours = !urgent ? 0 : urgent.key === 'stock:shots' ? base.stock('shots').targetHours
        : urgent.key === 'stock:potions' ? base.stock('potions').targetHours : projection.horizon;
    Object.assign(context, valueReaders(state, network, projection.values, persona, knowledgeEnabled,
        base.kitCost, () => context.statsPacket.money));
    context.watchList = TradeIntent.project(state, network, projection, id => context.worth(id) ?? price(id),
        BoardRules.BOT_SHOP_LINES + BoardRules.BOT_RECORDS.buy_ad);
    context.intentPending = context.watchList === null;
    context.watchList ||= [];
    context.statsPacket = { wishFocus: network.focus, dormantWishes: network.dormant,
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        money: Funding.packetFor(network, context.hourAdena, base.survivalReserve), stockTargets: stockTargets(base), wishDirty: 0 };
    let cumulative = base.survivalReserve;
    for (const wish of network.queue) { cumulative += cashCharge(wish); budget.watch(cumulative); }
    const watchedWish = network.gap || network.queue.find(wish => wish.key === network.focus?.[0]);
    const watchedItem = Number(watchedWish?.object?.itemId);
    const belief = beliefs.get(watchedItem) || (keptBase && watchedItem > 0 ? beliefFor(watchedItem) : null);
    const moneyError = belief ? knowledgeEnabled
        ? positive(watchedWish.price) * Math.expm1(PriceBelief.sigma(belief)) : 0 : -1;
    // The bot's error on an item's price, as moneyError reads it (0 without
    // price knowledge or without a belief).
    const priceError = id => {
        const known = knowledgeEnabled && (beliefs.get(id) || beliefFor(id));
        return known ? Math.expm1(PriceBelief.sigma(known)) : 0;
    };
    const watchRows = marketWatchRows(network.queue, context.liquidationInputs?.rows || [], sourceBoard,
        // || (TradeIntent.project above keeps ??): a zero-usefulness item's
        // worth is 0, yet its sale is watched at its price.
        Number(state.characterId), price, id => context.worth(id) || price(id), priceError,
        productive ? Recipes.resolveByRecipeId(workshop.recipeId) : null);
    // The build's facts for its baseline: the request's when they were read
    // over this state itself (no held leaf's field activity in between).
    context.statsPacket.wishSections = Sections.snapshot(state, context, cash.result, moneyError, deps.mode,
        { buyOrderEscrow: deps.buyOrderEscrow, budgetBounds: budget.result }, current === state ? facts : requestFacts(state, deps),
        Providers.relationBond(state, deps), watchRows);
    // The baseline fields of a section not in the mask stay those of the
    // accepted decision (carrySectionBaseline); every moved one is fresh.
    // The money fields are always fresh: the weighing that just ran priced
    // its queue against the current wallet (bagValue: choiceBagValue above).
    Sections.carrySectionBaseline(acceptedSections, context.statsPacket.wishSections, mask | Sections.sectionBit('money'));
    building = false; endTokens();

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
    // The build's record carries its cause (tools/timeline): the miss reason,
    // the verdict's first refusal (gate), the mask and the time it took.
    if (diagnostic && Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason,
        phase: 'wish_context', reason: diagnosticReason, inputHash: fnv1a32(networkKey),
        durationMs: Math.round(elapsed * 100) / 100,
        sequence: inputSequence, decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        revision: state.simulation?.revision, wallet: positive(state.adena), escrow: positive(deps.buyOrderEscrow),
        available: network.available, reserve: base.survivalReserve, wishKey: network.focus?.[0],
        gate: eventVerdict.reason || 'valid', mask: Sections.sectionNames(mask).join('+') || 'none',
        heldFocus: held?.plan.network.focus?.[0], freshFocus: network.focus?.[0],
        heldLeaf: held?.plan.network.activity?.key, freshLeaf: network.activity?.key });
    const plan = planOf(context, base, { key, tripHour, projection, knowledgeEnabled, prices });
    plan.quantityBands = choiceBands;
    // Source memo and ground verdict belong only to the held build entry
    // (bounded by RETAIN_LIMIT, each memo by WishProviders' cap, each ground
    // by 2 bits per planning spot). A planning view or a group closure must
    // never retain a second copy.
    const retainedSourceMemo = projection.sourceSections, retainedGround = projection.sourceGround;
    projection.sourceSections = projection.sourceGround = null;
    if (deps.rememberContext !== false) {
        if (diagnostic && !cache.has(actorKey) && cache.size >= RETAIN_LIMIT) Diagnostics.count('context', 'eviction', 'capacity');
        // The main thread keeps the graph nodes as before (its group solve
        // reads them on a hit); the worker keeps a party member's too (its
        // party goal query reads them on a hit), a solo bot's plan only
        // (perf C1).
        // Its own activity: the later reuse verdict reads the held build
        // with it.
        plan.eventProof = captureEventProof(state, deps, { plan });
        // What the card stamps on its leaf, read once for the held verdict: the
        // own item's bag+incoming at the decision (heldAtDecision) and a
        // craft's reserved inputs (craftReservations).
        const leaf = plan.network?.activity, own = ColdEconomyDecision.ownItem(leaf);
        remember(cache, actorKey, { key,
            heldUnits: own === null ? undefined : ColdEconomyDecision.heldFor(state, own),
            craftReservations: leaf?.activity === 'crafting' ? CraftInputReservations.heldCraftRows(state, plan.network.craftNeeds) : undefined,
            readIds: Int32Array.from(readIds), plan, stateRef: new WeakRef(state), gearThreat,
            activity: state.activity,
            sourceSections: retainedSourceMemo, sourceGround: retainedGround, mp: Number(state.vitals?.mp),
            projection: (isMainThread || Sections.partyIdOf(state)) ? projection : null }, RETAIN_LIMIT);
    }
    readIds = null;
    const built = view(state, plan, deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip, projection });
    // The sections this build saw moved (worker-local, never posted): the
    // worker drops the kept route when they hit COMPUTED.route. A served held
    // build and a card view carry none: they hold only with nothing moved.
    built.mask = mask;
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
const NODE_FIELDS = ['kind', 'sourceType', 'quoted', 'executable', 'recipeId', 'missingAmount', 'improvement', 'unseal', 'batches',
    'unitPrice', 'town', 'availableUnits'];
const NO_REQUIREMENTS = Object.freeze([]);
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
            loc: plan.workshop.loc, townName: plan.workshop.townName };
        seen.set(plan, out);
        if (plan.grossRequirements) out.grossRequirements = plan.grossRequirements.map(row => ({ key: row.key,
            amount: row.amount, ...(row.once ? { once: true } : {}) }));
        if (plan.intentionPath !== undefined) out.intentionPath = trim(plan.intentionPath);
        if (plan.execution) out.execution = { ...trim(plan.execution), availableUnits: plan.execution.availableUnits };
        if (plan.requirements) out.requirements = !plan.requirements.length ? NO_REQUIREMENTS : plan.requirements.map(row => {
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
    const row = wish => ({ key: wish.key, need: wish.need, object: wish.object, price: wish.price, reserved: wish.reserved,
        valueHours: wish.valueHours, ratio: wish.ratio, funded: wish.funded,
        supported: wish.supported, resolved: wish.resolved, progressionPriority: wish.progressionPriority,
        plan: trim(wish.plan) });
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
        ...(craftNeeds.length ? { craftNeeds } : {}) };
}
// The build's prices of what the plan's own numbers were made from (the
// kit, the queue, the watch list): a later view starts from them, so its
// stock rows and kit costs agree with the plan's reserve and money packet.
// Other items are priced by the view (~8 of ~140 prices per bot are kept).
function planPrices(prices, kit, context) {
    const ids = [736, kit.shots.itemId, kit.potions.itemId,
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
        riskWeight: context.riskWeight, bestSpotId: context.bestSpotId, deathHours: context.deathHours,
        lostGearHours: context.lostGearHours, karmaHours: context.karmaHours, expectedDeathHours: context.expectedDeathHours,
        survivalReserve: context.survivalReserve, kit: base.kit, hourAdena: context.hourAdena, workshop: context.workshop,
        routeKey: context.routeKey, routeRows: context.routeRows, tripHour,
        network: compactNetwork(context.network), moneyPrice: context.moneyPrice, gapHorizonHours: context.gapHorizonHours,
        watchList: context.watchList, intentPending: context.intentPending, statsPacket: context.statsPacket,
        wallet: context.wallet, horizonHours: context.horizonHours, values: projection?.values, stockRoots, knowledgeEnabled,
        quantityInputs: projection ? context.quantityInputs?.finish() : null, nominationBasis: context.nominationBasis,
        liquidationInputs: context.liquidationInputs,
        prices: planPrices(prices, base.kit, context), gearPlanMemo: undefined };
}
// What a review's stock reader, usefulness, worth and purchase budget read:
// one copy for the build and every later view of its plan.
function stockReader(state, rootItem) {
    const reserved = invoke('GameServer/Bot/AI/PersonalGearProgression').preparedAmounts(state);
    // Production actions cannot consume the collected personal gear kit.
    // Their purchase graph must see that same free stock, or an input trip
    // reaches the seller with no surviving need for its own reserved goods.
    let productionReserved;
    const supply = state.stats?.equipmentPlan?.clanGoal?.clanId && require('./ClanCrystalSupply').requirement(state);
    return (id, rootKey) => ({ owned: supply?.key === rootKey ? require('./ClanCrystalSupply').stock(state, id)
        : rootKey.startsWith('stock:') && rootItem(rootKey) === id
        ? positive(state.inventory?.[id]?.amount) : invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {},
            rootKey.startsWith('resale:') ? productionReserved ||= invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(state) : reserved),
    incoming: positive(state.acceptedIncoming?.[id]) });
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
    const { stock, kitCost } = built.kit || kitReader(plan.kit, price,
        () => plan.kit.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId));
    // Reprice funding against this physical wallet. Reuse of benefit/source
    // calculations is never a retained permission to spend an old balance.
    const funding = moneyQueue(plan.network.queue, Funding.budget(state, deps.buyOrderEscrow),
        plan.survivalReserve, plan.hourAdena > 0 ? 1 / plan.hourAdena : 0);
    const inputKey = plan.key;
    const network = { ...plan.network, inputKey, ...funding };
    const statsPacket = plan.pending ? plan.statsPacket : { ...plan.statsPacket,
        money: Funding.packetFor(network, plan.hourAdena, plan.survivalReserve) };
    const context = { inputKey, actorKey: plan.actorKey, state,
        timestamp: plan.timestamp, gearThreatMask: plan.gearThreatMask, persona: plan.persona, board: built.board, hunt: plan.hunt,
        price, buyback, riskWeight: plan.riskWeight, bestSpotId: plan.bestSpotId,
        deathHours: plan.deathHours, lostGearHours: plan.lostGearHours, karmaHours: plan.karmaHours,
        expectedDeathHours: plan.expectedDeathHours, stock, survivalReserve: plan.survivalReserve, kitCost,
        hourAdena: plan.hourAdena, workshop: plan.workshop, routeKey: plan.routeKey, routeRows: plan.routeRows,
        trip: built.trip || deps.tripCost || Trip.preparedReader(plan.routeRows || [], { hourAdena: plan.tripHour }),
        spotValue: built.spotValue || lazySpotValue(state, plan, deps),
        network, moneyPrice: network.moneyPrice, gapHorizonHours: plan.gapHorizonHours, watchList: plan.watchList,
        intentPending: plan.intentPending, statsPacket };
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
    context.stockFor = stockReader(state, rootKey => plan.stockRoots.get(rootKey));
    // A later view of an entry without its nodes (a worker's solo bot) has
    // the usefulness values only; a group solve that needs the members'
    // nodes rebuilds them (forGroup).
    context.projection = built.projection || { values: plan.values };
    context.horizonHours = plan.horizonHours;
    Object.assign(context, valueReaders(state, network, plan.values, plan.persona, plan.knowledgeEnabled,
        kitCost, () => context.statsPacket.money));
    return context;
}
// The plan's own potion and shot targets, published with its money packet
// (L72): the sale list keeps what the plan decided under spot occupancy
// instead of a second earning-spot search. A changed potion or shot item
// (level, weapon) has no published target yet and reads the foundation; so
// do shots risen since the build: without restock their target is capped by
// the stock owned then (the sale list keeps at most what is owned, so a
// fall needs no fresh read).
function stockTargets(base) {
    const potions = base.stock('potions'), shots = base.stock('shots');
    return [potions.itemId, potions.target, shots.itemId, shots.target, shots.current];
}
// The bot's missing shot stack as crafters see it (stats.shotDemand, read by
// MarketDemandIndex and CraftWorkshopService): null when the stock rule wants
// none or has no shot row (a bot without shots), the previous row (its age
// kept) while item, amount and cap hold. The far step's output (ColdSimulationWorker planLifecycle), over the step's own
// economy and its money packet. Escrow 0 and worth ?? price, as the
// main-thread review read them: a worth of 0 (an item off the bot's wish
// card) caps the spend at 0, only no worth falls back to the price.
// Only the activities the main-thread review posted for; any other step
// keeps the previous row as it is.
const SHOT_DEMAND_ACTIVITIES = ['hunting', 'resting', 'shopping', 'grouped'];
function shotDemand(economy, state, timestamp, previous = null) {
    if (!SHOT_DEMAND_ACTIVITIES.includes(state.activity)) return previous;
    const stock = economy.stock('shots');
    if (!stock?.needed) return null;
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
function keptTargets(state = {}, deps = {}) {
    const row = state.stats?.stockTargets, ShotStock = invoke('GameServer/Inventory/ShotStock'), plan = ShotStock.planForState(state);
    const beginnerCurrent = ShotStock.beginnerAmount(state, plan);
    if (Array.isArray(row) && row.length === 5 && row[0] === invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId
        && row[2] === plan.selfId && positive(state.inventory?.[plan.selfId]?.amount) + beginnerCurrent <= row[4])
        return { potions: row[1], shots: { itemId: row[2], target: row[3], beginnerCurrent } };
    const base = basics(state, deps);
    return { potions: base.stock('potions').target, shots: base.stock('shots') };
}
function survivalReserve(state = {}) {
    return Array.isArray(state.stats?.money) ? positive(state.stats.money[2]) : basics(state).survivalReserve;
}
function craftIncome(state) {
    // The guarded worker publication is the only production income reader on
    // main. A missing result leaves the independently supported hunt baseline.
    if (isMainThread) {
        const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
        return coordinator.economyDecisions?.workshopFor?.(state)
            || { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
    }
    return { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
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
    // or focus move (a watched market crossing moves the sequence).
    const key = [wallet, ...contexts.map(({ inputKey, statsPacket: packet }) =>
        `${inputKey}:${packet?.decisionSeq}:${packet?.activityLeaf}:${packet?.wishFocus?.[0]}`)].join('|');
    const held = proposal ? null : groups.get(actorKey);
    if (held?.key === key) {
        if (diagnostic) Diagnostics.count('context_group', 'hit', 'same_members');
        return remember(groups, actorKey, held, GROUP_LIMIT).context;
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
        if (diagnostic && !groups.has(actorKey) && groups.size >= GROUP_LIMIT)
            Diagnostics.count('context_group', 'eviction', 'capacity');
        remember(groups, actorKey, { key, ids: contexts.map(member => Number(member.state.characterId)), context }, GROUP_LIMIT);
    }
    return context;
}
// The held build's workshop (the occupation planner's answer it was built
// with) while none of its sections moved (mask, Sections.COMPUTED.workshop),
// on the same route and known; else null: the caller asks again.
function heldWorkshopOf(held, mask, state) {
    const workshop = held?.plan.workshop;
    return workshop && !(Number(mask) & Sections.COMPUTED.workshop) && held.plan.routeKey === Trip.key(state)
        && workshop.known !== false && Number.isFinite(workshop.incomePerHour) ? workshop : null;
}
// A crafter's build that keeps no known workshop. Counts crafters only: a
// bot without workshop entries has no workshop to know.
function countUnknownWorkshop(state) {
    if (Diagnostics.active() && state.stats?.workshop?.entries?.length) Diagnostics.count('occupation', 'workshop', 'unknown');
}
// A worker build given no workshop (forState: a reader that builds without
// the step's workshop, e.g. a stock check): the held one, else an unknown
// one, which the step's next build does not keep (heldWorkshop: it asks).
function keptWorkshop(held, mask, state) {
    const workshop = heldWorkshopOf(held, mask, state);
    if (workshop) return workshop;
    countUnknownWorkshop(state);
    return ColdEconomyDecision.unknownWorkshop();
}
// The worker's decision point (planLifecycle), before its build on the same
// state: the verdict on the held build is computed here (heldVerdictFor) and
// handed to that build (eventVerdict, the step's: `collected`, handedVerdict);
// the route rows it judged are written back on the step's deps, which the
// build spreads. The held workshop (heldWorkshopOf) under the mask the build
// will take (none for a valid verdict, which serves the held build), or null:
// ask the occupation planner. A valid verdict is handed to the build either
// way: the ask only renews the card's workshop. No held proof: null,
// nothing judged.
function heldWorkshop(state, deps, eventVerdict) {
    const held = cache.get(actorKeyOf(state, deps));
    if (!held?.plan.eventProof) return null;
    const own = resolved(state, { ...deps, eventVerdict });
    const { reads, verdict } = heldVerdictFor(state, own);
    deps.routeRows = own.routeRows;
    eventVerdict.collected = collectedOf(verdict, state, held.plan.eventProof, heldOptionsOf(held), own, reads);
    const kept = heldWorkshopOf(held, verdict.valid ? 0 : verdictMask(state, eventVerdict, verdict), state);
    // The ask awaits the planner, and memory or recipe rows may land before
    // the build: its reads (the build key among them) are taken fresh then.
    if (!kept) eventVerdict.collected.reads = null;
    if (Diagnostics.active()) {
        if (kept) Diagnostics.count('workshop', 'kept', verdict.valid ? 'held_valid' : 'lifecycle');
        // The served held build keeps an unknown or another route's workshop.
        else if (verdict.valid) countUnknownWorkshop(state);
    }
    return kept;
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
    invoke('GameServer/Bot/Population/ColdCombatProfile').forgetBuild(id);
}
function reset() {
    if (Diagnostics.active() && cache.size) Diagnostics.count('context', 'eviction', 'reset', cache.size);
    if (Diagnostics.active() && groups.size) Diagnostics.count('context_group', 'eviction', 'reset', groups.size);
    cache.clear(); groups.clear(); engine.clear(); routeAnchors = new WeakMap();
}
function size() { return { context: cache.size, engine: engine.cache.size, groups: groups.size }; }

module.exports = { FIELD_ACTIVITIES, captureEventProof, heldBuildVerdict, eventProofHolds, restartEventProof, receiveEventProof, restoreEventProof, wireEventProof, size, forState, forGroup, forgetGroup, basics, stockFor, keptTargets, shotDemand, stateForActor, preparedRouteRows, heldWorkshop, heldWorkshopOf, keptWorkshop, RETAIN_LIMIT, leafCheck, survivalReserve, forgetContext, forget, reset, configure, registerProvider,
    craftIncome };
