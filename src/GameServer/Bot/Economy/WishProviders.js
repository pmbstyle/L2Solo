'use strict';

const { trait, stageHours, decisionHorizon, resale, liveDeathHours } = require('./EconomicValuation');
const { SELL } = require('../../AfkTrade/BoardIndex');
const Sources = require('../../Items/ItemAcquisitionCatalog');
const Diagnostics = require('./EconomyDiagnostics');
const Funding = require('./PurchaseFunding');
const Equipment = require('../AI/BotEquipmentCompatibility');
const Network = require('./WishNetwork');
const Progression = require('../AI/PersonalGearProgression');
const SoulCrystals = require('../../Items/SoulCrystalProgression');
const DualSwords = require('../../Items/C4DualSwordCombinations');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const DataCache = invoke('GameServer/DataCache');
const { GRADES: GEAR_RANKS } = invoke('GameServer/Bot/AI/GearGradeRule');
// A module read inside a hot function: require() walks the module path on
// every call, so each path is resolved once here. The relative require keeps
// the module's dependency boundary (tests pass their own require).
const needed = new Map();
function need(path) {
    let module = needed.get(path);
    if (!module) needed.set(path, module = require(path));
    return module;
}

// Compatibility is game data shared by class/role, not an actor's prescribed
// purchase. Keep every item (including SA and set parts) in this immutable view.
// Only a review's finalists are bounded; prices, holdings and funding are live.
const GEAR_FINALISTS_PER_SLOT = 8;
// A wish review keeps at most WISH_ROOTS roots (plan E92: 12 roots/40 nodes/
// depth 4). Producer candidates priced in detail share that bound: at most
// three producer roots are nominated, and pricing more candidates than a
// review can hold as roots adds cost without a reachable choice.
const WISH_ROOTS = 12;
const PRODUCER_PRICED = WISH_ROOTS;
// MVP-6 (PLAN "Admission and placement"): four gear roots, four admission
// rounds (the initial evaluation plus three affected re-evaluations).
const GEAR_ROOTS = 4;
const GEAR_ROUNDS = 4;
const SOLVER_LIMITS = new Set(['missing_wish_requirement', 'cyclic_wish_network', 'invalid_wish_node', 'wish_network_depth']);
function nominationBasis(state) {
    const focus = String(state.stats?.wishFocus?.[0] || '').match(/^power:(\d+):/);
    const supply = state.stats?.equipmentPlan?.clanGoal?.clanId && need('./ClanCrystalSupply').requirement(state);
    return Object.freeze([Number(state.stats?.equipmentPlan?.target?.selfId || 0), Number(focus?.[1] || 0),
        ...(supply ? [supply.plan.clanGoal.goalKey, supply.selfId, supply.amount] : [])]);
}
function gearCandidates(state, ctx = null, wornFor = wornReader(state), acquisitionAllowed = null, progression = null, exchanges = null) {
    const Data = invoke('GameServer/DataCache');
    const revision = Sources.revision();
    const role = Planner.roleFor(state);
    const classId = Number(state.stats?.classId || state.classId || 0);
    const kits = invoke('GameServer/Bot/AI/BotGear').wishKitsFor(Data.items, revision, classId, role, Planner, Sources);
    const maxRank = GEAR_RANKS.indexOf(ctx && progression?.rank === 3
        ? Planner.gradeForLevel(state.level) : Progression.acquisitionRankFor(state, progression || undefined));
    const result = new Map();
    const budget = Math.max(0, Number(ctx?.wallet ?? Funding.budget(state)) - Number(ctx?.survivalReserve || 0));
    const [target, held] = ctx?.nominationBasis || nominationBasis(state);
    const slotKits = new Map(kits);
    for (const [first, second] of [[1, 2], [4, 5]]) if (slotKits.has(first) && !slotKits.has(second)) slotKits.set(second, slotKits.get(first));
    for (const [slot, kit] of slotKits) {
        const allowed = [];
        for (let at = 0; at < kit.length; at++) if (kit.rankAt(at) <= maxRank) allowed.push(at);
        // The exported game-data view is also used to construct fixed kits;
        // it has no actor choice or expensive build evaluation.
        if (!ctx) { result.set(slot, allowed.map(at => kit.itemAt(at))); continue; }
        const current = replacementWorn(wornFor, slot);
        const owned = current && Data.items && need('../../Item/ItemTemplateIndex').find(Data.items, current.selfId);
        const before = owned ? Planner.itemScore(owned, role, classId) : 0;
        const efficientByRank = new Map();
        let affordable = null, above = null, retained = null, exchangeEfficient = null, exchangeStrong = null;
        const cheaper = (a, b) => !b || a.price < b.price || a.price === b.price && a.item.selfId < b.item.selfId;
        const better = (a, b) => !b || a.ratio > b.ratio || a.ratio === b.ratio && cheaper(a, b);
        for (const at of allowed) {
            const item = kit.itemAt(at);
            if (progression?.required && !Progression.priority(item, slot, progression)) continue;
            if (acquisitionAllowed && !acquisitionAllowed(item.selfId)) continue;
            const price = Number(ctx.price(item.selfId));
            if (!(price > 0) || Number(current?.selfId) === Number(item.selfId)) continue;
            ctx.budgetBoundary?.(price + Number(ctx.survivalReserve || 0));
            const score = kit.scoreAt(at);
            const row = { item, price, score, ratio: Math.max(0, score - before) / price };
            if (Number(item.selfId) === target || Number(item.selfId) === held) retained = row;
            // A proxy can nominate a same-score SA/set alternative, but cannot
            // declare its true build benefit; gearGain does that below.
            if (score < before) continue;
            if (exchanges?.has(Number(item.selfId))) {
                if (better(row, exchangeEfficient)) exchangeEfficient = row;
                if (!exchangeStrong || score > exchangeStrong.score || score === exchangeStrong.score && cheaper(row, exchangeStrong)) exchangeStrong = row;
            }
            const rank = String(item.etc?.rank || 'none');
            if (better(row, efficientByRank.get(rank))) efficientByRank.set(rank, row);
            if (price <= budget && (!affordable || score > affordable.score
                || score === affordable.score && cheaper(row, affordable))) affordable = row;
            if (price > budget && cheaper(row, above)) above = row;
        }
        const selected = new Map();
        // A price-efficient representative of every usable rank keeps intermediate
        // purchases in the comparison, even when the wallet covers a higher one.
        // Rank nominates alternatives, never a required next purchase.
        for (const row of [retained, ...efficientByRank.values(), affordable, above, exchangeEfficient, exchangeStrong]) if (row) selected.set(Number(row.item.selfId), row.item);
        // E303: the finalists cap of 8, per slot per review.
        if (Diagnostics.active()) {
            Diagnostics.count('cap', 'gear_finalists', 'check');
            if (selected.size > GEAR_FINALISTS_PER_SLOT) {
                Diagnostics.count('cap', 'gear_finalists', 'cut');
                Diagnostics.count('cap', 'gear_finalists', 'dropped', selected.size - GEAR_FINALISTS_PER_SLOT);
            }
        }
        result.set(slot, [...selected.values()].slice(0, GEAR_FINALISTS_PER_SLOT));
    }
    return result;
}
function rows(state) { return Object.values(state.inventory || {}); }
// The remembered people the review reads: the first friend (trust) and the
// first enemy (hostility) of the bot's memory, else of its saved relations.
function relationTargets(state, deps = {}) {
    const relations = deps.memory?.relations || state.stats?.relations || [];
    return { friend: relations.find(row => Number(row.trust ?? row.affinity ?? 0) > 0) || null,
        enemy: relations.find(row => Number(row.hostility ?? row.anger ?? 0) > 0) || null };
}
// Those targets' magnitudes, the friend's trust and the enemy's hostility,
// rounded (the observation baseline holds a few bytes); null without either.
// Which person they are is the relations fact's (DecisionSections.relationTargetIds); how much is soft.
function relationBond(state, deps = {}) {
    const { friend, enemy } = relationTargets(state, deps);
    if (!friend && !enemy) return null;
    const round = value => Math.round(Number(value || 0) * 1000) / 1000;
    return [round(friend?.trust ?? friend?.affinity), round(enemy?.hostility ?? enemy?.anger)];
}
// Direct provider questions use their original owner semantics. Allocation
// stock has a separate root-specific reader (and different reservations).
function quantityReaders(state) {
    let crystalFree;
    return {
        physical: id => Math.max(0, Number(state.inventory?.[id]?.amount) || 0),
        incoming: id => Number(state.acceptedIncoming?.[id] || 0),
        free: id => need('./WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {}),
        crystalFree: id => (crystalFree ||= need('./BotCrystallization').freeReader(state))(id)
    };
}
// The prepared native book is authority, including an empty learned book.
// Workshop entries are a capped public offer, not the complete recipe book.
function recipeIds(state, deps = {}) {
    const book = Array.isArray(deps.knownRecipes) ? deps.knownRecipes
        : [...(state.stats?.recipes || state.recipes || []), ...(state.stats?.workshop?.entries || [])];
    return [...new Set(book.map(entry => Number(entry?.recipeId ?? entry)))]
        .filter(id => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
}
function worn(state, slot, inventoryRows = rows(state)) {
    return inventoryRows.find(row => (row.equipped || row.equippedCount > 0)
        && (row.equippedSlots?.length ? row.equippedSlots.includes(slot) : Number(row.slot) === slot)) || null;
}
// This reader belongs to one synchronous review, never to a saved owner.
// Keep the native first-row and equippedSlots rules, including jewellery sides.
function wornReader(state) {
    let inventoryRows;
    const slots = new Map();
    return slot => {
        if (!slots.has(slot)) slots.set(slot, worn(state, slot, inventoryRows ||= rows(state)));
        return slots.get(slot);
    };
}
function replacementWorn(wornFor, slot) {
    return Equipment.isWeaponSlot(slot) ? wornFor(7) || wornFor(14) : wornFor(slot);
}
// What wearing `item` in its slot adds to the bot: its kit profile against
// the numbers with the item worn (ColdCombatProfile.candidateProfiles).
function gearGain(state, item, timestamp = Date.now(), threatMask = 3) {
    return gearGainReader(state, timestamp, {}, undefined, threatMask)(item);
}
// options: the kit profile slot (candidateProfiles; preparation: the future state).
function gearGainReader(state, timestamp, options = {}, caster = require('./BotImprovementPolicy').isCaster(state), threatMask = 3) {
    threatMask = threatMask === 1 ? 1 : 3;
    let candidates, ownWeapon;
    const role = Planner.roleFor(state), classId = Number(state.stats?.classId || state.classId || 0);
    const selectedWeapon = item => {
        if (!Planner.equipmentCandidate(item, state, role)) return false;
        if (ownWeapon === undefined) {
            ownWeapon = null;
            const Data = invoke('GameServer/DataCache');
            const Index = need('../../Item/ItemTemplateIndex');
            // The same native comparison, once per review, includes weapons
            // received but not yet reconciled. Known material slots need no lookup.
            for (const [key, row] of Object.entries(state.inventory || {})) {
                if (!(Number(row.amount) > 0) || Number(row.slot) > 0 && !Equipment.isWeaponSlot(row.slot)) continue;
                const owned = Index.find(Data.items, row.selfId);
                if (Equipment.isWeaponSlot(owned?.etc?.slot) && Planner.equipmentCandidate(owned, state, role)
                    && Planner.equipmentItemBetter(owned, ownWeapon?.item, role, classId)) ownWeapon = { key, item: owned };
            }
        }
        if (!ownWeapon || Planner.equipmentItemBetter(item, ownWeapon.item, role, classId)) return true;
        // Native receipt keys are integer template ids: an equally scored,
        // equally priced newly inserted lower key is encountered first.
        return Number(item.selfId) < Number(ownWeapon.key)
            && !Planner.equipmentItemBetter(ownWeapon.item, item, role, classId);
    };
    return (item, targetSlot = Number(item.etc.slot)) => {
        const slot = targetSlot;
        if (Equipment.isWeaponSlot(slot) && !selectedWeapon(item)) return { attack: 0, defence: 0 };
        candidates ||= Profile.candidateProfiles(state, timestamp, options);
        // The item at enchant 0 in its slot; what it replaces comes off (a
        // weapon both hands, a two-handed one the shield, a jewel its side).
        const before = candidates.before, after = candidates.after({ free: worn => Equipment.equipmentReplacementConflict(slot, worn),
            wear: { selfId: Number(item.selfId), enchant: 0, slot } });
        const attack = caster ? 'mAtk' : 'pAtk';
        const attackGain = Math.max(0, Number(after[attack]) / Math.max(1, Number(before[attack])) - 1);
        const defenceGain = Math.max(0, 1 - Number(before.pDef) / Math.max(1, Number(after.pDef)));
        const magicGain = Math.max(0, 1 - Number(before.mDef) / Math.max(1, Number(after.mDef)));
        return { attack: attackGain, defence: threatMask === 1 ? defenceGain : Math.max(defenceGain, magicGain) };
    };
}
// Damage per second in a 60-second rotation: each skill's reuse limits its
// casts; attacks fill time left over. A second nuke adds its own casts.
function rotationRate(autoRate, casts, window = 60) {
    let left = window, total = 0;
    const ordered = [...casts].sort((a, b) => b.damage / b.castSeconds - a.damage / a.castSeconds || a.skillId - b.skillId);
    for (const skill of ordered) {
        const count = Math.min(Math.floor(left / skill.castSeconds), Math.ceil(window / skill.periodSeconds));
        total += count * skill.damage;
        left -= count * skill.castSeconds;
    }
    return (total + autoRate * left) / window;
}
function attackRate(profile) {
    const Formulas = invoke('GameServer/Formulas');
    const autoRate = Formulas.calcPhysicalDamage(profile.pAtk, 0, profile.pDef, 0, { rng: () => 0.5 })
        * profile.atkSpd / 1000;
    const casts = Profile.offensiveSkills(profile).map(skill => {
        const damage = skill.spell ? Formulas.calcMagicDamage(profile.mAtk, Math.max(1, skill.power), profile.mDef)
            : Formulas.calcPhysicalDamage(profile.pAtk, 0, profile.pDef, skill.power, { rng: () => 0.5 });
        const castSeconds = Math.max(0.1, Number(skill.hitTime ?? 1000) / 1000
            * (skill.spell ? 333 / Math.max(1, profile.castSpd) : 1));
        return { skillId: Number(skill.selfId), damage, castSeconds,
            periodSeconds: castSeconds + Math.max(0, Number(skill.reuse || 0)) / 1000 };
    });
    return rotationRate(autoRate, casts);
}
// What learning a skill book's skill adds to the bot's 60-second rotation.
function skillGain(state, book, timestamp = Date.now()) {
    const { before, after: numbersAfter } = Profile.candidateProfiles(state, timestamp);
    const after = numbersAfter({ skill: { selfId: book.skillId, level: book.level } });
    return { attack: Math.max(0, attackRate(after) / Math.max(0.001, attackRate(before)) - 1),
        defence: Math.max(0, 1 - before.pDef / after.pDef, 1 - before.mDef / after.mDef) };
}
// A review judges the bot against every drop source of every candidate: its
// combat readiness is computed once for the review (the planner's scope).
function build(state, ctx, deps = {}) {
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('provider', 'request');
    const started = diagnostic ? performance.now() : 0;
    const result = Planner.withReadiness(() => buildProjection(state, ctx, deps));
    if (diagnostic) {
        Diagnostics.count('provider', 'build', 'context_miss');
        Diagnostics.duration('provider', performance.now() - started);
    }
    return result;
}
function buildProjection(state, ctx, deps) {
    // Diagnostics only: wall time per block (provider:<block>); a lazy source
    // closure counts in the block that calls it. Null while diagnostics are off.
    const blocks = Diagnostics.laps('provider:');
    const nativeQuantities = quantityReaders(state), quantityInputs = ctx.quantityInputs;
    const physical = id => {
        const value = nativeQuantities.physical(id);
        quantityInputs?.physical(id, value); return value;
    };
    const present = id => {
        const value = nativeQuantities.physical(id);
        quantityInputs?.present(id, value); return value > 0;
    };
    const free = id => {
        const value = nativeQuantities.free(id);
        quantityInputs?.free(id, value); return value;
    };
    const hasFree = id => {
        const value = nativeQuantities.free(id);
        quantityInputs?.freePresent(id, value); return value > 0;
    };
    const incoming = id => {
        const value = nativeQuantities.incoming(id);
        quantityInputs?.incoming(id, value); return value;
    };
    const timestamp = ctx.timestamp ?? Date.now();
    const magic = need('./BotImprovementPolicy').isCaster(state);
    const Recipes = invoke('GameServer/Items/C4RecipeItems'), Profit = need('./CraftProfitPolicy');
    // `nodes` is the current target: the real projection, or one gear
    // candidate's scratch arena while it is evaluated (MVP-6).
    // `nodeKeys` holds the keys of `nodes` (the same target), so a membership
    // test is one lookup instead of a scan; `add` is the only writer of both.
    let nodes = [], nodeKeys = new Set(), scratch = false;
    const roots = [], values = new Map();
    const add = node => { if (nodes.length >= 64 || nodeKeys.has(node.key)) return false;
        nodes.push(node); nodeKeys.add(node.key); return true; };
    // One descriptor per item key in this build, shared by the scratch
    // arenas and the real graph, so a witness and its expanded root read
    // identical nodes. ARCH-NOTE: dies at return; at most the 64-node cap
    // per target, no owner store.
    // Sources are plain descriptors, independent of the wallet-dependent
    // arena admission below. Only the previous final cut (<=40 nodes) is
    // kept, in EconomyContext's held build entry while no source section is
    // raised. A missing/evicted descriptor is calculated normally; this never
    // limits alternatives.
    const keptSources = (deps.sourceSections?.nodes || []).filter(row => (!quantityInputs
        || !(row.inputs.bag || []).some(([id]) => id === -1)) && ctx.nodeInputs?.holds(row.inputs));
    const descriptors = new Map(keptSources.map(row => [row.node.key, row.node]));
    const descriptorInputs = new Map(keptSources.map(row => [row.node.key, row.inputs]));
    // The read scope of the candidate whose arena built each descriptor;
    // only scopes with a descriptor in the final cut become inputs.
    const builtBy = new Map();
    let readScope = null;
    const include = key => {
        if (nodeKeys.has(key)) return;
        const node = descriptors.get(key);
        if (!node) return;
        for (const path of node.paths || []) {
            for (const row of path.requirements || []) include(row.key);
            for (const row of path.grossRequirements || []) include(row.key);
        }
        add(node);
    };
    const root = node => {
        if (node.object?.itemId && !Sources.hasSource(node.object.itemId)) return;
        if (add(node)) roots.push(node.key);
    };
    const positive = value => Math.max(0, Number(value) || 0);
    const price = id => ctx.price(id);
    const horizon = decisionHorizon(state, ctx);
    const cProgression = Progression.assess(state);
    const progression = Progression.acquisitionAssessment ? Progression.acquisitionAssessment(state, cProgression) : cProgression;
    const preparation = Progression.preparation(state, cProgression);
    const futureHorizon = preparation ? stageHours(preparation, ctx.hunt.expPerHour, ctx.persona) : 0;
    const clanSupply = state.stats?.equipmentPlan?.clanGoal?.clanId && need('./ClanCrystalSupply').requirement(state);
    const luxury = (clanSupply?.plan?.strategy === 'luxury_exchange'
        || Progression.allowsCGradeAcquisition(state) && (state.level < 52 || cProgression.required) && (state.level >= 40 || preparation))
        ? need('./BotLuxuryExchange').recipes() : null;
    const crystalSupply = clanSupply?.selfId === 1459
        || Number(state.level) >= 52 && !cProgression.required && Progression.adventurer?.(state);
    const luxuryInputs = new Map();
    const powerWeight = (ctx.persona.primaryDrive === 'progression' ? 1 : 0.5) + trait(ctx.persona, 'caution');
    const statusWeight = trait(ctx.persona, 'ambition') * (1 + Number(ctx.persona.primaryDrive === 'wealth'));
    const sourceIndex = deps.spots?.length ? Planner.sourceIndexFor(deps.spots) : null;
    // ARCH-NOTE: PERF: Native repeated source reads fell 7004→1395 / 7229→1408;
    // exact 600 whole preparation mean 2.165→1.985 ms / max 27.369→21.393 ms.
    // Fixed state/time/persona make spotValue pure within this build.
    // This local map dies at return: ~468 KB transient per measured build,
    // zero ArrayBuffers and zero maps retained after return + GC; no owner store.
    const sourceValues = new Map();
    // ARCH-NOTE: PERF: native same-input provider replay (60 builds/variant)
    // 124.56 -> 27.28 ms; nine complete projections byte-equal. Reuse the
    // existing 16,384-entry yield bound and atlas counts, no per-bot retention.
    // Shared-host offline result only; not a live throughput/budget claim.
    const spotValue = spot => {
        if (!sourceValues.has(spot)) sourceValues.set(spot, ctx.spotValue(spot));
        return sourceValues.get(spot);
    };
    // Task 2 readers: one combat profile, spoil eligibility, craft labour and
    // trip map per build, shared by every farm and craft fact; they die at return.
    let combat = null, spoiler;
    const profile = () => combat ??= Profile.profileFor(state, timestamp);
    const Occupation = invoke('GameServer/Bot/Population/ColdOccupationSources');
    let labour = null;
    const craftLabour = () => labour ??= Occupation.craftLabour(state, timestamp, profile);
    const sourceTrips = new Map(), farmFacts = new Map();
    // The bot's ground verdict per spot, kept with its held build while no
    // source section moved (deps.sourceGround, EconomyContext's).
    const sourceGround = Planner.sourceGround(deps.spots || [], deps.sourceGround);
    const routeAllowed = Planner.sourceRouteReader(state, { timestamp, matchupProfiles: deps.soloProfiles, ground: sourceGround });
    const knownRecipes = new Set(recipeIds(state, deps));
    const preparingItems = new Set();
    const purchaseFor = need('./WishPurchaseEvidence').reader(state, ctx, deps);
    const crystalPurchaseFor = luxury || crystalSupply || clanSupply
        ? need('./WishPurchaseEvidence').reader(state, ctx, deps, { npcOnly: true, town: 'Giran' }) : null;
    const purchases = new Map();
    const observedPurchase = id => {
        if (!purchases.has(id)) {
            const item = crystalPurchaseFor && need('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(id));
            const retail = crystalPurchaseFor && need('./BotCrystallization').reward(item) ? crystalPurchaseFor(id) : null;
            purchases.set(id, retail || purchaseFor(id));
        }
        return purchases.get(id);
    };
    let cCrystalChoices;
    const crystalChoices = () => {
        if (cCrystalChoices) return cCrystalChoices;
        const Crystals = need('./BotCrystallization'), exchanges = need('./BotLuxuryExchange').recipes();
        const trip = ctx.trip?.details?.('Giran');
        cCrystalChoices = Crystals.choices(state, id => {
            const exchange = exchanges.get(Number(id));
            return exchange && trip?.known ? { price: exchange.materials[0].amount * price(1458),
                tripFees: trip.fees, tripHours: trip.hours, town: 'Giran', sourceType: 'luxury', availableUnits: Infinity } : null;
        }, trip, ctx.hourAdena, 'c', quantityInputs);
        for (const choice of cCrystalChoices) for (const row of choice.inputs || [{ selfId: choice.selfId }])
            if (exchanges.has(Number(row.selfId))) luxuryInputs.set(Number(row.selfId), exchanges.get(Number(row.selfId)));
        return cCrystalChoices;
    };
    blocks?.lap('build');
    // The farm or spoil path reads GearAcquisitionPlanner.sourceFacts: the
    // hunt rules the bot hunts by (D4-D6), an hour at its net cost (D7). The
    // trip is one row per town in the network, never once per unit.
    const sourcePath = (id, spoilOnly = false) => {
        if (!sourceIndex?.has(Number(id))) return null;
        if (Progression.isCGradeHelmet(need('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(id)))) return null;
        const factsKey = spoilOnly ? `spoil:${id}` : Number(id);
        if (!farmFacts.has(factsKey)) {
            const input = ctx.nodeInputs?.begin();
            try {
            if (spoiler === undefined && sourceIndex.get(Number(id)).some(entry => entry.kind === 'spoil'))
                spoiler = invoke('GameServer/Bot/Population/ColdKillRewards').spoilerFor(state, { skills: Profile.skillsFor(state) }) || false;
            // Only the best ready fact comes back; with diagnostics every record is
            // also counted as ready or by its reason (refusals only as counts).
            const diagnostic = Diagnostics.active(), reasons = diagnostic ? new Map() : null;
            const steps = Planner.sourceFacts(state, id, 1, { spots: deps.spots, spotValue,
                trips: sourceTrips, trip: deps.tripCost || ctx.trip || { details: () => ({ known: false }) }, spoiler, timestamp,
                economicLower: progression.required || !!spoiler, readyOnly: true, counts: reasons, routeAllowed,
                bestForWish: { spoilOnly, progressionRequired: progression.required, hourAdena: ctx.hourAdena } });
            let step;
            do step = steps.next(); while (!step.done);
            const best = step.value[0] || null;
            // One count per reason and item: a per-fact count cost 4% of the worker.
            if (diagnostic) {
                for (const [reason, amount] of reasons) Diagnostics.count('provider', 'source_fact', reason, amount);
                Diagnostics.count('provider', 'source_path', best ? 'ready' : reasons.size ? 'refused' : 'no_source');
            }
            farmFacts.set(factsKey, { best, inputs: input && { items: [...input.items], bag: [...input.bag] } });
            } finally { if (input) ctx.nodeInputs.end(); }
        }
        const { best, inputs } = farmFacts.get(factsKey);
        // A later retained candidate may reuse a fact first read in a rejected
        // arena. Reattach every competing source read, including absent paths.
        if (inputs) ctx.nodeInputs.keep(inputs);
        return best ? { kind: best.kind, activity: 'hunting', costHours: best.hours * best.netHourCost, readyHours: best.hours,
            spotId: best.spotId, npcId: best.npcId, itemId: Number(id), amount: 1,
            ...(best.town ? { town: best.town, tripHours: best.tripHours, tripFees: best.tripFees } : {}) } : null;
    };
    // The craft path reads CraftProfitPolicy.craftFacts, as the producer
    // does: gross inputs only (the network's stock reader subtracts held and
    // incoming units once), native commands and labour hours. Held inputs are
    // valued by the network at their exit value, never here.
    const craftPath = (recipe, id, depth = 0, ownOnly = false) => {
        const dual = recipe?.kind === 'dual_sword_combine';
        const ownCapable = recipe && (dual || invoke('GameServer/Bot/Economy/CraftShopService').canCraft(state, recipe));
        const earlyCustomer = !ownCapable && state.level < 40 && Progression.personal(state) && !preparation;
        // A visible early buyer can order consumables without changing the
        // authored equipment progression or the cold executor's admission.
        if (earlyCustomer && (state.phase !== 'hot'
            || Number(need('../../Item/ItemTemplateIndex').find(DataCache.items, Number(id))?.etc?.slot) > 0)) return null;
        const own = ownCapable ? Profit.craftFacts(recipe, { batches: 1, ...craftLabour() }) : null;
        let workshop = !ownOnly && recipe && deps.workshops ? knownWorkshop(recipe, state, ctx, deps) : null;
        const ownAllowed = Sources.allowsRecipe(recipe);
        if (workshop && ownAllowed && own?.status === 'ready' && knownRecipes.has(Number(recipe.recipeId))
            && own.labourHours * Number(ctx.hourAdena || ctx.hunt?.perHour || 0) <= workshop.cost) workshop = null;
        if (!ownAllowed && !(workshop?.publicStation && Sources.allowsRecipe(recipe, { station: true }))) return null;
        if (recipe && (ownCapable || workshop) && nodes.length + recipe.materials.length < 36) {
            const learned = !!workshop || dual || knownRecipes.has(Number(recipe.recipeId));
            ctx.nodeInputs?.bag(recipe.recipeItemId);
            let scrollAvailable = learned || hasFree(recipe.recipeItemId);
            const scrollBoard = ctx.board || deps.board;
            if (!scrollAvailable && scrollBoard) {
                for (const line of scrollBoard.list(recipe.recipeItemId, 1)) {
                    if (Number(line.ownerId) !== Number(state.characterId) && Number(line.count) > 0 && Number(line.price) > 0) {
                        scrollAvailable = true; break;
                    }
                }
            }
            if (!scrollAvailable) scrollAvailable = Sources.hasNonRaidSource(recipe.recipeItemId);
            if (!scrollAvailable) return null;
            const inputs = workshop?.publicStation ? require('../../Crafting/StationRecipe').forStation(recipe) : recipe;
            const facts = workshop ? Profit.craftFacts(inputs, { batches: 1, executor: 'workshop',
                capacityBatches: workshop.capacityBatches, fee: workshop.price, recipeInput: 0 })
                : Profit.craftFacts(recipe, { batches: 1, ...craftLabour(),
                    recipeInput: learned ? 0 : recipe.recipeItemId });
            if (facts.status !== 'ready') return null;
            // A physical attempt consumes one whole command, including failure.
            // Its chance reduces the finite root benefit once per command;
            // inputs are not divided by expected yield.
            const cycleHours = workshop ? 1 / 3600 : dual ? Number(recipe.costHours || 1 / 3600) : facts.labourHours;
            if (!(cycleHours > 0)) return null;
            const grossRequirements = [];
            for (const [selfId, amount] of facts.gross) {
                const key = itemNode(selfId, depth + 1);
                if (!key) return null;
                grossRequirements.push({ key, amount, ...(facts.once.has(selfId) ? { once: true } : {}) });
            }
            // Equipment recipes put their unique part first after the recipe
            // scroll. Keep the complete input tree for costing and bids, but
            // start acquisition with that part and any required scroll.
            const product = need('../../Item/ItemTemplateIndex').find(DataCache.items, Number(id));
            const part = recipe.type === 'dwarven' && GEAR_RANKS.indexOf(product?.etc?.rank) >= 3
                && Number(product?.etc?.slot) > 0
                ? recipe.materials.find(row => Number(row.selfId) !== Number(recipe.recipeItemId)) : null;
            const partItem = part && need('../../Item/ItemTemplateIndex').find(DataCache.items, Number(part.selfId));
            const keyInputs = partItem?.template?.kind === 'Other.Material'
                ? grossRequirements.filter(row => row.key === `item:${Number(part.selfId)}`
                    || row.key === `item:${Number(recipe.recipeItemId)}`).map(row => row.key) : [];
            return { kind: 'craft', activity: 'crafting', itemId: Number(id), recipeId: recipe.recipeId,
                ...(workshop ? { workshop, price: facts.fee, town: workshop.townName,
                    tripHours: workshop.tripHours, tripFees: workshop.tripFees,
                    executable: workshop.capacityBatches > 0, availableUnits: workshop.capacityBatches * facts.productCount, quoted: true } : {}),
                requiresRecipeLearning: !learned, successProbability: facts.successProbability, perCommand: facts.perCommand,
                costHours: cycleHours, productCount: facts.productCount, grossRequirements,
                ...(keyInputs.length ? { keyInputs } : {}) };
        }
        return null;
    };
    const itemNode = (id, depth = 0) => {
        if (!Sources.hasSource(id)) return null;
        const key = `item:${id}`;
        if (nodeKeys.has(key)) return key;
        if (depth >= (crystalSupply ? 6 : 3) || nodes.length >= 36 || preparingItems.has(key)) return null;
        // A memoized subgraph enters the real graph under the same 36-node
        // cap as a fresh build: its whole missing closure is counted first.
        // A candidate's scratch arena copies it whole, so its witness reads
        // the real graph's descriptors; the arena bound is the evaluation's.
        if (descriptors.has(key)) {
            if (descriptorInputs.has(key)) {
                const inputs = descriptorInputs.get(key);
                ctx.nodeInputs.keep(inputs);
                // Descriptor reuse must not erase the bag dependencies that
                // its original native construction recorded before pruning.
                if (quantityInputs) for (const [inputId] of inputs.bag || []) {
                    if (inputId !== -1) { present(inputId); hasFree(inputId); }
                }
                if (scratch && readScope) builtBy.set(key, readScope);
            }
            const missing = new Set();
            const collect = at => {
                if (missing.has(at) || nodeKeys.has(at) || !descriptors.has(at)) return;
                missing.add(at);
                for (const path of descriptors.get(at).paths || []) {
                    for (const row of path.requirements || []) collect(row.key);
                    for (const row of path.grossRequirements || []) collect(row.key);
                }
            };
            collect(key);
            if (!scratch && nodes.length + missing.size > 36) return null;
            include(key); return key;
        }
        const local = ctx.nodeInputs?.begin();
        try {
        ctx.nodeInputs?.bag(id);
        const observed = observedPurchase(id);
        // A raid origin belongs to the clan's prepared roster. A personal
        // wish needs actual owned stock or a finite supplier, not a price.
        const ordinary = Sources.hasNonRaidSource(id);
        if (!ordinary && !observed && !present(id)) return null;
        preparingItems.add(key);
        if (crystalSupply && Number(id) === 1459) crystalChoices();
        const scrapExchange = luxuryInputs.get(Number(id));
        const marketOnly = Progression.marketOnly?.(state, need('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(id)), progression);
        const paths = [{ kind: 'buy', activity: 'shopping', price: price(id), itemId: Number(id), amount: 1,
            available: !!observed || ordinary && price(id) > 0, executable: !!observed,
            ...(observed || { availableUnits: 0 }) }];
        const drop = !scrapExchange && !marketOnly && sourcePath(id);
        if (drop) paths.push(drop);
        if (SoulCrystals.catalog.crystals[id]) {
            ctx.nodeInputs?.wholeBag();
        }
        const crystal = invoke('GameServer/Bot/Economy/BotImprovementPolicy').crystalPath(state, id, ctx, deps.spots || []);
        if (crystal) paths.push(crystal);
        const recipes = Recipes.resolveVariantsByProductId(id);
        const targetTemplate = need('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(id));
        const unseal = targetTemplate?.etc?.rank === 'b' && [9, 12].includes(Number(targetTemplate.etc.slot))
            ? invoke('GameServer/Items/C4Unseal').forProduct(id) : null;
        if (unseal) {
            const input = itemNode(unseal.sourceId, depth + 1), trip = ctx.trip?.details?.('Giran');
            if (input && trip?.known) paths.push({ kind: 'mammon_unseal', activity: 'crafting',
                itemId: Number(id), unseal: { sourceId: unseal.sourceId, productId: unseal.productId },
                costHours: 1 / 3600, town: 'Giran', quoted: true, tripHours: trip.hours, tripFees: trip.fees,
                grossRequirements: [{ key: input, amount: 1 }] });
        }
        // A dual sword has one combination per product: the owner's index, not a filter per node.
        const combination = recipes.length ? null : DualSwords.resolveByProductId(id);
        const alternatives = recipes.length ? recipes : combination ? [combination] : [];
        for (const recipe of scrapExchange || marketOnly ? [] : alternatives) {
            const craft = craftPath(recipe, id, depth);
            if (craft) paths.push(craft);
        }
        const exchange = scrapExchange || luxury?.get(Number(id));
        if (exchange) {
            const requirements = exchange.materials.map(row => ({ key: itemNode(row.selfId, depth + 1), amount: row.amount }));
            const trip = ctx.trip?.details?.('Giran');
            if (requirements.every(row => row.key) && trip?.known) paths.push({ kind: 'luxury_exchange',
                activity: 'improving', itemId: Number(id), costHours: 1 / 3600,
                town: 'Giran', quoted: true, tripHours: trip.hours, tripFees: trip.fees,
                improvement: { kind: 'luxury_exchange', ...exchange, ...(scrapExchange ? { forCrystals: true } : {}) }, grossRequirements: requirements });
        }
        if ((luxury || crystalSupply || clanSupply) && Number(id) === 1458 || crystalSupply && Number(id) === 1459) {
            ctx.nodeInputs?.wholeBag();
            const Crystals = need('./BotCrystallization'), trip = ctx.trip?.details?.('Giran');
            const rank = Number(id) === 1459 ? 'c' : 'd', self = Crystals.canSelf(state, rank);
            const choices = rank === 'c' ? crystalChoices() : Crystals.choices(state, observedPurchase, trip, ctx.hourAdena, rank, quantityInputs);
            // A funded C kit has an authored unlimited supplier. Preserve
            // that chain instead of forecasting thousands of crystals from
            // one small public lot and repeatedly changing counterparties.
            if (choices.some(choice => choice.sourceType === 'npc')) paths.length = 0;
            for (const choice of choices) {
                const requirements = (choice.inputs || [{ selfId: choice.selfId, amount: 1 }])
                    .map(row => ({ key: itemNode(row.selfId, depth + 1), amount: row.amount }));
                if (requirements.some(row => !row.key)) continue;
                paths.push({ kind: 'crystallize', activity: 'improving', itemId: Number(id),
                    productCount: choice.net, batchLimit: choice.batchLimit,
                    availableUnits: choice.net * choice.batchLimit,
                    costHours: 1 / 3600, quoted: true,
                    ...(self ? {} : { town: 'Giran', tripHours: trip.hours, tripFees: trip.fees }),
                    improvement: { kind: 'crystallize', ...(self ? { mode: 'self' } : { npcId: Crystals.npcId }),
                        ...(choice.inputs ? { items: choice.inputs } : { sourceSelfId: choice.selfId }) },
                    grossRequirements: requirements });
            }
        }
        // Held units are worth what the bot gets selling them now (Q1 A);
        // only an item the bot holds needs that value.
        let exitValue;
        if (present(id)) {
            const steps = Occupation.exitValue(state, id, ctx.board || deps.board);
            let step;
            do step = steps.next(); while (!step.done);
            exitValue = step.value;
        }
        const template = need('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(id));
        if (GEAR_RANKS.indexOf(template?.etc?.rank) >= 3 && Number(template?.etc?.slot) > 0) {
            // A real affordable listing wins while the item is being prepared.
            // An absent or unaffordable listing must not stall the craft.
            for (const path of paths) path.acquisitionOrder = path.kind === 'buy' && observed ? 1
                : ['craft', 'mammon_unseal'].includes(path.kind) ? 2 : path.kind === 'buy' ? 3 : 4;
        }
        const node = { key, object: Number(id), price: price(id), ...(exitValue === undefined ? {} : { exitValue }), paths: paths.slice(0, 4) };
        descriptors.set(key, node);
        if (local) descriptorInputs.set(key, { items: [...local.items], bag: [...local.bag] });
        if (scratch && readScope) builtBy.set(key, readScope);
        add(node);
        preparingItems.delete(key);
        return key;
        } finally { if (local) ctx.nodeInputs.end(); }
    };
    if (clanSupply) {
        const key = itemNode(clanSupply.selfId);
        if (key) root({ key: clanSupply.key, need: 'power',
            object: { itemId: Number(clanSupply.plan.target.selfId), slot: Number(clanSupply.plan.target.slot), clanSupply: true },
            valueHours: Math.max(1, horizon), progressionPriority: 3.5, personalAcquisition: true,
            paths: [{ requirements: [{ key, amount: clanSupply.amount }] }] });
    }
    // A finite earning goal uses the existing resale certificate and input
    // graph. The finished product is output, never a preparatory BUY leaf.
    // Only finalists expand their recipe DAG; public candidates come from the
    // worker's existing item->recipe index, not a per-actor catalogue scan.
    const producerCandidates = function* () {
        for (const id of knownRecipes) yield Recipes.resolveByRecipeId(id);
        for (const row of rows(state)) {
            const amount = need('./WealthCraftDecision').freeAmount(state, row);
            // EC fences bag identities; this native branch depends only on
            // whether its row has any free units, not the positive count.
            if (quantityInputs) {
                if (state.inventory?.[row.selfId] !== row) quantityInputs.unsupported();
                else quantityInputs.freePresent(row.selfId, amount);
            }
            if (amount > 0) yield Recipes.resolve?.(Number(row.selfId));
        }
        yield* deps.producerRecipes || [];
    };
    const production = new Map(), seenProduction = new Set();
    const investment = state.stats?.shotRecipeDemand;
    const investmentId = Number(investment?.at) + 30 * 60 * 1000 > timestamp ? Number(investment.itemId) : 0;
    const productionBatches = recipe => {
        const setup = investmentId === Number(recipe.recipeItemId) ? investment
            : [state.stats?.shotCraft?.preparing, state.stats?.wealthCraft].find(row => row
                && (row === state.stats?.shotCraft?.preparing || row.outcome === 'buying')
                && Number(row.recipeId) === Number(recipe.recipeId) && Number(row.at) + 30 * 60 * 1000 > timestamp);
        const batches = Number(setup?.batches);
        return Number.isSafeInteger(batches) && batches > 0
            ? Math.min(need('./WealthCraftPolicy').MAX_BATCHES, batches) : null;
    };
    const serviceCraft = invoke('GameServer/Bot/Economy/CraftShopService');
    if (ctx.board && ctx.hourAdena > 0 && serviceCraft.isServiceCrafter(state)
        && !state.stats?.craftStationId && !/^bot_craft_\d+$/i.test(String(state.accountName || ''))) {
        // Per-bot constants of the candidate loop: the bot's own plain sell lines
        // are read once and grouped by item, not once per candidate recipe.
        // Plan bound (E92 "Performance, fixed bounds"): preliminary admission
        // reads only the RecipeProductionIndex rows and O(1) facts per recipe;
        // the detailed exit pricing runs for PRODUCER_PRICED finalists only.
        const Price = need('./PriceDecision');
        const ItemTemplates = need('../../Item/ItemTemplateIndex'), Profit = need('./CraftProfitPolicy');
        const items = invoke('GameServer/DataCache').items;
        const ownSalesByItem = new Map();
        for (const line of ctx.board.ownerLines?.(state.characterId) || []) {
            if (line.storeType !== SELL || line.custodyPolicy === 1 || Number(line.enchant || 0)) continue;
            if (!ownSalesByItem.has(line.selfId)) ownSalesByItem.set(line.selfId, []);
            ownSalesByItem.get(line.selfId).push(line);
        }
        // The same offer guard admits a candidate and opens its detailed pricing.
        const usableExit = (offer, ownSales) => Number(offer.ownerId) !== Number(state.characterId) && !Number(offer.enchant || 0)
            && offer.count > 0 && offer.price > 0 && !ownSales.some(line => line.price !== offer.price);
        const exitCeiling = (offers, ownSales, best) => {
            for (let at = 0; at < offers.length && at < 5; at++)
                if (usableExit(offers[at], ownSales) && offers[at].price > best) best = offers[at].price;
            return best;
        };
        // Admission: O(1) per candidate (at most 5 head bids of the indexed
        // sorted list, no copy, no price belief). A candidate without a usable
        // head exit cannot produce, so its removal is exact. The rest rank by
        // the gross ceiling count x max(head bid, NPC residual) x success,
        // the upper bound of the detailed gross; the known book only breaks
        // ties, so known and unknown recipes compete by the same outcome.
        const admitted = [];
        for (const recipe of producerCandidates()) {
            if (!Sources.allowsRecipe(recipe) || seenProduction.has(Number(recipe.recipeId))) continue;
            seenProduction.add(Number(recipe.recipeId));
            if (!serviceCraft.canCraft(state, recipe)) continue;
            const count = Number(recipe.productCount || 1), id = Number(recipe.productId);
            if (!Number.isSafeInteger(count) || count <= 0) continue;
            const stock = free(id);
            const ownSales = ownSalesByItem.get(id) || [];
            const oldUnits = stock + incoming(id) + ownSales.reduce((sum, line) => sum + Number(line.count), 0);
            if (!Number.isSafeInteger(oldUnits) || oldUnits < 0) continue;
            const material = String(ItemTemplates.find(items, id)?.template?.kind || '').startsWith('Other.Material');
            const shot = need('./ShotTradeDemand').isShot(id);
            const publicBids = ctx.board.list(id, 3);
            const fixedBids = material ? deps.fixedProductionOffersFor?.(id) || [] : [];
            let best = exitCeiling(publicBids, ownSales, 0);
            if (material) best = exitCeiling(fixedBids, ownSales, best);
            if (shot && need('./ShotTradeDemand').forecast(id, null, timestamp)) best = Math.max(best, positive(price(id)));
            if (!(best > 0)) continue;
            // A finite setup retains priority through recipe and material
            // purchases. Ordinary shots and materials compete on finite value.
            const earningPreference = shot && productionBatches(recipe) ? 2 : 0;
            const demand = material ? [...publicBids.slice(0, 5), ...fixedBids.slice(0, 5)]
                .reduce((max, offer) => offer.type !== 'static' && usableExit(offer, ownSales)
                    ? Math.max(max, Number(offer.count || 0)) : max, 0) : 0;
            const capacity = Math.max(1, Math.floor(Number(state.vitals?.mp || 0) / Math.max(1, Number(recipe.mpCost || 0))));
            const lots = productionBatches(recipe) || (demand > oldUnits
                ? Math.min(need('./WealthCraftPolicy').MAX_BATCHES, capacity, Math.ceil((demand - oldUnits) / count)) : 1);
            admitted.push({ recipe, count, id, ownSales, oldUnits, material, shot, earningPreference, known: knownRecipes.has(Number(recipe.recipeId)),
                ceiling: positive(count * lots * Math.max(best, positive(ctx.buyback(id))) * Number(recipe.successRate ?? 100) / 100) });
        }
        // E303: the priced producers cap of 12.
        if (Diagnostics.active()) {
            Diagnostics.count('cap', 'producers', 'check');
            if (admitted.length > PRODUCER_PRICED) {
                Diagnostics.count('cap', 'producers', 'cut');
                Diagnostics.count('cap', 'producers', 'dropped', admitted.length - PRODUCER_PRICED);
            }
        }
        if (admitted.length > PRODUCER_PRICED) {
            admitted.sort((a, b) => b.earningPreference - a.earningPreference
                || b.ceiling - a.ceiling || Number(b.known) - Number(a.known) || a.recipe.recipeId - b.recipe.recipeId);
            admitted.length = PRODUCER_PRICED;
        }
        for (const { recipe, count, id, ownSales, oldUnits, material, shot, earningPreference } of admitted) {
        const asks = ctx.board.list(id, SELL);
        const publicOffers = ctx.board.list(id, 3).slice(0, 5);
        const fixedOffers = material ? (deps.fixedProductionOffersFor?.(id) || []).slice(0, 5) : [];
        const listingOffers = shot ? need('./WealthCraftPolicy').drain(need('./ShotSalePolicy').exits(state, recipe, {
            board: ctx.board, timestamp, trip: ctx.trip, npcOffersFor: ctx.npcOffersFor, existing: oldUnits })) : [];
        for (const source of [...publicOffers, ...fixedOffers, ...listingOffers]) {
            const preparedBatches = productionBatches(recipe);
            // Compare a real bounded material lot to a shot lot. A single
            // material unit systematically lost to a 476-shot recipe even
            // when the board needed hundreds of intermediates.
            const demand = source.type === 'static' ? 0 : Math.max(0, Number(source.count || 0) - oldUnits);
            const capacity = Math.max(1, Math.floor(Number(state.vitals?.mp || 0) / Math.max(1, Number(recipe.mpCost || 0))));
            const batches = preparedBatches || (material && demand > 0
                ? Math.min(need('./WealthCraftPolicy').MAX_BATCHES, capacity, Math.ceil(demand / count)) : 1);
            const units = count * batches;
            const offer = source.forQuantity ? source.forQuantity(batches) : source;
            if (!offer) continue;
            if (!usableExit(offer, ownSales)) continue;
            const trip = ctx.trip?.details?.(offer.town);
            if (!trip?.known || ![trip.hours, trip.fees].every(value => Number.isFinite(value) && value >= 0)) continue;
            const sale = offer.type === 'listing' ? (() => {
                const input = { applicableUnits: offer.applicableUnits, willingUnits: offer.willingUnits,
                    cheaperUnits: offer.cheaperUnits, price: offer.price, residualUnitValue: offer.residualUnitValue };
                const before = Price.saleOutcome({ ...input, units: oldUnits });
                const after = Price.saleOutcome({ ...input, units: oldUnits + units });
                return { status: before.known && after.known ? 'ready' : 'unknown', exit: offer,
                    before, after, gross: after.receipts - before.receipts };
            })() : Price.bidSale(state, offer, { board: ctx.board, persona: ctx.persona, timestamp, asks,
                oldUnits, units, residualUnitValue: ctx.buyback(id), fixed: offer.type === 'static' });
            if (sale.status !== 'ready' || sale.exit.trial && !(sale.after.sold > sale.before.sold)) continue;
            const { gross } = sale;
            if (!(gross > 0)) continue;
            const inputPrice = [...(Profit.requirements(recipe) || [])]
                .reduce((sum, [id, amount]) => sum + amount * batches * positive(price(id)), 0);
            const learningPrice = knownRecipes.has(Number(recipe.recipeId)) ? 0 : positive(price(recipe.recipeItemId));
            const proxy = gross * Number(recipe.successRate ?? 100) / 100 - inputPrice - learningPrice;
            // Independent price is a ranking proxy, not acquisition cost:
            // the bounded DAG can expose a cheaper farm/component craft.
            const previous = production.get(id);
            if (!previous || proxy > previous.proxy || proxy === previous.proxy && recipe.recipeId < previous.recipe.recipeId)
                production.set(id, { recipe, batches, gross, proxy, shot, earningPreference, inputPrice: inputPrice + learningPrice, town: offer.town, trip });
        }
        }
    }
    const producerFinalists = [...production.values()].sort((a, b) => b.earningPreference - a.earningPreference
        || b.proxy - a.proxy || a.recipe.recipeId - b.recipe.recipeId).slice(0, 3);
    const produced = new Set();
    for (const row of producerFinalists) {
        const id = Number(row.recipe.productId);
        if (produced.has(id) || produced.size >= 3) continue;
        const path = craftPath(row.recipe, id, 0, true);
        if (!path) continue;
        produced.add(id);
        root({ key: `resale:${id}`, need: 'power', object: { itemId: id,
            amount: Number(row.recipe.productCount || 1) * row.batches, kind: 'resale' },
            primaryEarning: row.earningPreference,
            // Keep the crafter's finite income setup in the same graph as
            // its gear. Otherwise its separate native action can travel to
            // a recipe seller whose meeting has no surviving need certificate.
            progressionPriority: row.shot && progression.required ? 3 : 0,
            progressionFunding: progression.required,
            valueHours: row.gross / ctx.hourAdena, price: row.inputPrice,
            paths: [{ ...path, trial: true, repeatable: false, quoted: true,
                town: row.town, tripHours: row.trip.hours, tripFees: row.trip.fees }] });
    }
    // A spoiler can earn the kit by supplying finite public demand for
    // recipes, parts and resources. No buyer means no speculative spoil goal.
    if (sourceIndex && ctx.board?.itemIds && Progression.personal(state)) {
        if (spoiler === undefined) spoiler = invoke('GameServer/Bot/Population/ColdKillRewards').spoilerFor(state,
            { skills: Profile.skillsFor(state) }) || false;
        if (spoiler && ctx.hourAdena > 0) {
            const demand = [];
            for (const id of ctx.board.itemIds(3)) {
                if (!sourceIndex.get(Number(id))?.some(entry => entry.kind === 'spoil')) continue;
                if (present(id) || nodeKeys.has(`resale:${id}`)) continue;
                const offer = ctx.board.first(id, 3, { excludeOwner: state.characterId, enchant: 0 });
                if (!offer || !(offer.price > ctx.buyback(id))) continue;
                const units = Math.max(1, Math.min(50, Math.floor(offer.count)));
                demand.push({ id, offer, units, ceiling: units * (offer.price - ctx.buyback(id)) });
                demand.sort((a, b) => b.ceiling - a.ceiling || a.id - b.id);
                if (demand.length > 8) demand.pop();
            }
            let admitted = 0;
            for (const { id, offer, units } of demand) {
                if (admitted >= 3) break;
                const trip = ctx.trip?.details?.(offer.town);
                if (!trip?.known) continue;
                const sale = need('./PriceDecision').bidSale(state, offer, { board: ctx.board, persona: ctx.persona,
                    timestamp, asks: ctx.board.list(id, SELL), units, oldUnits: 0, residualUnitValue: ctx.buyback(id) });
                if (sale.status !== 'ready' || !(sale.gross > 0)) continue;
                const source = sourcePath(id, true);
                if (!source || source.kind !== 'spoil') continue;
                const key = `spoil:${id}`;
                if (!add({ key, object: Number(id), price: 0, paths: [source] })) continue;
                root({ key: `resale:${id}`, need: 'power', object: { itemId: Number(id), amount: units, kind: 'resale' },
                    progressionFunding: progression.required,
                    valueHours: Math.max(0, sale.gross - units * ctx.buyback(id)) / ctx.hourAdena,
                    paths: [{ kind: 'spoil_sale', trial: true, repeatable: false, quoted: true,
                        town: offer.town, tripHours: trip.hours, tripFees: trip.fees,
                        requirements: [{ key, amount: units }] }] });
                admitted++;
            }
        }
    }
    // Paid enchant, SA and henna are objects of the same power queue.
    // Missing materials inherit that value; only a genuinely ready leaf applies.
    blocks?.lap('sources');
    for (const improvement of invoke('GameServer/Bot/Economy/BotImprovementPolicy').opportunities(state, ctx)) {
        const materials = improvement.materials.map(material => ({ ...material, missing: Math.max(0,
            material.amount - physical(material.selfId)) }));
        const requirements = materials.filter(material => material.missing > 0)
            .map(material => ({ key: itemNode(material.selfId), amount: material.missing }));
        if (requirements.some(row => !row.key)) continue;
        const ready = !requirements.length && positive(state.adena) >= positive(improvement.fee);
        ctx.walletBoundary?.(positive(improvement.fee));
        root({ key: improvement.key, need: 'power', object: { ...improvement, kind: 'improvement' },
            valueHours: improvement.valueHours, price: improvement.price,
            paths: [{ activity: ready ? 'improving' : null, kind: improvement.kind,
                improvement, price: positive(improvement.fee), costHours: 1 / 3600,
                riskHours: improvement.riskHours || 0, requirements }] });
        for (const material of materials) values.set(material.selfId,
            positive(values.get(material.selfId)) + improvement.valueHours / Math.max(1, material.amount));
    }
    const candidates = [];
    const planningState = preparation || state;
    const acquisitionRank = Progression.acquisitionRankFor(planningState, preparation ? undefined : progression);
    const wornFor = wornReader(planningState), gainFor = gearGainReader(state, timestamp, {}, magic, ctx.gearThreatMask ?? 3);
    let futureGain;
    const acquisitionAllowed = id => {
        const item = need('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, Number(id));
        if (Progression.marketOnly?.(state, item, progression)) {
            const offer = observedPurchase(id);
            if (!offer || !(offer.availableUnits >= 1)) return false;
            // The wallet threshold this answer turns on, as every cash comparison of the build.
            ctx.walletBoundary?.(offer.price + offer.tripFees + positive(ctx.survivalReserve));
            return offer.price + offer.tripFees <= Math.max(0, state.adena - ctx.survivalReserve);
        }
        return Sources.hasNonRaidSource(id) || present(id) || !!observedPurchase(id);
    };
    for (const [slot, items] of gearCandidates(planningState, ctx, wornFor, acquisitionAllowed, progression, luxury)) for (const item of items) {
        if (!Planner.considerable(item, planningState, Planner.roleFor(planningState),
            Progression.marketOnly?.(state, item, progression) && acquisitionAllowed(item.selfId) ? Planner.gradeForLevel(state.level) : acquisitionRank)) continue;
        const current = replacementWorn(wornFor, slot);
        if (Number(current?.selfId) === Number(item.selfId)) continue;
        const early = !!preparation && item.etc?.rank === 'c';
        const gain = early ? (futureGain ||= gearGainReader(preparation, timestamp,
            { preparation: true }, magic, ctx.gearThreatMask ?? 3))(item, slot) : gainFor(item, slot);
        const benefitHorizon = early ? futureHorizon : horizon;
        const currentPrice = current ? price(current.selfId) : 0;
        const market = invoke('GameServer/Bot/Economy/MarketCounters');
        const future = resale(price(item.selfId), { trend: market.moveOf(market.counterOf(item.selfId)),
            hours: benefitHorizon, understanding: ctx.persona.understanding, assertiveness: trait(ctx.persona, 'assertiveness'),
            caution: trait(ctx.persona, 'caution'), nextBuyerUse: price(item.selfId) * Math.min(1, gain.attack + gain.defence),
            npcFloor: ctx.buyback(item.selfId) });
        const value = Math.max(Progression.priority(item, slot, progression) ? 1 : 0, (gain.attack + gain.defence * ctx.deathHours) * benefitHorizon
            + (ctx.hunt.perHour > 0 ? (future - currentPrice) / ctx.hunt.perHour : 0));
        if (!(value > 0) || !(price(item.selfId) > 0)) continue;
        candidates.push({ item, slot, value, gain, notBeforeHours: early ? horizon : 0,
            horizonHours: early ? horizon + futureHorizon : horizon,
            firstWeaponGrade: Equipment.isWeaponSlot(slot) && Progression.gapFor(slot, progression)?.rank === 1
                && Progression.gapFor(slot, progression)?.priority === 3,
            progressionPriority: Progression.priority(item, slot, progression) });
    }
    // MVP-6: every nominated candidate is valued by the same path solver
    // the network uses, over its own scratch arena of item descriptors. A
    // forecast without a supplier no longer screens out a step now: the
    // fundable path wins its family, then benefit per effort.
    blocks?.lap('benefits');
    const admission = { candidates: 0, evaluations: 0, maxScratch: 0, rounds: 0, pending: [], admitted: [] };
    const solverOptions = { hourAdena: ctx.hourAdena, riskWeight: ctx.riskWeight, stockFor: ctx.stockFor || null,
        wallet: ctx.wallet ?? positive(state.adena), survivalReserve: ctx.survivalReserve };
    // A rare piece's status value is part of its gear root from the start,
    // so admission scores the value the network later reads.
    const rare = candidates.find(row => row.item && (ctx.board?.list(row.item.selfId, SELL)?.length || 0) <= 1);
    const real = nodes, realKeys = nodeKeys, gear = [];
    for (const candidate of candidates) {
        nodes = []; nodeKeys = new Set(); scratch = true; readScope = ctx.readScope?.open() || null;
        const key = itemNode(candidate.item.selfId);
        const keys = nodes.map(node => node.key);
        nodes = real; nodeKeys = realKeys; scratch = false; readScope = null; ctx.readScope?.close();
        if (!key) continue;
        const benefitPerHour = (candidate.gain.attack + candidate.gain.defence * ctx.deathHours) * powerWeight;
        gear.push({ candidate, keys, family: Equipment.isWeaponSlot(candidate.slot) ? 'weapon' : candidate.slot,
            node: { key: `power:${candidate.item.selfId}:${candidate.slot}`, need: 'power',
                object: { itemId: Number(candidate.item.selfId), slot: candidate.slot }, price: price(candidate.item.selfId),
                valueHours: Math.max(candidate.progressionPriority ? 1 : 0, candidate.value * powerWeight + (candidate === rare ? rare.value * statusWeight : 0)),
                progressionPriority: candidate.progressionPriority,
                ...(luxury || progression.rank === 3 ? { personalAcquisition: true } : {}),
                ...(candidate.progressionPriority ? {} : { benefitPerHour }),
                notBeforeHours: candidate.notBeforeHours,
                horizonHours: candidate.progressionPriority ? Infinity : candidate.horizonHours,
                paths: [{ requirements: [{ key, amount: 1 }] }] } });
        admission.maxScratch = Math.max(admission.maxScratch, keys.length);
    }
    admission.candidates = gear.length;
    // A throw of the solver's own bounds or an arena over forty descriptors
    // is `limit`: unresolved, never an unavailable item or a zero cost.
    // A path whose benefit cannot start inside the horizon is not a missing
    // path: it waits, counted, for money or a cheaper source. Its own elapsed
    // time (a drop's expected kills, a craft, a trip) at or past the horizon
    // waits too, though resale and status keep its ready value above zero (E212).
    const statusOf = (wish, node) => !wish.plan ? 'no_path'
        : wish.valueHours > 0 && positive(wish.plan.hours) < node.horizonHours ? 'evaluated'
            : wish.fullValueHours > 0 ? 'not_ready' : 'no_path';
    const readyGear = row => {
        const acquisition = row.wish.plan?.requirements?.find(requirement => requirement.key === `item:${row.candidate.item.selfId}`)?.plan
            || row.wish.plan;
        const command = acquisition?.execution || acquisition;
        return !!command?.executable && !command.awaitingIncoming && !command.requirements?.length
            && Number(command.availableUnits ?? Infinity) >= 1
            && Number(command.price || 0) <= Math.max(0, positive(solverOptions.wallet) - positive(solverOptions.survivalReserve));
    };
    const evaluate = (row, used) => {
        admission.evaluations++; row.evaluations = (row.evaluations || 0) + 1;
        row.status = 'limit'; row.wish = null; row.claims = null;
        // The arena joins its own root in the union: both within forty.
        if (row.keys.length + 1 > Network.MAX_NODES) return;
        try {
            const solver = Network.createSolver({ ...solverOptions, nodes: [...row.keys.map(key => descriptors.get(key)), row.node] });
            // With a stock reader allocate is the whole evaluation (it solves
            // against the claimed stock); rootWish is the stockless one.
            const wish = solverOptions.stockFor ? { key: row.node.key, need: row.node.need, object: row.node.object }
                : solver.rootWish(row.node.key);
            if (solverOptions.stockFor) { const claims = solver.allocate(wish, used); if (wish.plan) row.claims = claims; }
            row.wish = wish;
            row.readyGear = readyGear(row);
            row.status = statusOf(wish, row.node);
        } catch (error) {
            if (!SOLVER_LIMITS.has(error?.message)) throw error;
        }
    };
    const score = row => row.wish.valueHours / Math.max(1 / 3600, row.wish.effort);
    const before = (a, b) => {
        // Fundable material errands are not an equipped first-grade weapon.
        // Compare ready D/higher acquisitions first while that floor is open;
        // once it closes, the ordinary C weapon/armour/jewellery order resumes.
        if (a.candidate.firstWeaponGrade && b.candidate.firstWeaponGrade && a.readyGear !== b.readyGear)
            return a.readyGear;
        return a.node.progressionPriority !== b.node.progressionPriority
            ? a.node.progressionPriority > b.node.progressionPriority
            : (a.node.key === ctx.completionKey) !== (b.node.key === ctx.completionKey)
                ? a.node.key === ctx.completionKey
                : score(a) > score(b) || score(a) === score(b) && a.node.key < b.node.key;
    };
    const winners = open => {
        const best = new Map();
        for (const row of gear) {
            if (row.status !== 'evaluated' || !open(row.family)) continue;
            const held = best.get(row.family);
            const fundable = Number(Network.fundable(row.wish)), heldFundable = held ? Number(Network.fundable(held.wish)) : -1;
            if (!held || fundable > heldFundable || fundable === heldFundable && before(row, held)) best.set(row.family, row);
        }
        return [...best.values()].sort((a, b) => b.node.progressionPriority - a.node.progressionPriority
            || (luxury ? Number(Network.fundable(b.wish)) - Number(Network.fundable(a.wish)) : 0)
            || (before(a, b) ? -1 : before(b, a) ? 1 : 0));
    };
    // Family winners enter one at a time by score while the union of their
    // descriptors stays within forty; a winner that does not fit is pending
    // and the others proceed. Shared stock: after each admission except the
    // last, only candidates holding a newly claimed item are re-evaluated.
    function* admitGear() {
        let used = new Map();
        for (const row of gear) { evaluate(row, used); yield row; }
        admission.rounds = gear.length ? 1 : 0;
        const admitted = [], closed = new Set(), union = new Set();
        for (;;) {
            if (admitted.length >= GEAR_ROOTS) break;
            const [winner] = winners(family => !closed.has(family));
            if (!winner) break;
            closed.add(winner.family);
            if ([...winner.keys, winner.node.key].filter(key => !union.has(key)).length + union.size > Network.MAX_NODES) {
                admission.pending.push({ key: winner.node.key, reason: 'node_limit' });
                continue;
            }
            for (const key of winner.keys) union.add(key);
            union.add(winner.node.key);
            admitted.push(winner);
            if (admitted.length >= GEAR_ROOTS || !winner.claims || admission.rounds >= GEAR_ROUNDS) continue;
            const claimed = new Set();
            for (const [id, count] of winner.claims) if (count > (used.get(id) || 0)) claimed.add(`item:${id}`);
            used = new Map(used);
            for (const [id, count] of winner.claims) used.set(id, Math.max(used.get(id) || 0, count));
            const affected = gear.filter(row => !closed.has(row.family) && row.keys.some(key => claimed.has(key)));
            if (!affected.length) continue;
            admission.rounds++;
            for (const row of affected) { evaluate(row, used); yield row; }
        }
        // E303: families with an evaluated winner left out because the gear roots cap of 4 was reached.
        if (Diagnostics.active() && admitted.length >= GEAR_ROOTS) {
            const left = winners(family => !closed.has(family)).length;
            if (left) {
                Diagnostics.count('cap', 'gear_roots', 'cut');
                Diagnostics.count('cap', 'gear_roots', 'dropped', left);
            }
        }
        // Shared held stock (MVP-6): the network allocates it in the author's
        // money priority (stockless full value per price, an unquoted root at
        // its market price), not by score. Admitted roots whose arenas share
        // a held item someone claimed are allocated again in that order, one
        // evaluation each (a stockless solve for the order and an allocation),
        // so every witness is the expanded wish. A root the network would then
        // drop leaves admission as pending; its family waits for the next review.
        const shared = new Set(), seen = new Set();
        for (const row of admitted) for (const key of new Set(row.keys)) (seen.has(key) ? shared : seen).add(key);
        const claimed = key => admitted.some(row => row.claims?.get(Number(key.slice(5))) > 0);
        if (solverOptions.stockFor && [...shared].some(key => key.startsWith('item:') && claimed(key))) {
            const rows = [];
            for (const row of admitted) {
                admission.evaluations++; row.evaluations++;
                row.status = 'limit'; row.wish = null; row.claims = null;
                try {
                    const solver = Network.createSolver({ ...solverOptions, nodes: [...row.keys.map(key => descriptors.get(key)), row.node] });
                    const base = solver.rootWish(row.node.key);
                    if (base.plan && base.fullValueHours > 0) rows.push({ row, solver, base });
                    else row.status = 'no_path';
                } catch (error) {
                    if (!SOLVER_LIMITS.has(error?.message)) throw error;
                }
            }
            rows.sort((a, b) => Number(b.base.key === ctx.completionKey) - Number(a.base.key === ctx.completionKey)
                || b.base.fullValueHours / Math.max(1, b.base.price) - a.base.fullValueHours / Math.max(1, a.base.price)
                || a.base.key.localeCompare(b.base.key));
            used = new Map();
            for (const { row, solver } of rows) {
                const wish = { key: row.node.key, need: row.node.need, object: row.node.object };
                const claims = solver.allocate(wish, used);
                row.wish = wish; row.claims = wish.plan ? claims : null;
                row.readyGear = readyGear(row);
                row.status = statusOf(wish, row.node);
                // Only a root that stays admitted keeps its claim on held stock.
                if (row.status === 'evaluated') used = claims;
                yield row;
            }
            for (let at = admitted.length - 1; at >= 0; at--) if (admitted[at].status !== 'evaluated') {
                if (admitted[at].status === 'no_path') admission.pending.push({ key: admitted[at].node.key, reason: 'no_path' });
                admitted.splice(at, 1);
            }
        }
        for (const row of gear) if (row.status === 'limit' && !admitted.includes(row))
            admission.pending.push({ key: row.node.key, reason: 'evaluation_limit' });
        for (const row of gear) if (row.status === 'not_ready')
            admission.pending.push({ key: row.node.key, reason: 'not_ready_in_horizon' });
        // The selected-path witness: the scalar facts the expanded root must repeat.
        admission.admitted = admitted.map(row => ({ key: row.node.key, family: row.family, scratch: row.keys.length,
            evaluations: row.evaluations, price: row.wish.price, effort: row.wish.effort, valueHours: row.wish.valueHours,
            supported: row.wish.supported, resolved: row.wish.resolved }));
        return admitted;
    }
    // ARCH-NOTE: the provider runs inside the synchronous EconomyContext
    // forState; yielding each evaluation through prepareNative would need
    // forState and its callers as generators (the MVP-6 continuation gate,
    // not met). The generator keeps the per-evaluation step and is drained
    // here synchronously.
    const admitting = admitGear();
    let step = admitting.next();
    while (!step.done) step = admitting.next();
    const admittedGear = step.value;
    blocks?.lap('admission');
    if (!progression.required && rare && statusWeight > 0) {
        const held = admittedGear.some(row => row.node.object.itemId === Number(rare.item.selfId));
        const key = !held && itemNode(rare.item.selfId);
        if (key) root({ key: `status:${rare.item.selfId}`, need: 'status', object: { itemId: rare.item.selfId },
            price: price(rare.item.selfId), valueHours: rare.value * statusWeight,
            paths: [{ requirements: [{ key, amount: 1 }] }] });
    }
    if (!progression.required && ctx.hunt.expPerHour > 0 && state.level < invoke('GameServer/Progression/ProgressionCap').effectiveLevelCap()) {
        root({ key: `level:${state.level + 1}`, need: 'power', object: { level: state.level + 1 },
            valueHours: powerWeight, price: 0, paths: [{ kind: 'experience', activity: 'hunting',
                spotId: ctx.hunt.progressSpotId || ctx.bestSpotId, costHours: 1, riskHours: ctx.expectedDeathHours }] });
    }
    for (const kind of ['shots', 'potions', 'scrolls']) {
        const stock = ctx.stock(kind);
        // A necessary refill covers the planned outing in the same purchase.
        // Only the survival shortfall outranks unfinished equipment; once that
        // floor is filled, optional stock cannot keep the kit on hold.
        const amount = Number(stock?.survivalMissing || 0)
            + (progression.required && kind !== 'shots' ? 0 : Number(stock?.missing || 0));
        if (Diagnostics.active() && Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
            caller: deps.caller || 'wish_provider', trigger: 'projection_build',
            phase: 'wish_need', reason: !(amount > 0) ? 'target_satisfied' : !(stock.unitPrice > 0)
                ? 'unknown_price' : !(stock.benefitPerUnit > 0) ? 'no_expected_benefit' : 'stock_shortfall',
            decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
            wishKey: `stock:${kind}`, item: stock?.itemId, target: stock?.target,
            owned: stock?.current, missing: stock?.missing, requested: amount,
            unitPrice: stock?.unitPrice, valueHours: amount * (stock?.benefitPerUnit || 0), wallet: state.adena });
        if (!(amount > 0) || !(stock.unitPrice > 0) || !(stock.benefitPerUnit > 0)) continue;
        const key = itemNode(stock.itemId);
        if (!key) continue;
        const heldStock = nativeQuantities.physical(stock.itemId);
        quantityInputs?.stockPhysical(`stock:${kind}`, stock.itemId, heldStock);
        root({ key: `stock:${kind}`, need: 'power', object: { itemId: stock.itemId, amount, kind },
            progressionPriority: progression.required && stock.survivalMissing > 0 ? 4 : 0,
            valueHours: amount * stock.benefitPerUnit * powerWeight, price: amount * stock.unitPrice,
            // The survival tranche is the kit's cost (kitCost), already held
            // by the survival reserve; the money queue charges only the rest.
            reserved: Math.min(amount * stock.unitPrice, Math.max(0, Number(ctx.kitCost?.(stock.itemId)) || 0)),
            // gross = held units + amount, so allocation leaves `amount`.
            paths: [{ requirements: [{ key, amount }],
                grossRequirements: [{ key, amount: amount
                    + heldStock }] }] });
        values.set(stock.itemId, stock.benefitPerUnit);
    }
    // Concrete remembered people, not persona-labelled lifelong goals.
    const { friend, enemy } = relationTargets(state, deps);
    if (friend) root({ key: `care:${friend.targetId}`, need: 'care', object: { targetId: friend.targetId },
        valueHours: trait(ctx.persona, 'empathy') * trait(ctx.persona, 'sociability') * positive(friend.trust ?? friend.affinity),
        price: 0, paths: [{ activity: 'helping', targetId: friend.targetId, costHours: 1 }] });
    if (enemy) root({ key: `scores:${enemy.targetId}`, need: 'scores', object: { targetId: enemy.targetId },
        valueHours: positive(enemy.hostility ?? enemy.anger) * trait(ctx.persona, 'assertiveness'), price: 0,
        // A PvP death is a live one (it waits for its respawn).
        paths: [{ activity: 'pvp', targetId: enemy.targetId, costHours: 1, riskHours: liveDeathHours(ctx.deathHours) + ctx.karmaHours }] });
    // Only known concrete items enter the small resale watch list. The
    // board is queried by item, never by copying every owner's offers.
    const known = new Set([...candidates.map(row => Number(row.item.selfId)), ...rows(state).map(row => Number(row.selfId))]);
    const resaleWishes = [];
    for (const id of known) {
        if (!Sources.hasSource(id)) continue;
        if (present(id)) continue;
        const ask = ctx.board?.first(id, SELL, { excludeOwner: state.characterId });
        if (!(ask?.price > 0)) continue;
        const Market = invoke('GameServer/Bot/Economy/MarketCounters');
        const future = resale(price(id), { trend: Market.moveOf(Market.counterOf(id)),
            hours: horizon, understanding: ctx.persona.understanding, assertiveness: trait(ctx.persona, 'assertiveness'),
            caution: trait(ctx.persona, 'caution'), nextBuyerUse: price(id), npcFloor: ctx.buyback(id) });
        if (future > ask.price) resaleWishes.push({ id, ask, profit: future - ask.price });
    }
    resaleWishes.sort((a, b) => b.profit / b.ask.price - a.profit / a.ask.price);
    for (const row of resaleWishes.slice(0, 3)) {
        const key = itemNode(row.id); if (!key) continue;
        root({ key: `resale:${row.id}`, need: 'power', object: { itemId: row.id, kind: 'resale' },
            valueHours: ctx.hunt.perHour > 0 ? row.profit / ctx.hunt.perHour : 0, price: row.ask.price,
            paths: [{ requirements: [{ key, amount: 1 }] }] });
    }
    // Admitted gear enters the real graph after the other providers, so
    // their 36-node build cap is not spent on gear; the final rank cut
    // below compares every root.
    for (const row of admittedGear) {
        if (nodes.length + row.keys.filter(key => !nodeKeys.has(key)).length + 1 > 64) {
            admission.pending.push({ key: row.node.key, reason: 'node_limit' });
            continue;
        }
        for (const key of row.keys) include(key);
        values.set(Number(row.candidate.item.selfId), row.candidate.value * powerWeight);
        root(row.node);
    }
    const paidInputs = state.stats?.equipmentPlan?.crystalPreparation && need('./BotCrystallization').preparation(state);
    if (paidInputs) {
        const trip = paidInputs.self ? { known: true, hours: 0, fees: 0 } : ctx.trip?.details?.('Giran');
        if (trip?.known) root({ key: paidInputs.key, need: 'power', object: { itemId: paidInputs.plan.target.selfId },
            valueHours: 1, progressionPriority: 3.5,
            paths: [{ ...paidInputs.path, costHours: 1 / 3600,
                ...(paidInputs.self ? {} : { town: 'Giran', tripHours: trip.hours, tripFees: trip.fees }) }] });
    }
    for (const node of deps.nodes || []) { if (node.need) root(node); else add(node); }
    const moneyPaths = ctx.hunt.perHour > 0 ? [{ activity: 'hunting', kind: 'money',
        spotId: ctx.bestSpotId, incomePerHour: ctx.hunt.perHour, riskHours: ctx.expectedDeathHours }] : [];
    const liquidation = liquidationInputs(state, { shots: ctx.stock('shots'), potions: ctx.stock('potions'),
        excluded: [...values.keys()].filter(id => Object.hasOwn(state.inventory || {}, id)) });
    ctx.liquidationInputs = liquidation.proof;
    const sale = (liquidation.candidates || liquidationCandidates(state, ctx)).filter(row => !values.has(Number(row.selfId)));
    const saleValue = sale.reduce((sum, row) => sum + ctx.buyback(row.selfId) * row.count, 0);
    if (saleValue > 0) {
        // NPC buyback is the same across towns. Compare the prepared routes
        // once; a nearby seller can fund gear without an unaffordable fare to
        // the item's preferred player-market town.
        let best = null;
        for (const town of need('./EconomicTrip').towns) {
            if (!need('../Population/ColdOccupationSources').hasNpcSellerInTown(town)) continue;
            const route = ctx.trip?.details?.(town);
            if (route?.known) ctx.walletBoundary?.(route.fees);
            if (!route?.known || route.fees > Number(state.adena || 0)) continue;
            const cost = route.fees + route.hours * Math.max(1, ctx.hunt.perHour);
            if (!best || cost < best.cost) best = { town, route, cost };
        }
        if (best) {
            const { town, route } = best;
            moneyPaths.push({ activity: 'selling', kind: 'liquidate', repeatable: false,
                capacityCash: saleValue, cashFees: route.fees, actionHours: route.hours,
                town, items: sale.map(row => row.selfId) });
        }
    }
    // External game providers compete by the same value, rather than by
    // arriving after twelve preassigned gear slots.
    const byKey = new Map(nodes.map(node => [node.key, node]));
    const rank = key => { const node = byKey.get(key); return positive(node.valueHours)
        / Math.max(1 / 3600, positive(node.price) / Math.max(1, ctx.hunt.perHour) + positive(node.costHours)); };
    roots.sort((a, b) => positive(byKey.get(b).progressionPriority) - positive(byKey.get(a).progressionPriority)
        || positive(byKey.get(b).primaryEarning) - positive(byKey.get(a).primaryEarning)
        || rank(b) - rank(a) || a.localeCompare(b));
    const cut = Network.admitRoots(roots, byKey, { rootLimit: WISH_ROOTS, nodeLimit: Network.MAX_NODES });
    admission.pending.push(...cut.pending);
    for (const [key, scope] of builtBy) if (cut.kept.has(key)) ctx.readScope.keep(scope);
    if (Diagnostics.active()) {
        Diagnostics.count('provider', 'admission', 'candidate', admission.candidates);
        Diagnostics.count('provider', 'admission', 'evaluation', admission.evaluations);
        Diagnostics.count('provider', 'admission', 'round', admission.rounds);
        Diagnostics.count('provider', 'admission', 'gear_root', admittedGear.length);
        for (const row of admission.pending) Diagnostics.count('provider', 'admission_pending', row.reason);
        // On a source memo hit: descriptors offered, kept by their input fence, and built anew.
        if (deps.sourceSections) {
            Diagnostics.count('source_memo', 'descriptors', 'offered', deps.sourceSections.nodes?.length || 0);
            Diagnostics.count('source_memo', 'descriptors', 'kept', keptSources.length);
            Diagnostics.count('source_memo', 'descriptors', 'built', descriptorInputs.size - keptSources.length);
        }
    }
    const keptNodes = nodes.filter(node => cut.kept.has(node.key));
    let sourceSections = null, sourceBytes = -1;
    // structuredClone rejects an extension that supplied a function/closure;
    // such an input falls back to calculation instead of retaining a caller.
    try {
        const candidate = { nodes: keptNodes.filter(node => node.key.startsWith('item:') && descriptorInputs.has(node.key))
            .map(node => ({ node, inputs: descriptorInputs.get(node.key) })) };
        sourceBytes = Buffer.byteLength(JSON.stringify(candidate));
        if (sourceBytes <= 8192) sourceSections = structuredClone(candidate);
    } catch (_) { /* An uncloneable candidate falls back to calculation. */ }
    if (Diagnostics.active()) Diagnostics.count('source_memo', 'size', sourceBytes < 0 ? 'unmeasured'
        : sourceBytes > 8192 || sourceSections ? Diagnostics.sizeBucket(sourceBytes) : 'uncloneable');
    blocks?.lap('tail'); blocks?.done();
    return { nodes: keptNodes, roots: cut.roots, values, moneyPaths, horizon, admission, sourceSections, sourceGround };
}
// Only public recipe rows and a prepared route can prove a usable service.
// This bounded indexed read is shared by visible and distant bots. No private
// recipe book, producer-profit gate or synchronous route expansion is needed.
function knownWorkshop(recipe, state, ctx, deps) {
    const trip = deps.tripCost || ctx.trip;
    if (typeof trip?.details !== 'function') return null;
    let best = null;
    for (const row of deps.workshops(Number(recipe.recipeId), state) || []) {
        if (Number(row.characterId) === Number(state.characterId)
            || Number(row.recipeId) !== Number(recipe.recipeId)
            || !Number.isSafeInteger(Number(row.price)) || Number(row.price) < 0
            || ![row.loc?.locX, row.loc?.locY, row.loc?.locZ].every(Number.isFinite)) continue;
        // Capacity bounds one command; the chosen row's craft facts are read once by the caller.
        if (!(Number(row.capacityBatches) >= 1)) continue;
        const route = trip.details(row.townName);
        if (!route?.known || !Number.isFinite(route.hours) || !Number.isFinite(route.fees)) continue;
        const cost = Number(row.price) + route.fees + route.hours * Number(ctx.hourAdena || ctx.hunt?.perHour || 0);
        if (!best || cost < best.cost || cost === best.cost && Number(row.characterId) < best.characterId)
            best = { ...row, characterId: Number(row.characterId), cost,
                tripHours: route.hours, tripFees: route.fees };
    }
    return best;
}
// Translate the chosen shared wish into the existing equipment craft owner
// or an opt-in hot stock visit, using the already built graph.
function personalCraftPlan(state, context, { allowStock = false } = {}) {
    const leaf = context?.network?.activity;
    const paidInputs = state.stats?.equipmentPlan?.crystalPreparation && need('./BotCrystallization').preparation(state);
    if (paidInputs && leaf?.rootKey === paidInputs.key) return paidInputs.plan;
    if (!leaf || !leaf.rootKey || !['crafting', 'shopping', 'hunting', 'improving'].includes(leaf.activity)) return null;
    const wish = context.network.queue.find(row => row.key === leaf.rootKey)
        || { object: context.projection?.nodes?.find(row => row.key === leaf.rootKey)?.object,
            plan: context.network.plans.get(leaf.rootKey) };
    const targetId = Number(wish?.object?.itemId || leaf.rootKey.split(':')[1]);
    const stock = allowStock && state.phase === 'hot' && /^stock:(shots|potions|scrolls)$/.test(leaf.rootKey);
    const clanSupply = wish.object?.clanSupply && need('./ClanCrystalSupply').requirement(state);
    if (!targetId || !leaf.rootKey.startsWith('power:') && !stock && !clanSupply) return null;
    if (stock && (leaf.activity !== 'crafting' || leaf.funding || !wish?.funded)) return null;
    // Ready blacksmith exchanges cost no money, so their root need not be in
    // the spending queue. Route the native selected leaf to the equipment
    // owner; it cannot be executed by the dwarf workshop/production owner.
    const dual = leaf.kind === 'craft' && leaf.activity === 'crafting' && leaf.executable && !leaf.funding
        ? DualSwords.resolveByRecipeId(leaf.recipeId) : null;
    if (dual?.productId === targetId && dual.materials.every(row =>
        Number(state.inventory?.[row.selfId]?.amount || 0) >= row.amount)) return {
        strategy: 'craft', status: 'ready_to_craft', next: null,
        target: { selfId: targetId, slot: 14 }, recipeId: dual.recipeId, outputAmount: 1,
        materials: dual.materials.map(row => ({ ...row,
            owned: Number(state.inventory[row.selfId].amount), missing: 0 })),
        combine: { type: 'dual_sword', resultId: targetId, stationId: dual.station.id,
            npcId: dual.station.npcId, requirements: dual.materials.map(row => ({ ...row })) },
        source: 'wish_network'
    };
    const providers = {}, components = {}, visited = new Set(), crystalInputs = new Map();
    let finalRecipe = null, crystalExchange = null, unseal = null;
    let exchange = leaf.kind === 'luxury_exchange' && Number(leaf.improvement?.itemId) === targetId ? leaf.improvement : null;
    const visit = (plan, depth = 0) => {
        if (!plan || depth > 8 || visited.has(plan)) return;
        visited.add(plan);
        if (plan.kind === 'mammon_unseal' && Number(plan.unseal?.productId) === targetId)
            unseal = plan.unseal;
        if (plan.kind === 'luxury_exchange' && Number(plan.improvement?.itemId) === targetId)
            exchange = plan.improvement;
        if (plan.kind === 'luxury_exchange' && plan.improvement?.forCrystals) crystalExchange = plan.improvement;
        if (plan.kind === 'crystallize') {
            const command = plan.execution || plan;
            for (const input of command.improvement.items
                || [{ selfId: command.improvement.sourceSelfId, amount: Number(command.batches || 1) }])
                crystalInputs.set(Number(input.selfId), Math.min(need('./BotCrystallization').BATCH_LIMIT, Number(input.amount)));
        }
        if (plan.kind === 'craft' && plan.workshop) {
            const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(plan.recipeId);
            if (!recipe) return;
            if (Number(recipe.productId) === Number(unseal?.sourceId || targetId)) finalRecipe = recipe;
            components[recipe.productId] = Number(recipe.recipeId);
            providers[recipe.recipeId] = { workshop: true, characterId: Number(plan.workshop.characterId),
                ...(plan.workshop.publicStation ? { publicStation: true } : {}),
                price: Number(plan.workshop.price),
                loc: plan.workshop.loc, townName: plan.workshop.townName, known: true };
        }
        for (const row of plan.requirements || []) visit(row.plan || context.network.plans.get(row.key), depth + 1);
    };
    visit(wish?.plan || context.network.plans.get(`item:${targetId}`));
    if (clanSupply) {
        const plan = clanSupply.plan;
        const inputs = [...crystalInputs].map(([selfId, amount]) => ({ selfId, amount }));
        return { ...plan, valueRate: Number(wish.ratio || 0),
            ...(plan.strategy === 'luxury_exchange'
                ? { materials: [...plan.materials.filter(row => !inputs.some(input => input.selfId === row.selfId)), ...inputs] }
                : inputs.length ? { crystalPreparation: { exchange: crystalExchange,
                    materials: [...(crystalExchange?.materials || []).map(row => ({ ...row })), ...inputs] } } : {}) };
    }
    if (exchange) return { strategy: 'luxury_exchange', status: 'active',
        target: { selfId: targetId, slot: Number(wish.object?.slot || leaf.rootKey.split(':')[2]) }, exchange,
        materials: [...exchange.materials.map(row => ({ ...row })),
            ...[...crystalInputs].map(([selfId, amount]) => ({ selfId, amount }))],
        ...(leaf.activity === 'hunting' ? { next: { spotId: leaf.spotId, npcId: leaf.npcId,
            selfId: Number(leaf.itemId || leaf.object), sourceKind: leaf.kind } } : {}),
        valueRate: Number(wish.ratio || 0), source: 'wish_network' };
    if (!finalRecipe && !unseal) return null;
    return { strategy: 'craft', status: 'active',
        target: { selfId: targetId, slot: stock ? 0 : Number(wish.object?.slot || leaf.rootKey.split(':')[2]) },
        ...(leaf.activity === 'hunting' ? { next: { spotId: leaf.spotId, npcId: leaf.npcId,
            selfId: Number(leaf.itemId || leaf.object), sourceKind: leaf.kind } } : {}),
        recipeId: Number(finalRecipe?.recipeId) || null,
        outputAmount: Number(wish.object?.amount || 1) + (stock ? Math.max(0, Number(state.inventory?.[targetId]?.amount) || 0) : 0),
        materials: finalRecipe ? (providers[finalRecipe.recipeId]?.publicStation
            ? require('../../Crafting/StationRecipe').forStation(finalRecipe) : finalRecipe).materials.map(row => ({ ...row }))
            : [{ selfId: unseal.sourceId, amount: 1 }],
        ...(unseal ? { unseal: { ...unseal } } : {}), craftProviders: providers,
        ...(crystalInputs.size ? { crystalPreparation: { exchange: crystalExchange,
            materials: [...(crystalExchange?.materials || []).map(row => ({ ...row })),
                ...[...crystalInputs].map(([selfId, amount]) => ({ selfId, amount }))] } } : {}),
        componentRecipes: components, valueRate: Number(wish.ratio || 0), source: 'wish_network',
        ...(stock ? { purpose: 'stock', wishKey: leaf.rootKey } : {}) };
}
function liquidationCandidates(state, ctx) {
    const saleState = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').saleState(state);
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    return Disposition.saleCandidates(saleState, {
        preparedReservations: Disposition.reservedEquipmentAmounts(saleState),
        keptAmounts: { ...invoke('GameServer/Inventory/ShotStock').keptAmounts(state, ctx),
            ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: ctx.stock('potions').target }),
            ...invoke('GameServer/Bot/Travel/ScrollStock').keptAmounts(state) }
    }).filter(row => row.npcComparable && !Disposition.isGradeCrystal(row));
}
// Re-run the native selector, including rejected and cap-displaced items. The
// held foundation supplies only its stock targets; current owners still read
// current bag/warehouse quantities, equipment and physical reservations.
// These ordered pairs are its complete output consumed by the provider.
function liquidationInputs(state, basis) {
    if (!basis?.shots || !basis?.potions) return { proof: null, candidates: null };
    const shots = basis.shots, potions = basis.potions;
    const known = Number.isSafeInteger(shots.itemId) && shots.itemId > 0
        && [shots.target, shots.beginnerCurrent ?? 0, potions.target].every(value => Number.isFinite(value) && value >= 0);
    const excluded = basis.excluded || [];
    if (!known || !Array.isArray(excluded) || excluded.length > 128
        || !excluded.every(id => Number.isSafeInteger(id) && id > 0)
        || new Set(excluded).size !== excluded.length) return { proof: null, candidates: null };
    const exclusions = new Set(excluded);
    // Select before filtering: an excluded item can still displace a later
    // candidate at the native cap. These are the rows funding actually uses.
    const candidates = liquidationCandidates(state, { stock: kind => basis[kind] })
        .filter(row => !exclusions.has(Number(row.selfId)));
    const proof = Object.freeze({
        basis: Object.freeze({
            shots: Object.freeze({ itemId: shots.itemId, target: shots.target, beginnerCurrent: shots.beginnerCurrent ?? 0 }),
            potions: Object.freeze({ target: potions.target }),
            excluded: Object.freeze(excluded.slice())
        }),
        rows: Object.freeze(candidates.map(row => Object.freeze([row.selfId, row.count])))
    });
    return { proof, candidates };
}
// Exact transport of one proof above for the saved restart prefix: its fixed
// basis shape, then the ordered rows. Any other shape is refused, not cut.
const plainKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function packLiquidationInputs(proof, write) {
    const basis = proof?.basis, shots = basis?.shots;
    if (!plainKeys(proof, ['basis', 'rows']) || !plainKeys(basis, ['shots', 'potions', 'excluded'])
        || !plainKeys(shots, ['itemId', 'target', 'beginnerCurrent']) || !plainKeys(basis.potions, ['target'])
        || !Array.isArray(proof.rows) || !proof.rows.every(row => Array.isArray(row) && row.length === 2)) return false;
    write.uint(shots.itemId); write.number(shots.target); write.number(shots.beginnerCurrent); write.number(basis.potions.target);
    write.list(basis.excluded, id => write.uint(id));
    write.list(proof.rows, ([id, count]) => { write.uint(id); write.number(count); });
    return true;
}
function unpackLiquidationInputs(read) {
    const shots = Object.freeze({ itemId: read.uint(), target: read.number(), beginnerCurrent: read.number() });
    const potions = Object.freeze({ target: read.number() });
    const excluded = Object.freeze(read.list(() => read.uint()));
    const rows = Object.freeze(read.list(() => Object.freeze([read.uint(), read.number()])));
    return Object.freeze({ basis: Object.freeze({ shots, potions, excluded }), rows });
}
module.exports = { GEAR_FINALISTS_PER_SLOT, PRODUCER_PRICED, nominationBasis, recipeIds, quantityReaders, relationTargets, relationBond, knownWorkshop, personalCraftPlan, liquidationCandidates, liquidationInputs, packLiquidationInputs, unpackLiquidationInputs, build, gearCandidates, gearGain, skillGain, attackRate, rotationRate, worn };
