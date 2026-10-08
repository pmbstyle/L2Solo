'use strict';

const { trait, stageHours, resale } = require('./EconomicValuation');
const { SELL } = require('../../AfkTrade/BoardIndex');
let catalogSource = null;
const kits = new Map();

// Compatibility is game data shared by class/role, not an actor's prescribed
// purchase. Keep every item (including SA and set parts) in this immutable view.
// Only a review's finalists are bounded; prices, holdings and funding are live.
const GEAR_FINALISTS_PER_SLOT = 8;
function gearCandidates(state, ctx = null) {
    const Data = invoke('GameServer/DataCache');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    if (catalogSource !== Data.items) { catalogSource = Data.items; kits.clear(); }
    const role = Planner.roleFor(state);
    const classId = Number(state.stats?.classId || state.classId || 0);
    const key = `${classId}:${role}`;
    if (!kits.has(key)) {
        const slots = new Map(), empty = { classId, stats: { classId }, inventory: {} };
        for (const item of Data.items || []) {
            if (!Planner.suitable(item, empty, role, String(item.etc?.rank || 'none'))) continue;
            const slot = Number(item.etc?.slot);
            if (!slots.has(slot)) slots.set(slot, []);
            slots.get(slot).push(item);
        }
        for (const list of slots.values()) list.sort((a, b) =>
            Planner.itemScore(b, role, classId) - Planner.itemScore(a, role, classId)
            || Number(a.template.price) - Number(b.template.price) || Number(a.selfId) - Number(b.selfId));
        kits.set(key, slots);
    }
    const ranks = ['none', 'd', 'c', 'b', 'a', 's'];
    const maxRank = ranks.indexOf(Planner.gradeForLevel(state.level));
    const result = new Map();
    const budget = Math.max(0, Number(state.adena || 0) - Number(ctx?.survivalReserve || 0));
    const target = Number(state.stats?.equipmentPlan?.target?.selfId || 0);
    const held = String(state.stats?.wishFocus?.[0] || '').match(/^power:(\d+):/);
    for (const [slot, list] of kits.get(key)) {
        const allowed = list.filter(item => ranks.indexOf(String(item.etc?.rank || 'none')) <= maxRank);
        // The exported game-data view is also used to construct fixed kits;
        // it has no actor choice or expensive build evaluation.
        if (!ctx) { result.set(slot, allowed); continue; }
        const current = [7, 14].includes(slot) ? worn(state, 7) || worn(state, 14) : worn(state, slot);
        const owned = current && Data.items && require('../../Item/ItemTemplateIndex').find(Data.items, current.selfId);
        const before = owned ? Planner.itemScore(owned, role, classId) : 0;
        const efficientByRank = new Map();
        let affordable = null, above = null, retained = null;
        const cheaper = (a, b) => !b || a.price < b.price || a.price === b.price && a.item.selfId < b.item.selfId;
        const better = (a, b) => !b || a.ratio > b.ratio || a.ratio === b.ratio && cheaper(a, b);
        for (const item of allowed) {
            const price = Number(ctx.price(item.selfId));
            if (!(price > 0) || Number(current?.selfId) === Number(item.selfId)) continue;
            const score = Planner.itemScore(item, role, classId);
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
function worn(state, slot) {
    return rows(state).find(row => (row.equipped || row.equippedCount > 0)
        && (Number(row.slot) === slot || row.equippedSlots?.includes(slot))) || null;
}
// What wearing `item` in its slot adds to the bot's build: remembered per
// build and item (design 16.5), so a later review of the same build reuses it.
function gearGain(state, item, timestamp = Date.now(), build = null) {
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const caster = require('./BotImprovementPolicy').isCaster(state);
    build = build || Profile.buildGainsFor(state, timestamp);
    return Profile.gainFor(build, `${caster ? 'm' : 'p'}:gear:${item.selfId}:${item.etc.slot}`, () => {
        const before = Profile.powerNumbers(build);
        const inventory = Object.fromEntries(Object.entries(state.inventory || {}).map(([key, row]) => [key,
            Number(row.slot) === Number(item.etc.slot) ? { ...row, equipped: false, equippedCount: 0, equippedSlots: [] } : row]));
        inventory[item.selfId] = { selfId: Number(item.selfId), amount: 1, equipped: true,
            equippedCount: 1, slot: Number(item.etc.slot), enchant: 0 };
        const after = Profile.powerFor({ ...state, inventory }, timestamp, Profile.buildOptions(build, timestamp));
        const attack = caster ? 'mAtk' : 'pAtk';
        const attackGain = Math.max(0, Number(after[attack]) / Math.max(1, Number(before[attack])) - 1);
        const defenceGain = Math.max(0, 1 - Number(before.pDef) / Math.max(1, Number(after.pDef)));
        const magicGain = Math.max(0, 1 - Number(before.mDef) / Math.max(1, Number(after.mDef)));
        return { attack: attackGain, defence: Math.max(defenceGain, magicGain) };
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
    return invoke('GameServer/Bot/AI/GearAcquisitionPlanner').withReadiness(() => buildProjection(state, ctx, deps));
}
function buildProjection(state, ctx, deps) {
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const timestamp = ctx.timestamp ?? Date.now();
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const ownBuild = Profile.buildGainsFor(state, timestamp);
    let beforeBook = null, beforeBookRate = null;
    const magic = require('./BotImprovementPolicy').isCaster(state);
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const nodes = [], roots = [], values = new Map();
    const add = node => { if (nodes.length >= 64 || nodes.some(row => row.key === node.key)) return false;
        nodes.push(node); return true; };
    const root = node => { if (add(node)) roots.push(node.key); };
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
    const knownRecipes = new Set([...(state.stats?.recipes || state.recipes || []), ...(state.stats?.workshop?.entries || [])]
        .map(entry => Number(entry?.recipeId ?? entry)));
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
            const counts = source.spot.npcEntries || [];
            const total = counts.reduce((sum, npc) => sum + Math.max(1, Number(npc.count || 1)), 0);
            const own = counts.filter(npc => Number(npc.selfId) === Number(source.reward.selfId))
                .reduce((sum, npc) => sum + Math.max(1, Number(npc.count || 1)), 0);
            if (!sourceValues.has(source.spot)) sourceValues.set(source.spot, ctx.spotValue(source.spot));
            const rate = sourceValues.get(source.spot);
            const yieldPerKill = Planner.itemDropYield(source.reward, id, source.kind,
                { npcLevel: source.npcLevel, killerLevel: state.level }).expectedYield;
            const perHour = positive(rate?.kills) * positive(yieldPerKill) * own / Math.max(1, total);
            if (perHour > 0 && (!best || perHour > best.perHour)) best = { source, perHour };
        }
        return best ? { kind: best.source.kind, activity: 'hunting', costHours: 1 / best.perHour,
            spotId: best.source.spot.id, npcId: best.source.reward.selfId, itemId: Number(id), amount: 1 } : null;
    };
    const itemNode = (id, depth = 0) => {
        const key = `item:${id}`;
        if (nodes.some(node => node.key === key)) return key;
        if (depth >= 3 || nodes.length >= 36 || preparingItems.has(key)) return null;
        preparingItems.add(key);
        const observed = observedPurchase(id);
        const paths = [{ kind: 'buy', activity: 'shopping', price: price(id), itemId: Number(id), amount: 1,
            available: !!observed || price(id) > 0, executable: !!observed,
            ...(observed || { availableUnits: 0 }) }];
        const drop = sourcePath(id);
        if (drop) paths.push(drop);
        const crystal = invoke('GameServer/Bot/Economy/BotImprovementPolicy').crystalPath(state, id, ctx, deps.spots || []);
        if (crystal) paths.push(crystal);
        const recipe = Recipes.resolveByProductId(id) || invoke('GameServer/Items/C4DualSwordCombinations').loadRecipes()
            .find(row => Number(row.productId) === Number(id));
        if (recipe && (recipe.kind === 'dual_sword_combine'
            || invoke('GameServer/Bot/Economy/CraftShopService').canCraft(state, recipe))
            && nodes.length + recipe.materials.length < 36) {
            const combined = new Map();
            for (const material of recipe.materials) combined.set(Number(material.selfId),
                (combined.get(Number(material.selfId)) || 0) + Number(material.amount));
            const freeAmount = require('./WealthCraftDecision').freeAmount;
            const requirements = [];
            let ownInputOpportunityValue = 0;
            for (const [selfId, amount] of combined) {
                const owned = Math.min(amount, freeAmount(state, state.inventory?.[selfId] || {}));
                ownInputOpportunityValue += owned * positive(price(selfId));
                const missing = amount - owned;
                if (missing > 0) requirements.push({ key: itemNode(selfId, depth + 1), amount: missing });
            }
            const learned = recipe.kind === 'dual_sword_combine' || knownRecipes.has(Number(recipe.recipeId));
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
            if (!learned && !ownedScroll && scrollAvailable) requirements.push({ key: itemNode(recipe.recipeItemId, depth + 1), amount: 1 });
            // A physical attempt consumes one whole batch, including failure.
            // Its chance reduces the finite root benefit once; inputs are not
            // divided by expected yield. No imagined commissioned service.
            const regen = Number(invoke('GameServer/Bot/Population/BackgroundResolver').coldRestRegenPerTick(state).mp);
            const recoveryHours = positive(recipe.mpCost) > 0 && regen > 0 ? positive(recipe.mpCost) / regen * 3 / 3600 : NaN;
            const cycleHours = recipe.kind === 'dual_sword_combine' ? Number(recipe.costHours || 1 / 3600) : recoveryHours;
            if (scrollAvailable && Number.isFinite(cycleHours) && cycleHours > 0 && requirements.every(row => row.key)) paths.push({ kind: 'craft', activity: 'crafting',
                itemId: Number(id), recipeId: recipe.recipeId,
                requiresRecipeLearning: !learned, successProbability: Number(recipe.successRate ?? 100) / 100,
                ownInputOpportunityValue, costHours: cycleHours,
                requirements });
        }
        add({ key, object: Number(id), price: price(id), paths: paths.slice(0, 3) });
        preparingItems.delete(key);
        return key;
    };
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
    for (const [slot, items] of gearCandidates(state, ctx)) for (const item of items) {
        if (!Planner.considerable(item, state)) continue;
        if (Number(worn(state, slot)?.selfId) === Number(item.selfId)) continue;
        const gain = gearGain(state, item, timestamp, ownBuild);
        const current = worn(state, slot);
        const currentPrice = current ? price(current.selfId) : 0;
        const market = invoke('GameServer/Bot/Economy/MarketCounters');
        const future = resale(price(item.selfId), { trend: market.moveOf(market.counterOf(item.selfId), ctx.timestamp),
            hours: horizon, understanding: ctx.persona.understanding, assertiveness: trait(ctx.persona, 'assertiveness'),
            caution: trait(ctx.persona, 'caution'), nextBuyerUse: price(item.selfId) * Math.min(1, gain.attack + gain.defence),
            npcFloor: ctx.buyback(item.selfId) });
        const value = (gain.attack + gain.defence * ctx.deathHours) * horizon
            + (ctx.hunt.perHour > 0 ? (future - currentPrice) / ctx.hunt.perHour : 0);
        if (!(value > 0) || !(price(item.selfId) > 0)) continue;
        const observed = observedPurchase(item.selfId);
        const fullPrice = observed ? observed.price + observed.tripFees + observed.tripHours * ctx.hunt.perHour : price(item.selfId);
        candidates.push({ item, slot, value, ratio: value / Math.max(1, fullPrice), gain, observed });
    }
    // Within a slot an executable quote cannot be screened out by a cheap
    // forecast with no supplier. Different slots still use shared utility.
    const bySlot = new Map();
    for (const candidate of candidates) {
        const best = bySlot.get(candidate.slot);
        if (!best || Number(!!candidate.observed) > Number(!!best.observed)
            || !!candidate.observed === !!best.observed && candidate.ratio > best.ratio) bySlot.set(candidate.slot, candidate);
    }
    const finalists = [...bySlot.values()].sort((a, b) => b.ratio - a.ratio || a.item.selfId - b.item.selfId);
    // Distinct slots, including each jewellery side. Dual blades stay a single
    // product requirement; its native combination is one acquisition path.
    const slots = new Set();
    for (const candidate of finalists) {
        if (slots.has(candidate.slot) || slots.size >= 4) continue;
        const key = itemNode(candidate.item.selfId);
        if (!key) continue;
        slots.add(candidate.slot);
        values.set(Number(candidate.item.selfId), candidate.value * powerWeight);
        root({ key: `power:${candidate.item.selfId}:${candidate.slot}`, need: 'power',
            object: { itemId: Number(candidate.item.selfId), slot: candidate.slot }, price: price(candidate.item.selfId),
            valueHours: candidate.value * powerWeight, paths: [{ requirements: [{ key, amount: 1 }] }] });
    }
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
            price: price(book.selfId), valueHours: value, paths: [{ requirements: [{ key, amount: 1 }] }] });
    }
    const rare = candidates.find(row => row.item && (ctx.board?.list(row.item.selfId, SELL)?.length || 0) <= 1);
    if (rare && statusWeight > 0) {
        const held = nodes.find(node => node.need && node.object?.itemId === Number(rare.item.selfId));
        if (held) held.valueHours += rare.value * statusWeight;
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
    for (const kind of ['shots', 'potions']) {
        const stock = ctx.stock(kind);
        if (!(stock?.missing > 0) || !(stock.unitPrice > 0) || !(stock.benefitHours > 0)) continue;
        const key = itemNode(stock.itemId);
        if (!key) continue;
        root({ key: `stock:${kind}`, need: 'power', object: { itemId: stock.itemId, amount: stock.missing, kind },
            valueHours: stock.benefitHours * powerWeight, price: stock.missing * stock.unitPrice,
            paths: [{ requirements: [{ key, amount: stock.missing }] }] });
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
    for (const node of deps.nodes || []) { if (node.need) root(node); else add(node); }
    const moneyPaths = ctx.hunt.perHour > 0 ? [{ activity: 'hunting', kind: 'money',
        spotId: ctx.bestSpotId, incomePerHour: ctx.hunt.perHour, riskHours: ctx.expectedDeathHours }] : [];
    const protectedIds = new Set([57, 5575, ctx.stock('shots').itemId, ctx.stock('potions').itemId]);
    const sale = rows(state).filter(row => !row.equipped && !row.equippedCount && !values.has(Number(row.selfId))
        && !protectedIds.has(Number(row.selfId)) && !/quest/i.test(String(row.kind || ''))
        && !row.starterMobLootAmount && Number(row.amount) > 0);
    const saleValue = sale.reduce((sum, row) => sum + ctx.buyback(row.selfId) * row.amount, 0);
    if (saleValue > 0) moneyPaths.push({ activity: 'selling', kind: 'liquidate', incomePerHour: saleValue,
        costHours: 1, items: sale.map(row => row.selfId) });
    // External game providers compete by the same value, rather than by
    // arriving after twelve preassigned gear slots.
    const byKey = new Map(nodes.map(node => [node.key, node]));
    const rank = key => { const node = byKey.get(key); return positive(node.valueHours)
        / Math.max(1 / 3600, positive(node.price) / Math.max(1, ctx.hunt.perHour) + positive(node.costHours)); };
    roots.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
    roots.length = Math.min(12, roots.length);
    const reachable = () => {
        const seen = new Set();
        const visit = key => { if (seen.has(key)) return; seen.add(key);
            for (const path of byKey.get(key)?.paths || []) for (const requirement of path.requirements || []) visit(requirement.key); };
        roots.forEach(visit); return seen;
    };
    let kept = reachable();
    while (kept.size > 40 && roots.length) { roots.pop(); kept = reachable(); }
    return { nodes: nodes.filter(node => kept.has(node.key)), roots, values, moneyPaths, horizon };
}
module.exports = { GEAR_FINALISTS_PER_SLOT, build, gearCandidates, gearGain, skillGain, attackRate, rotationRate, worn };
