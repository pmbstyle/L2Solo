'use strict';

const { trait, stageHours, resale } = require('./EconomicValuation');
const { SELL } = require('../../AfkTrade/BoardIndex');
let catalogSource = null;
const kits = new Map();

// One immutable game-data view by class/grade/slot. It is shared by every
// actor, and rebuilt only if the native item catalogue itself is replaced.
function gearCandidates(state) {
    const Data = invoke('GameServer/DataCache');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    if (catalogSource !== Data.items) { catalogSource = Data.items; kits.clear(); }
    const role = Planner.roleFor(state), grade = Planner.gradeForLevel(state.level);
    const classId = Number(state.stats?.classId || state.classId || 0);
    const key = `${classId}:${role}:${grade}`;
    if (!kits.has(key)) {
        const slots = new Map();
        const empty = { ...state, inventory: {} };
        for (const item of Data.items || []) {
            if (!Planner.suitable(item, empty, role, grade)) continue;
            const slot = Number(item.etc?.slot);
            if (!slots.has(slot)) slots.set(slot, []);
            slots.get(slot).push(item);
        }
        for (const [slot, rows] of slots) slots.set(slot, rows.sort((a, b) =>
            Planner.itemScore(b, role, classId) - Planner.itemScore(a, role, classId)
            || Number(a.template.price) - Number(b.template.price)).slice(0, 3));
        kits.set(key, slots);
    }
    return kits.get(key);
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
    const caster = ['mage', 'healer', 'buffer', 'nuker', 'summoner'].includes(invoke('GameServer/Bot/AI/GearAcquisitionPlanner').roleFor(state));
    build = build || Profile.buildGainsFor(state, timestamp);
    return Profile.gainFor(build, `${caster ? 'm' : 'p'}:gear:${item.selfId}:${item.etc.slot}`, () => {
        const before = build.power;
        const inventory = Object.fromEntries(Object.entries(state.inventory || {}).map(([key, row]) => [key,
            Number(row.slot) === Number(item.etc.slot) ? { ...row, equipped: false, equippedCount: 0, equippedSlots: [] } : row]));
        inventory[item.selfId] = { selfId: Number(item.selfId), amount: 1, equipped: true,
            equippedCount: 1, slot: Number(item.etc.slot), enchant: 0 };
        const after = Profile.powerFor({ ...state, inventory }, timestamp);
        const attack = caster ? 'mAtk' : 'pAtk';
        const attackGain = Math.max(0, Number(after[attack]) / Math.max(1, Number(before[attack])) - 1);
        const defenceGain = Math.max(0, 1 - Number(before.pDef) / Math.max(1, Number(after.pDef)));
        const magicGain = Math.max(0, 1 - Number(before.mDef) / Math.max(1, Number(after.mDef)));
        return { attack: attackGain, defence: Math.max(defenceGain, magicGain) };
    });
}
function skillGain(state, book) {
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const original = state.stats?.coldCombat || {};
    const skills = Profile.skillSnapshotsFromRecords([...original.skills || [], { selfId: book.skillId, level: book.level }]);
    const after = Profile.profileFor({ ...state, stats: { ...state.stats, coldCombat: { ...original, skills } } });
    const before = Profile.profileFor(state);
    const rate = profile => {
        const Formulas = invoke('GameServer/Formulas');
        const base = Formulas.calcPhysicalDamage(profile.pAtk, 0, profile.pDef, 0, { rng: () => 0.5 })
            * profile.atkSpd / 1000;
        return Math.max(base, ...Profile.offensiveSkills(profile).map(skill => {
            const damage = skill.spell ? Formulas.calcMagicDamage(profile.mAtk, Math.max(1, skill.power), profile.mDef)
                : Formulas.calcPhysicalDamage(profile.pAtk, 0, profile.pDef, skill.power, { rng: () => 0.5 });
            const seconds = Math.max(0.1, Number(skill.hitTime || 1000) / 1000 * (skill.spell ? 333 / profile.castSpd : 1)
                + Number(skill.reuse || 0) / 1000);
            return damage / seconds;
        }));
    };
    return { attack: Math.max(0, rate(after) / Math.max(0.001, rate(before)) - 1),
        defence: Math.max(0, 1 - before.pDef / after.pDef, 1 - before.mDef / after.mDef) };
}
function build(state, ctx, deps = {}) {
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const timestamp = ctx.timestamp ?? Date.now();
    const ownBuild = invoke('GameServer/Bot/Population/ColdCombatProfile').buildGainsFor(state, timestamp);
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
    const sourcePath = id => {
        let best = null;
        for (const source of sourceIndex?.get(Number(id)) || []) {
            if (source.spot.raidBoss || (source.kind === 'spoil' && !invoke('GameServer/Bot/AI/BotRoles').isSpoiler(state))) continue;
            if (!Planner.soloSafeForSource(state, source)) continue;
            const counts = source.spot.npcEntries || [];
            const total = counts.reduce((sum, npc) => sum + Math.max(1, Number(npc.count || 1)), 0);
            const own = counts.filter(npc => Number(npc.selfId) === Number(source.reward.selfId))
                .reduce((sum, npc) => sum + Math.max(1, Number(npc.count || 1)), 0);
            const rate = ctx.spotValue(source.spot);
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
        if (depth >= 3 || nodes.length >= 36) return null;
        const paths = [{ kind: 'buy', activity: 'shopping', price: price(id), itemId: Number(id), amount: 1,
            available: price(id) > 0 }];
        const drop = sourcePath(id);
        if (drop) paths.push(drop);
        const crystal = invoke('GameServer/Bot/Economy/BotImprovementPolicy').crystalPath(state, id, ctx, deps.spots || []);
        if (crystal) paths.push(crystal);
        const recipe = Recipes.resolveByProductId(id) || invoke('GameServer/Items/C4DualSwordCombinations').loadRecipes()
            .find(row => Number(row.productId) === Number(id));
        if (recipe && (recipe.kind === 'dual_sword_combine'
            || invoke('GameServer/Bot/Economy/CraftShopService').canCraft(state, recipe))
            && nodes.length + recipe.materials.length < 36) {
            const requirements = recipe.materials.map(material => ({ material, amount: Math.max(0,
                material.amount / Math.max(0.01, recipe.productCount * (Number(recipe.successRate ?? 100) / 100)) - positive(state.inventory?.[material.selfId]?.amount)) }))
                .filter(row => row.amount > 0)
                .map(row => ({ key: itemNode(row.material.selfId, depth + 1), amount: row.amount }));
            if (requirements.every(row => row.key)) paths.push({ kind: 'craft', activity: 'crafting',
                itemId: Number(id), recipeId: recipe.recipeId,
                costHours: positive(recipe.mpCost) / Math.max(1, invoke('GameServer/Bot/Population/BackgroundResolver').coldRestRegenPerTick(state).mp || 0) * 3 / 3600,
                requirements });
        }
        add({ key, object: Number(id), price: price(id), paths: paths.slice(0, 3) });
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
    for (const [slot, items] of gearCandidates(state)) for (const item of items) {
        if (!Planner.suitable(item, state, Planner.roleFor(state), Planner.gradeForLevel(state.level))) continue;
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
        candidates.push({ item, slot, value, ratio: value / price(item.selfId), gain });
    }
    candidates.sort((a, b) => b.ratio - a.ratio || a.item.selfId - b.item.selfId);
    // Distinct slots, including each jewellery side. Dual blades stay a single
    // product requirement; its native combination is one acquisition path.
    const slots = new Set();
    for (const candidate of candidates) {
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
        const gain = skillGain(state, book);
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
    const status = deps.productionStatus;
    if (Number.isFinite(status?.incomePerHour) && status.incomePerHour >= 0
        && Number.isFinite(status.nextIncomePerHour) && status.nextIncomePerHour > status.incomePerHour) {
        const hours = horizon * (status.nextIncomePerHour - status.incomePerHour) / status.nextIncomePerHour * statusWeight;
        root({key:'status:producer',need:'status',object:{kind:'producer',rank:status.rank},valueHours:hours,price:0,
            paths:[{activity:'crafting',kind:'producer_status',costHours:horizon,available:false}]});
    }
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
module.exports = { build, gearCandidates, gearGain, skillGain, worn };
