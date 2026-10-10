'use strict';

const { trait, stageHours, resale } = require('./EconomicValuation');
const { SELL } = require('../../AfkTrade/BoardIndex');
const Sources = require('../../Items/ItemAcquisitionCatalog');
const Diagnostics = require('./EconomyDiagnostics');
const Equipment = require('../AI/BotEquipmentCompatibility');
const Network = require('./WishNetwork');
let catalogSource = null;
let sourceRevision = -1;
const kits = new Map();

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
const GEAR_RANKS = ['none', 'd', 'c', 'b', 'a', 's'];
// MVP-6 (PLAN "Admission and placement"): four gear roots, four admission
// rounds (the initial evaluation plus three affected re-evaluations).
const GEAR_ROOTS = 4;
const GEAR_ROUNDS = 4;
const SOLVER_LIMITS = new Set(['missing_wish_requirement', 'cyclic_wish_network', 'invalid_wish_node', 'wish_network_depth']);
function gearCandidates(state, ctx = null, wornFor = wornReader(state), acquisitionAllowed = null) {
    const Data = invoke('GameServer/DataCache');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const revision = Sources.revision();
    if (catalogSource !== Data.items || sourceRevision !== revision) {
        catalogSource = Data.items; sourceRevision = revision; kits.clear();
    }
    const role = Planner.roleFor(state);
    const classId = Number(state.stats?.classId || state.classId || 0);
    const key = `${classId}:${role}`;
    if (!kits.has(key)) {
        const slots = new Map(), empty = { classId, stats: { classId }, inventory: {} };
        for (const item of Data.items || []) {
            if (!Sources.hasSource(item.selfId) || !Planner.suitable(item, empty, role, String(item.etc?.rank || 'none'))) continue;
            const slot = Number(item.etc?.slot);
            if (!slots.has(slot)) slots.set(slot, []);
            slots.get(slot).push(item);
        }
        // Scores and grade membership are game data for this class/role,
        // not another owner cache. Parallel columns add nine bytes per entry.
        for (const [slot, list] of slots) {
            const scored = list.map(item => ({ item, score: Planner.itemScore(item, role, classId) }));
            scored.sort((a, b) => b.score - a.score
                || Number(a.item.template.price) - Number(b.item.template.price)
                || Number(a.item.selfId) - Number(b.item.selfId));
            slots.set(slot, { items: scored.map(row => row.item),
                scores: Float64Array.from(scored, row => row.score),
                // Unknown ranks formerly had index -1 and remain eligible.
                ranks: Int8Array.from(scored, row => GEAR_RANKS.indexOf(String(row.item.etc?.rank || 'none'))) });
        }
        kits.set(key, slots);
    }
    const maxRank = GEAR_RANKS.indexOf(Planner.gradeForLevel(state.level));
    const result = new Map();
    const budget = Math.max(0, Number(state.adena || 0) - Number(ctx?.survivalReserve || 0));
    const target = Number(state.stats?.equipmentPlan?.target?.selfId || 0);
    const held = String(state.stats?.wishFocus?.[0] || '').match(/^power:(\d+):/);
    for (const [slot, kit] of kits.get(key)) {
        const allowed = [];
        for (let at = 0; at < kit.items.length; at++) if (kit.ranks[at] <= maxRank) allowed.push(at);
        // The exported game-data view is also used to construct fixed kits;
        // it has no actor choice or expensive build evaluation.
        if (!ctx) { result.set(slot, allowed.map(at => kit.items[at])); continue; }
        const current = replacementWorn(wornFor, slot);
        const owned = current && Data.items && require('../../Item/ItemTemplateIndex').find(Data.items, current.selfId);
        const before = owned ? Planner.itemScore(owned, role, classId) : 0;
        const efficientByRank = new Map();
        let affordable = null, above = null, retained = null;
        const cheaper = (a, b) => !b || a.price < b.price || a.price === b.price && a.item.selfId < b.item.selfId;
        const better = (a, b) => !b || a.ratio > b.ratio || a.ratio === b.ratio && cheaper(a, b);
        for (const at of allowed) {
            const item = kit.items[at];
            if (acquisitionAllowed && !acquisitionAllowed(item.selfId)) continue;
            const price = Number(ctx.price(item.selfId));
            if (!(price > 0) || Number(current?.selfId) === Number(item.selfId)) continue;
            const score = kit.scores[at];
            const row = { item, price, score, ratio: Math.max(0, score - before) / price };
            if (Number(item.selfId) === target || Number(item.selfId) === Number(held?.[1])) retained = row;
            // A proxy can nominate a same-score SA/set alternative, but cannot
            // declare its true build benefit; gearGain does that below.
            if (score < before) continue;
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
        for (const row of [retained, ...efficientByRank.values(), affordable, above]) if (row) selected.set(Number(row.item.selfId), row.item);
        result.set(slot, [...selected.values()].slice(0, GEAR_FINALISTS_PER_SLOT));
    }
    return result;
}
function rows(state) { return Object.values(state.inventory || {}); }
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
        && (Number(row.slot) === slot || row.equippedSlots?.includes(slot))) || null;
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
function replacementConflict(row, slot) {
    // Non-weapon gain keeps its existing paired jewellery/body semantics.
    if (!Equipment.isWeaponSlot(slot)) return Number(row.slot) === slot;
    if (!row.equipped && !(row.equippedCount > 0)) return false;
    if (row.equippedSlots?.length) {
        for (const wornSlot of row.equippedSlots) {
            if (Equipment.equipmentReplacementConflict(slot, wornSlot)) return true;
        }
        return false;
    }
    const wornSlot = row.slot || require('../../Item/ItemTemplateIndex')
        .find(invoke('GameServer/DataCache').items, row.selfId)?.etc?.slot;
    return Equipment.equipmentReplacementConflict(slot, wornSlot);
}
// What wearing `item` in its slot adds to the bot's build: remembered per
// build and item (design 16.5), so a later review of the same build reuses it.
function gearGain(state, item, timestamp = Date.now(), build = null, threatMask = 3) {
    return gearGainReader(state, timestamp, build, undefined, threatMask)(item);
}
function gearGainReader(state, timestamp, build, caster = require('./BotImprovementPolicy').isCaster(state), threatMask = 3) {
    threatMask = threatMask === 1 ? 1 : 3;
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    build ||= Profile.buildGainsFor(state, timestamp);
    let inventoryEntries, withoutSlot, previousSlot, ownWeapon;
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const role = Planner.roleFor(state), classId = Number(state.stats?.classId || state.classId || 0);
    const entries = () => inventoryEntries ||= Object.entries(state.inventory || {});
    const selectedWeapon = item => {
        if (!Planner.equipmentCandidate(item, state, role)) return false;
        if (ownWeapon === undefined) {
            ownWeapon = null;
            const Data = invoke('GameServer/DataCache');
            const Index = require('../../Item/ItemTemplateIndex');
            // The same native comparison, once per review, includes weapons
            // received but not yet reconciled. Known material slots need no lookup.
            for (const [key, row] of entries()) {
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
    return item => Profile.gainFor(build, `${caster ? 'm' : 'p'}:gear:${threatMask}:${item.selfId}:${item.etc.slot}`, () => {
        const before = Profile.powerNumbers(build);
        const slot = Number(item.etc.slot);
        if (Equipment.isWeaponSlot(slot) && !selectedWeapon(item)) return { attack: 0, defence: 0 };
        // Only a new native gain needs a hypothetical bag. Prepare its unchanged
        // rows/removal for the current slot, then give each candidate a fresh
        // overlay. Candidates are grouped by slot: keep one base, not one bag
        // for every slot. Cached gains allocate no bag; scratch dies at return.
        if (!withoutSlot || previousSlot !== slot) {
            previousSlot = slot;
            withoutSlot = Object.fromEntries((inventoryEntries ||= Object.entries(state.inventory || {}))
                .map(([key, row]) => [key, replacementConflict(row, slot)
                    ? { ...row, equipped: false, equippedCount: 0, equippedSlots: [] } : row]));
        }
        const inventory = { ...withoutSlot, [item.selfId]: { selfId: Number(item.selfId), amount: 1, equipped: true,
            equippedCount: 1, slot, enchant: 0 } };
        const after = Profile.powerFor({ ...state, inventory }, timestamp, Profile.buildOptions(build, timestamp));
        const attack = caster ? 'mAtk' : 'pAtk';
        const attackGain = Math.max(0, Number(after[attack]) / Math.max(1, Number(before[attack])) - 1);
        const defenceGain = Math.max(0, 1 - Number(before.pDef) / Math.max(1, Number(after.pDef)));
        const magicGain = Math.max(0, 1 - Number(before.mDef) / Math.max(1, Number(after.mDef)));
        return { attack: attackGain, defence: threatMask === 1 ? defenceGain : Math.max(defenceGain, magicGain) };
    });
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
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
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
function skillGain(state, book, before = null, beforeRate = null, timestamp = Date.now(), build = null) {
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const original = state.stats?.coldCombat || {};
    const skills = Profile.skillSnapshotsFromRecords([...original.skills || [], { selfId: book.skillId, level: book.level }]);
    const options = build ? Profile.buildOptions(build, timestamp) : {};
    const after = Profile.profileFor({ ...state, stats: { ...state.stats, coldCombat: { ...original, skills } } }, timestamp, options);
    before = before || Profile.profileFor(state, timestamp, options);
    beforeRate = beforeRate ?? attackRate(before);
    return { attack: Math.max(0, attackRate(after) / Math.max(0.001, beforeRate) - 1),
        defence: Math.max(0, 1 - before.pDef / after.pDef, 1 - before.mDef / after.mDef) };
}
// A review judges the bot against every drop source of every candidate: its
// combat readiness is computed once for the review (the planner's scope).
function build(state, ctx, deps = {}) {
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('provider', 'request');
    const started = diagnostic ? performance.now() : 0;
    const result = invoke('GameServer/Bot/Population/ColdCombatProfile').withEquipmentPreparation(() =>
        invoke('GameServer/Bot/AI/GearAcquisitionPlanner').withReadiness(() => buildProjection(state, ctx, deps)));
    if (diagnostic) {
        Diagnostics.count('provider', 'build', 'context_miss');
        Diagnostics.duration('provider', performance.now() - started);
    }
    return result;
}
function buildProjection(state, ctx, deps) {
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const timestamp = ctx.timestamp ?? Date.now();
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const ownBuild = Profile.buildGainsFor(state, timestamp);
    let beforeBook = null, beforeBookRate = null;
    const magic = require('./BotImprovementPolicy').isCaster(state);
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    // `nodes` is the current target: the real projection, or one gear
    // candidate's scratch arena while it is evaluated (MVP-6).
    let nodes = [], scratch = false;
    const roots = [], values = new Map();
    const add = node => { if (nodes.length >= 64 || nodes.some(row => row.key === node.key)) return false;
        nodes.push(node); return true; };
    // One descriptor per item key in this build, shared by the scratch
    // arenas and the real graph, so a witness and its expanded root read
    // identical nodes. ARCH-NOTE: dies at return; at most the 64-node cap
    // per target, no owner store.
    const descriptors = new Map();
    // The read scope of the candidate whose arena built each descriptor;
    // only scopes with a descriptor in the final cut become inputs.
    const builtBy = new Map();
    let readScope = null;
    const include = key => {
        if (nodes.some(node => node.key === key)) return;
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
    const horizon = stageHours(state, ctx.hunt.expPerHour, ctx.persona);
    const powerWeight = (ctx.persona.primaryDrive === 'progression' ? 1 : 0.5) + trait(ctx.persona, 'caution');
    const statusWeight = trait(ctx.persona, 'ambition') * (1 + Number(ctx.persona.primaryDrive === 'wealth'));
    const sourceIndex = deps.spots?.length ? Planner.sourceIndexFor(deps.spots) : null;
    // ARCH-NOTE: PERF: Native repeated source reads fell 7004→1395 / 7229→1408;
    // exact 600 whole preparation mean 2.165→1.985 ms / max 27.369→21.393 ms.
    // Fixed state/time/persona/occupancy make spotValue pure within this build.
    // This local map dies at return: ~468 KB transient per measured build,
    // zero ArrayBuffers and zero maps retained after return + GC; no owner store.
    const sourceValues = new Map();
    // ARCH-NOTE: PERF: native same-input provider replay (60 builds/variant)
    // 124.56 -> 27.28 ms; nine complete projections byte-equal. Reuse the
    // existing 16,384-entry yield bound and atlas counts, no per-bot retention.
    // Shared-host offline result only; not a live throughput/budget claim.
    const sourceYield = sourceIndex ? Planner.sourceYieldReaderFor(state.level) : null;
    const knownRecipes = new Set(recipeIds(state, deps));
    const preparingItems = new Set();
    const purchaseFor = require('./WishPurchaseEvidence').reader(state, ctx, deps);
    const purchases = new Map();
    const observedPurchase = id => {
        if (!purchases.has(id)) purchases.set(id, purchaseFor(id));
        return purchases.get(id);
    };
    const sourcePath = id => {
        let best = null;
        for (const source of sourceIndex?.get(Number(id)) || []) {
            if (source.spot.raidBoss || (source.kind === 'spoil' && !invoke('GameServer/Bot/AI/BotRoles').isSpoiler(state))) continue;
            if (!Planner.soloSafeForSource(state, source)) continue;
            const total = source.totalCount, own = source.sourceCount;
            if (!sourceValues.has(source.spot)) sourceValues.set(source.spot, ctx.spotValue(source.spot));
            const rate = sourceValues.get(source.spot);
            const yieldPerKill = sourceYield(source, id).expectedYield;
            const perHour = positive(rate?.kills) * positive(yieldPerKill) * own / Math.max(1, total);
            if (perHour > 0 && (!best || perHour > best.perHour)) best = { source, perHour };
        }
        return best ? { kind: best.source.kind, activity: 'hunting', costHours: 1 / best.perHour,
            spotId: best.source.spot.id, npcId: best.source.reward.selfId, itemId: Number(id), amount: 1 } : null;
    };
    const craftPath = (recipe, id, depth = 0, ownOnly = false) => {
        if (!Sources.allowsRecipe(recipe)) return null;
        const ownCapable = recipe && (recipe.kind === 'dual_sword_combine'
            || invoke('GameServer/Bot/Economy/CraftShopService').canCraft(state, recipe));
        let workshop = !ownOnly && recipe && deps.workshops ? knownWorkshop(recipe, state, ctx, deps) : null;
        if (workshop && ownCapable && knownRecipes.has(Number(recipe.recipeId))) {
            const regen = Number(invoke('GameServer/Bot/Population/BackgroundResolver').coldRestRegenPerTick(state).mp);
            const ownHours = Number(recipe.mpCost) > 0 && regen > 0 ? Number(recipe.mpCost) / regen * 3 / 3600 : 0;
            const ownCost = ownHours * Number(ctx.hourAdena || ctx.hunt?.perHour || 0);
            if (Number.isFinite(ownCost) && ownCost <= workshop.cost) workshop = null;
        }
        if (recipe && (ownCapable || workshop) && nodes.length + recipe.materials.length < 36) {
            const combined = require('./CraftProfitPolicy').requirements(recipe) || new Map();
            const freeAmount = require('./WealthCraftDecision').freeAmount;
            const requirements = [];
            const grossRequirements = [];
            let ownInputOpportunityValue = 0;
            for (const [selfId, amount] of combined) {
                const owned = Math.min(amount, freeAmount(state, state.inventory?.[selfId] || {}));
                ownInputOpportunityValue += owned * positive(price(selfId));
                const missing = amount - owned;
                const materialKey = itemNode(selfId, depth + 1);
                grossRequirements.push({ key: materialKey, amount });
                if (missing > 0) requirements.push({ key: materialKey, amount: missing });
            }
            const learned = !!workshop || recipe.kind === 'dual_sword_combine' || knownRecipes.has(Number(recipe.recipeId));
            const ownedScroll = freeAmount(state, state.inventory?.[recipe.recipeItemId] || {}) > 0;
            if (!learned && ownedScroll) ownInputOpportunityValue += positive(price(recipe.recipeItemId));
            let scrollAvailable = learned || ownedScroll;
            if (!scrollAvailable && deps.board) {
                for (const line of deps.board.list(recipe.recipeItemId, 1)) {
                    if (Number(line.ownerId) !== Number(state.characterId) && Number(line.count) > 0 && Number(line.price) > 0) {
                        scrollAvailable = true; break;
                    }
                }
            }
            if (!scrollAvailable) scrollAvailable = !!sourcePath(recipe.recipeItemId);
            const scrollKey = !learned && scrollAvailable ? itemNode(recipe.recipeItemId, depth + 1) : null;
            if (!learned && !ownedScroll && scrollAvailable) requirements.push({ key: scrollKey, amount: 1 });
            // A physical attempt consumes one whole batch, including failure.
            // Its chance reduces the finite root benefit once; inputs are not
            // divided by expected yield. No imagined commissioned service.
            const regen = Number(invoke('GameServer/Bot/Population/BackgroundResolver').coldRestRegenPerTick(state).mp);
            const recoveryHours = positive(recipe.mpCost) > 0 && regen > 0 ? positive(recipe.mpCost) / regen * 3 / 3600 : NaN;
            const cycleHours = workshop ? 1 / 3600
                : recipe.kind === 'dual_sword_combine' ? Number(recipe.costHours || 1 / 3600) : recoveryHours;
            if (scrollAvailable && (learned || scrollKey) && Number.isFinite(cycleHours) && cycleHours > 0
                && requirements.every(row => row.key) && grossRequirements.every(row => row.key)) return { kind: 'craft', activity: 'crafting',
                itemId: Number(id), recipeId: recipe.recipeId,
                ...(workshop ? { workshop, price: workshop.price, town: workshop.townName,
                    tripHours: workshop.tripHours, tripFees: workshop.tripFees,
                    executable: workshop.capacityBatches > 0, availableUnits: workshop.capacityBatches * Number(recipe.productCount || 1), quoted: true } : {}),
                requiresRecipeLearning: !learned, successProbability: Number(recipe.successRate ?? 100) / 100,
                ownInputOpportunityValue, costHours: cycleHours, productCount: Number(recipe.productCount || 1),
                grossRequirements: [...grossRequirements,
                    ...(!learned && scrollAvailable ? [{ key: scrollKey, amount: 1, once: true }] : [])],
                requirements };
        }
        return null;
    };
    const itemNode = (id, depth = 0) => {
        if (!Sources.hasSource(id)) return null;
        const key = `item:${id}`;
        if (nodes.some(node => node.key === key)) return key;
        if (depth >= 3 || nodes.length >= 36 || preparingItems.has(key)) return null;
        // A memoized subgraph enters the real graph under the same 36-node
        // cap as a fresh build: its whole missing closure is counted first.
        // A candidate's scratch arena copies it whole, so its witness reads
        // the real graph's descriptors; the arena bound is the evaluation's.
        if (descriptors.has(key)) {
            const missing = new Set();
            const collect = at => {
                if (missing.has(at) || nodes.some(node => node.key === at) || !descriptors.has(at)) return;
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
        const observed = observedPurchase(id);
        // A raid origin belongs to the clan's prepared roster. A personal
        // wish needs actual owned stock or a finite supplier, not a price.
        const ordinary = Sources.hasNonRaidSource(id);
        if (!ordinary && !observed && !positive(state.inventory?.[id]?.amount)) return null;
        preparingItems.add(key);
        const paths = [{ kind: 'buy', activity: 'shopping', price: price(id), itemId: Number(id), amount: 1,
            available: !!observed || ordinary && price(id) > 0, executable: !!observed,
            ...(observed || { availableUnits: 0 }) }];
        const drop = sourcePath(id);
        if (drop) paths.push(drop);
        const crystal = invoke('GameServer/Bot/Economy/BotImprovementPolicy').crystalPath(state, id, ctx, deps.spots || []);
        if (crystal) paths.push(crystal);
        const recipe = Recipes.resolveByProductId(id) || invoke('GameServer/Items/C4DualSwordCombinations').loadRecipes()
            .find(row => Number(row.productId) === Number(id));
        const craft = craftPath(recipe, id, depth);
        if (craft) paths.push(craft);
        const node = { key, object: Number(id), price: price(id), paths: paths.length <= 3 ? paths : [...paths.slice(0, 2), paths.find(path => path.kind === 'craft') || paths[2]] };
        descriptors.set(key, node);
        if (scratch && readScope) builtBy.set(key, readScope);
        add(node);
        preparingItems.delete(key);
        return key;
    };
    // A finite earning goal uses the existing resale certificate and input
    // graph. The finished product is output, never a preparatory BUY leaf.
    // Only finalists expand their recipe DAG; public candidates come from the
    // worker's existing item->recipe index, not a per-actor catalogue scan.
    const producerCandidates = function* () {
        for (const id of knownRecipes) yield Recipes.resolveByRecipeId(id);
        for (const row of rows(state)) if (require('./WealthCraftDecision').freeAmount(state, row) > 0) yield Recipes.resolve?.(Number(row.selfId));
        yield* deps.producerRecipes || [];
    };
    const production = new Map(), seenProduction = new Set();
    const serviceCraft = invoke('GameServer/Bot/Economy/CraftShopService');
    if (ctx.board && ctx.hourAdena > 0 && serviceCraft.isServiceCrafter(state)
        && !state.stats?.craftStationId && !/^bot_craft_\d+$/i.test(String(state.accountName || ''))) {
        // Per-bot constants of the candidate loop: the bot's own plain sell lines
        // are read once and grouped by item, not once per candidate recipe.
        // Plan bound (E92 "Performance, fixed bounds"): preliminary admission
        // reads only the RecipeProductionIndex rows and O(1) facts per recipe;
        // the detailed exit pricing runs for PRODUCER_PRICED finalists only.
        const Price = require('./PriceDecision'), WealthCraft = require('./WealthCraftDecision');
        const ItemTemplates = require('../../Item/ItemTemplateIndex'), Profit = require('./CraftProfitPolicy');
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
            const stock = WealthCraft.freeAmount(state, state.inventory?.[id] || {});
            const ownSales = ownSalesByItem.get(id) || [];
            const oldUnits = stock + Number(state.acceptedIncoming?.[id] || 0) + ownSales.reduce((sum, line) => sum + Number(line.count), 0);
            if (!Number.isSafeInteger(oldUnits) || oldUnits < 0) continue;
            const material = String(ItemTemplates.find(items, id)?.template?.kind || '').startsWith('Other.Material');
            let best = exitCeiling(ctx.board.list(id, 3), ownSales, 0);
            if (material) best = exitCeiling(deps.fixedProductionOffersFor?.(id) || [], ownSales, best);
            if (!(best > 0)) continue;
            admitted.push({ recipe, count, id, ownSales, oldUnits, material, known: knownRecipes.has(Number(recipe.recipeId)),
                ceiling: positive(count * Math.max(best, positive(ctx.buyback(id))) * Number(recipe.successRate ?? 100) / 100) });
        }
        if (admitted.length > PRODUCER_PRICED) {
            admitted.sort((a, b) => b.ceiling - a.ceiling || Number(b.known) - Number(a.known) || a.recipe.recipeId - b.recipe.recipeId);
            admitted.length = PRODUCER_PRICED;
        }
        for (const { recipe, count, id, ownSales, oldUnits, material } of admitted) {
        const asks = ctx.board.list(id, SELL);
        const publicOffers = ctx.board.list(id, 3).slice(0, 5);
        const fixedOffers = material ? (deps.fixedProductionOffersFor?.(id) || []).slice(0, 5) : [];
        for (const offer of [...publicOffers, ...fixedOffers]) {
            if (!usableExit(offer, ownSales)) continue;
            const trip = ctx.trip?.details?.(offer.town);
            if (!trip?.known || ![trip.hours, trip.fees].every(value => Number.isFinite(value) && value >= 0)) continue;
            const fixed = offer.type === 'static';
            let exit = { conditional: offer.custodyPolicy === 1, price: offer.price, count: offer.count, offer };
            if (!fixed) exit = Price.prospectiveExit(state, exit, { board: ctx.board, persona: ctx.persona, timestamp });
            const forecast = exit.prospective || (!exit.conditional ? { known: true, applicableUnits: offer.count, willingUnits: offer.count } : null);
            if (!forecast?.known) continue;
            const competitors = fixed ? [] : asks.slice(0, 5).filter(line => Number(line.ownerId) !== Number(state.characterId));
            let cheaperUnits = 0;
            for (const line of competitors) if (!Number(line.enchant || 0) && line.price < offer.price) cheaperUnits += Number(line.count);
            if (!fixed && asks.length > 5 && asks[5].price < offer.price && cheaperUnits < forecast.applicableUnits) continue;
            const input = { ...forecast, cheaperUnits, price: offer.price, residualUnitValue: Number(exit.residualUnitValue ?? ctx.buyback(id)) };
            const before = Price.saleOutcome({ ...input, units: oldUnits });
            const after = Price.saleOutcome({ ...input, units: oldUnits + count });
            if (!before.known || !after.known || exit.trial && !(after.sold > before.sold)) continue;
            const gross = after.receipts + after.residualValue - before.receipts - before.residualValue;
            if (!(gross > 0)) continue;
            const inputPrice = [...(Profit.requirements(recipe) || [])]
                .reduce((sum, [id, amount]) => sum + amount * positive(price(id)), 0);
            const learningPrice = knownRecipes.has(Number(recipe.recipeId)) ? 0 : positive(price(recipe.recipeItemId));
            const proxy = gross * Number(recipe.successRate ?? 100) / 100 - inputPrice - learningPrice;
            // Independent price is a ranking proxy, not acquisition cost:
            // the bounded DAG can expose a cheaper farm/component craft.
            const previous = production.get(id);
            if (!previous || proxy > previous.proxy || proxy === previous.proxy && recipe.recipeId < previous.recipe.recipeId)
                production.set(id, { recipe, gross, proxy, inputPrice: inputPrice + learningPrice, town: offer.town, trip });
        }
        }
    }
    const producerFinalists = [...production.values()].sort((a, b) => b.proxy - a.proxy || a.recipe.recipeId - b.recipe.recipeId).slice(0, 3);
    const produced = new Set();
    for (const row of producerFinalists) {
        const id = Number(row.recipe.productId);
        if (produced.has(id) || produced.size >= 3) continue;
        const path = craftPath(row.recipe, id, 0, true);
        if (!path) continue;
        produced.add(id);
        root({ key: `resale:${id}`, need: 'power', object: { itemId: id, amount: Number(row.recipe.productCount || 1), kind: 'resale' },
            valueHours: row.gross / ctx.hourAdena, price: row.inputPrice,
            paths: [{ ...path, trial: true, repeatable: false, quoted: true,
                town: row.town, tripHours: row.trip.hours, tripFees: row.trip.fees }] });
    }
    // Paid enchant, SA and henna are objects of the same power queue.
    // Missing materials inherit that value; only a genuinely ready leaf applies.
    for (const improvement of invoke('GameServer/Bot/Economy/BotImprovementPolicy').opportunities(state, ctx)) {
        const materials = improvement.materials.map(material => ({ ...material, missing: Math.max(0,
            material.amount - positive(state.inventory?.[material.selfId]?.amount)) }));
        const requirements = materials.filter(material => material.missing > 0)
            .map(material => ({ key: itemNode(material.selfId), amount: material.missing }));
        if (requirements.some(row => !row.key)) continue;
        const ready = !requirements.length && positive(state.adena) >= positive(improvement.fee);
        root({ key: improvement.key, need: 'power', object: { ...improvement, kind: 'improvement' },
            valueHours: improvement.valueHours, price: improvement.price,
            paths: [{ activity: ready ? 'improving' : null, kind: improvement.kind,
                improvement, price: positive(improvement.fee), costHours: 1 / 3600,
                riskHours: improvement.riskHours || 0, requirements }] });
        for (const material of materials) values.set(material.selfId,
            positive(values.get(material.selfId)) + improvement.valueHours / Math.max(1, material.amount));
    }
    const candidates = [];
    const wornFor = wornReader(state), gainFor = gearGainReader(state, timestamp, ownBuild, magic, ctx.gearThreatMask ?? 3);
    const acquisitionAllowed = id => Sources.hasNonRaidSource(id)
        || positive(state.inventory?.[id]?.amount) > 0 || !!observedPurchase(id);
    for (const [slot, items] of gearCandidates(state, ctx, wornFor, acquisitionAllowed)) for (const item of items) {
        if (!Planner.considerable(item, state)) continue;
        const current = replacementWorn(wornFor, slot);
        if (Number(current?.selfId) === Number(item.selfId)) continue;
        const gain = gainFor(item);
        const currentPrice = current ? price(current.selfId) : 0;
        const market = invoke('GameServer/Bot/Economy/MarketCounters');
        const future = resale(price(item.selfId), { trend: market.moveOf(market.counterOf(item.selfId), ctx.timestamp),
            hours: horizon, understanding: ctx.persona.understanding, assertiveness: trait(ctx.persona, 'assertiveness'),
            caution: trait(ctx.persona, 'caution'), nextBuyerUse: price(item.selfId) * Math.min(1, gain.attack + gain.defence),
            npcFloor: ctx.buyback(item.selfId) });
        const value = (gain.attack + gain.defence * ctx.deathHours) * horizon
            + (ctx.hunt.perHour > 0 ? (future - currentPrice) / ctx.hunt.perHour : 0);
        if (!(value > 0) || !(price(item.selfId) > 0)) continue;
        candidates.push({ item, slot, value, gain });
    }
    // MVP-6: every nominated candidate is valued by the same path solver
    // the network uses, over its own scratch arena of item descriptors. A
    // forecast without a supplier no longer screens out a step now: the
    // fundable path wins its family, then benefit per effort.
    const admission = { candidates: 0, evaluations: 0, maxScratch: 0, rounds: 0, pending: [], admitted: [] };
    const solverOptions = { hourAdena: ctx.hourAdena, riskWeight: ctx.riskWeight, stockFor: ctx.stockFor || null,
        wallet: ctx.wallet ?? positive(state.adena), survivalReserve: ctx.survivalReserve };
    // A rare piece's status value is part of its gear root from the start,
    // so admission scores the value the network later reads.
    const rare = candidates.find(row => row.item && (ctx.board?.list(row.item.selfId, SELL)?.length || 0) <= 1);
    const real = nodes, gear = [];
    for (const candidate of candidates) {
        nodes = []; scratch = true; readScope = ctx.readScope?.open() || null;
        const key = itemNode(candidate.item.selfId);
        const keys = nodes.map(node => node.key);
        nodes = real; scratch = false; readScope = null; ctx.readScope?.close();
        if (!key) continue;
        const benefitPerHour = (candidate.gain.attack + candidate.gain.defence * ctx.deathHours) * powerWeight;
        gear.push({ candidate, keys, family: Equipment.isWeaponSlot(candidate.slot) ? 'weapon' : candidate.slot,
            node: { key: `power:${candidate.item.selfId}:${candidate.slot}`, need: 'power',
                object: { itemId: Number(candidate.item.selfId), slot: candidate.slot }, price: price(candidate.item.selfId),
                valueHours: candidate.value * powerWeight + (candidate === rare ? rare.value * statusWeight : 0), benefitPerHour, horizonHours: horizon,
                paths: [{ requirements: [{ key, amount: 1 }] }] } });
        admission.maxScratch = Math.max(admission.maxScratch, keys.length);
    }
    admission.candidates = gear.length;
    // A throw of the solver's own bounds or an arena over forty descriptors
    // is `limit`: unresolved, never an unavailable item or a zero cost.
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
            // A path whose benefit cannot start inside the horizon is not a
            // missing path: it waits, counted, for money or a cheaper source.
            row.status = !wish.plan ? 'no_path' : wish.valueHours > 0 ? 'evaluated'
                : wish.fullValueHours > 0 ? 'not_ready' : 'no_path';
        } catch (error) {
            if (!SOLVER_LIMITS.has(error?.message)) throw error;
        }
    };
    const score = row => row.wish.valueHours / Math.max(1 / 3600, row.wish.effort);
    const before = (a, b) => score(a) > score(b) || score(a) === score(b) && a.node.key < b.node.key;
    const winners = open => {
        const best = new Map();
        for (const row of gear) {
            if (row.status !== 'evaluated' || !open(row.family)) continue;
            const held = best.get(row.family);
            const fundable = Number(Network.fundable(row.wish)), heldFundable = held ? Number(Network.fundable(held.wish)) : -1;
            if (!held || fundable > heldFundable || fundable === heldFundable && before(row, held)) best.set(row.family, row);
        }
        return [...best.values()].sort((a, b) => before(a, b) ? -1 : before(b, a) ? 1 : 0);
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
            rows.sort((a, b) => b.base.fullValueHours / Math.max(1, b.base.price) - a.base.fullValueHours / Math.max(1, a.base.price)
                || a.base.key.localeCompare(b.base.key));
            used = new Map();
            for (const { row, solver } of rows) {
                const wish = { key: row.node.key, need: row.node.need, object: row.node.object };
                const claims = solver.allocate(wish, used);
                if (wish.valueHours > 0) used = claims;
                row.wish = wish; row.claims = wish.plan ? claims : null;
                row.status = !wish.plan ? 'no_path' : wish.valueHours > 0 ? 'evaluated'
                    : wish.fullValueHours > 0 ? 'not_ready' : 'no_path';
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
    for (const book of invoke('GameServer/Skills/SkillBookCatalog').missingBooks(state)) {
        if (nodes.length >= 36) break;
        const gain = Profile.gainFor(ownBuild, `${magic ? 'm' : 'p'}:skill:${book.skillId}:${book.level}`, () => {
            if (!beforeBook) {
                beforeBook = Profile.profileFor(state, timestamp, Profile.buildOptions(ownBuild, timestamp));
                beforeBookRate = attackRate(beforeBook);
            }
            return skillGain(state, book, beforeBook, beforeBookRate, timestamp, ownBuild);
        });
        const value = (gain.attack + gain.defence * ctx.deathHours) * horizon * powerWeight;
        if (!(value > 0) || !(price(book.selfId) > 0)) continue;
        const key = itemNode(book.selfId); if (!key) continue;
        values.set(book.selfId, value);
        root({ key: `book:${book.skillId}`, need: 'power', object: { itemId: book.selfId, skillId: book.skillId, kind: 'book' },
            price: price(book.selfId), valueHours: value, benefitPerHour: (gain.attack + gain.defence * ctx.deathHours) * powerWeight,
            horizonHours: horizon, paths: [{ requirements: [{ key, amount: 1 }] }] });
    }
    if (rare && statusWeight > 0) {
        const held = admittedGear.some(row => row.node.object.itemId === Number(rare.item.selfId));
        const key = !held && itemNode(rare.item.selfId);
        if (key) root({ key: `status:${rare.item.selfId}`, need: 'status', object: { itemId: rare.item.selfId },
            price: price(rare.item.selfId), valueHours: rare.value * statusWeight,
            paths: [{ requirements: [{ key, amount: 1 }] }] });
    }
    if (ctx.hunt.expPerHour > 0 && state.level < invoke('GameServer/Progression/ProgressionCap').effectiveLevelCap()) {
        root({ key: `level:${state.level + 1}`, need: 'power', object: { level: state.level + 1 },
            valueHours: powerWeight, price: 0, paths: [{ kind: 'experience', activity: 'hunting',
                spotId: ctx.hunt.progressSpotId || ctx.bestSpotId, costHours: 1, riskHours: ctx.expectedDeathHours }] });
    }
    for (const kind of ['shots', 'potions', 'scrolls']) {
        const stock = ctx.stock(kind);
        if (Diagnostics.active() && Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
            caller: deps.caller || 'wish_provider', trigger: 'projection_build',
            phase: 'wish_need', reason: !(stock?.missing > 0) ? 'target_satisfied' : !(stock.unitPrice > 0)
                ? 'unknown_price' : !(stock.benefitHours > 0) ? 'no_expected_benefit' : 'stock_shortfall',
            decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
            wishKey: `stock:${kind}`, item: stock?.itemId, target: stock?.target,
            owned: stock?.current, missing: stock?.missing, requested: stock?.missing,
            unitPrice: stock?.unitPrice, valueHours: stock?.benefitHours, wallet: state.adena });
        if (!(stock?.missing > 0) || !(stock.unitPrice > 0) || !(stock.benefitHours > 0)) continue;
        const key = itemNode(stock.itemId);
        if (!key) continue;
        root({ key: `stock:${kind}`, need: 'power', object: { itemId: stock.itemId, amount: stock.missing, kind },
            valueHours: stock.benefitHours * powerWeight, price: stock.missing * stock.unitPrice,
            // The survival tranche is the kit's cost (kitCost), not this wish:
            // gross = held units + missing, so allocation leaves `missing`.
            paths: [{ requirements: [{ key, amount: stock.missing }],
                grossRequirements: [{ key, amount: stock.missing
                    + Math.max(0, Number(state.inventory?.[stock.itemId]?.amount) || 0) }] }] });
        values.set(stock.itemId, stock.benefitHours / stock.missing);
    }
    // Concrete remembered people, not persona-labelled lifelong goals.
    const relations = deps.memory?.relations || state.stats?.relations || [];
    const friend = relations.find(row => Number(row.trust ?? row.affinity ?? 0) > 0);
    if (friend) root({ key: `care:${friend.targetId}`, need: 'care', object: { targetId: friend.targetId },
        valueHours: trait(ctx.persona, 'empathy') * trait(ctx.persona, 'sociability') * positive(friend.trust ?? friend.affinity),
        price: 0, paths: [{ activity: 'helping', targetId: friend.targetId, costHours: 1 }] });
    const enemy = relations.find(row => Number(row.hostility ?? row.anger ?? 0) > 0);
    if (enemy) root({ key: `scores:${enemy.targetId}`, need: 'scores', object: { targetId: enemy.targetId },
        valueHours: positive(enemy.hostility ?? enemy.anger) * trait(ctx.persona, 'assertiveness'), price: 0,
        paths: [{ activity: 'pvp', targetId: enemy.targetId, costHours: 1, riskHours: ctx.deathHours + ctx.karmaHours }] });
    // Only known concrete items enter the small resale watch list. The
    // board is queried by item, never by copying every owner's offers.
    const known = new Set([...candidates.map(row => Number(row.item.selfId)), ...rows(state).map(row => Number(row.selfId))]);
    const resaleWishes = [];
    for (const id of known) {
        if (!Sources.hasSource(id)) continue;
        if (positive(state.inventory?.[id]?.amount)) continue;
        const ask = ctx.board?.first(id, SELL, { excludeOwner: state.characterId });
        if (!(ask?.price > 0)) continue;
        const Market = invoke('GameServer/Bot/Economy/MarketCounters');
        const future = resale(price(id), { trend: Market.moveOf(Market.counterOf(id), ctx.timestamp),
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
        if (nodes.length + row.keys.filter(key => !nodes.some(node => node.key === key)).length + 1 > 64) {
            admission.pending.push({ key: row.node.key, reason: 'node_limit' });
            continue;
        }
        for (const key of row.keys) include(key);
        values.set(Number(row.candidate.item.selfId), row.candidate.value * powerWeight);
        root(row.node);
    }
    for (const node of deps.nodes || []) { if (node.need) root(node); else add(node); }
    const moneyPaths = ctx.hunt.perHour > 0 ? [{ activity: 'hunting', kind: 'money',
        spotId: ctx.bestSpotId, incomePerHour: ctx.hunt.perHour, riskHours: ctx.expectedDeathHours }] : [];
    const sale = invoke('GameServer/Bot/Economy/ItemDisposition').saleCandidates(state, {
        preparedReservations: deps.saleReservations,
        keptAmounts: { ...invoke('GameServer/Inventory/ShotStock').keptAmounts(state, ctx),
            ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: ctx.stock('potions').target }),
            ...invoke('GameServer/Bot/Travel/ScrollStock').keptAmounts(state) }
    }).filter(row => row.npcComparable && !values.has(Number(row.selfId)));
    const saleValue = sale.reduce((sum, row) => sum + ctx.buyback(row.selfId) * row.count, 0);
    if (saleValue > 0) {
        const town = state.stats?.shopTown?.town || invoke('GameServer/Bot/Economy/MarketTownPolicy').targetTownForItems(state, sale, {
            findSpot: id => require('../AI/SpotIndex').spotById(deps.spots, id)
        });
        const route = ctx.trip?.details?.(town);
        if (route?.known && route.fees <= Number(state.adena || 0)
            && require('../Population/ColdOccupationSources').hasNpcSellerInTown(town)) {
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
    roots.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
    const cut = Network.admitRoots(roots, byKey, { rootLimit: WISH_ROOTS, nodeLimit: Network.MAX_NODES });
    admission.pending.push(...cut.pending);
    for (const [key, scope] of builtBy) if (cut.kept.has(key)) ctx.readScope.keep(scope);
    if (Diagnostics.active()) {
        Diagnostics.count('provider', 'admission', 'candidate', admission.candidates);
        Diagnostics.count('provider', 'admission', 'evaluation', admission.evaluations);
        Diagnostics.count('provider', 'admission', 'round', admission.rounds);
        Diagnostics.count('provider', 'admission', 'gear_root', admittedGear.length);
        for (const row of admission.pending) Diagnostics.count('provider', 'admission_pending', row.reason);
    }
    return { nodes: nodes.filter(node => cut.kept.has(node.key)), roots: cut.roots, values, moneyPaths, horizon, admission };
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
            || Number(row.recipeId) !== Number(recipe.recipeId) || !(Number(row.capacityBatches) > 0)
            || !Number.isSafeInteger(Number(row.price)) || Number(row.price) < 0
            || ![row.loc?.locX, row.loc?.locY, row.loc?.locZ].every(Number.isFinite)) continue;
        const route = trip.details(row.townName);
        if (!route?.known || !Number.isFinite(route.hours) || !Number.isFinite(route.fees)) continue;
        const cost = Number(row.price) + route.fees + route.hours * Number(ctx.hourAdena || ctx.hunt?.perHour || 0);
        if (!best || cost < best.cost || cost === best.cost && Number(row.characterId) < best.characterId)
            best = { ...row, characterId: Number(row.characterId), cost,
                tripHours: route.hours, tripFees: route.fees };
    }
    return best;
}
// Translate the chosen shared wish into the existing personal equipment craft
// owner. This runs in the worker on the already built graph, not a second plan.
function personalCraftPlan(state, context) {
    const leaf = context?.network?.activity;
    if (!leaf || !leaf.rootKey || !['crafting', 'shopping', 'hunting'].includes(leaf.activity)) return null;
    const wish = context.network.queue.find(row => row.key === leaf.rootKey);
    const targetId = Number(wish?.object?.itemId);
    if (!targetId || !leaf.rootKey.startsWith('power:')) return null;
    const providers = {}, components = {}, visited = new Set();
    let finalRecipe = null;
    const visit = (plan, depth = 0) => {
        if (!plan || depth > 8 || visited.has(plan)) return;
        visited.add(plan);
        if (plan.kind === 'craft' && plan.workshop) {
            const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(plan.recipeId);
            if (!recipe) return;
            if (Number(recipe.productId) === targetId) finalRecipe = recipe;
            components[recipe.productId] = Number(recipe.recipeId);
            providers[recipe.recipeId] = { workshop: true, characterId: Number(plan.workshop.characterId),
                price: Number(plan.workshop.price),
                loc: plan.workshop.loc, townName: plan.workshop.townName, known: true };
        }
        for (const row of plan.requirements || []) visit(row.plan || context.network.plans.get(row.key), depth + 1);
    };
    visit(wish?.plan);
    if (!finalRecipe) return null;
    return { strategy: 'craft', status: 'active',
        target: { selfId: targetId },
        ...(leaf.activity === 'hunting' ? { next: { spotId: leaf.spotId, npcId: leaf.npcId,
            selfId: Number(leaf.itemId || leaf.object), sourceKind: leaf.kind } } : {}),
        recipeId: Number(finalRecipe.recipeId), outputAmount: Number(wish.object.amount || 1),
        materials: finalRecipe.materials.map(row => ({ ...row })), craftProviders: providers,
        componentRecipes: components, valueRate: Number(wish.ratio || 0), source: 'wish_network' };
}
module.exports = { GEAR_FINALISTS_PER_SLOT, PRODUCER_PRICED, recipeIds, knownWorkshop, personalCraftPlan, build, gearCandidates, gearGain, skillGain, attackRate, rotationRate, worn };
