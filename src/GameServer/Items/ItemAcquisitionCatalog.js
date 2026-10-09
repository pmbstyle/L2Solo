'use strict';

// Origin permission only: skills, funds, world cap and personal knowledge stay
// with the existing planner/executor. Public shops and held bags are not roots.
let prepared = null;
let sourceRefs = null;
let generation = 0;
function positive(value) { return Number(value) > 0; }
function ids(rows) { return (rows || []).filter(row => positive(row.amount)).map(row => Number(row.selfId)); }
function signature(recipe) {
    const values = [Number(recipe.productId), Number(recipe.productCount), Number(recipe.recipeItemId) || 0,
        Number(recipe.successRate), recipe.type === 'blacksmith_exchange' ? 3 : recipe.type === 'dwarven' ? 1 : 2];
    for (const row of recipe.materials || []) if (positive(row.amount)) values.push(Number(row.selfId), Number(row.amount));
    return values;
}
function readers(reached, nonRaid, recipeIds, recipeSignatures, counts) {
    return Object.freeze({
        hasSource: id => reached.has(Number(id)),
        hasNonRaidSource: id => nonRaid.has(Number(id)),
        allowsRecipe(recipe) {
            const id = Number(typeof recipe === 'object' ? recipe?.recipeId : recipe);
            if (!recipeIds.has(id)) return false;
            if (typeof recipe !== 'object' || !recipe) return true;
            const expected = recipeSignatures.get(id), actual = signature(recipe);
            return !!expected && expected.length === actual.length && expected.every((value, index) => value === actual[index]);
        },
        counts: Object.freeze(counts)
    });
}
function build(input) {
    const items = new Map();
    for (const row of input.items || []) if (!items.has(Number(row.selfId))) items.set(Number(row.selfId), row);
    const excluded = new Set((input.questItemIds || []).map(Number));
    for (const [id, row] of items) if (row.template?.kind === 'Other.Quest' || row.template?.questItem === true
        || row.template?.temporaryQuestTool === true) excluded.add(id);
    const permitted = id => items.has(id) && !excluded.has(id);
    const reached = new Set(), queue = [], nonRaid = new Set(), ordinaryQueue = [];
    function admit(raw, ordinary = false) {
        const id = Number(raw);
        if (!permitted(id)) return;
        if (!reached.has(id)) { reached.add(id); queue.push(id); }
        if (ordinary && !nonRaid.has(id)) { nonRaid.add(id); ordinaryQueue.push(id); }
    }
    const npcs = new Map((input.npcs || []).map(row => [Number(row.selfId), row]));
    const spawned = new Set(), npcQueue = [], ordinaryNpcs = new Set(), ordinaryNpcQueue = [];
    function spawn(raw) { const id = Number(raw); if (npcs.has(id) && !spawned.has(id)) { spawned.add(id); npcQueue.push(id); } }
    function ordinaryNpc(raw) {
        const id = Number(raw);
        if (!npcs.has(id) || /Boss/.test(npcs.get(id).template?.kind || '') || npcs.get(id).template?.raidBoss === true || ordinaryNpcs.has(id)) return;
        ordinaryNpcs.add(id); ordinaryNpcQueue.push(id);
    }
    for (const region of input.npcSpawns || []) for (const row of region.spawns || [region]) if (positive(row.total)) {
        spawn(row.selfId); ordinaryNpc(row.selfId);
    }
    const minions = new Map();
    for (const row of input.minions || []) if (positive(row.max)) {
        const bossId = Number(row.bossId); if (!minions.has(bossId)) minions.set(bossId, []);
        minions.get(bossId).push(Number(row.minionId));
    }
    for (let i = 0; i < npcQueue.length; i++) for (const id of minions.get(npcQueue[i]) || []) spawn(id);
    // A raid minion inherits raid provenance even though its native kind is
    // Monster. An independent ordinary spawn/leader is a valid alternative.
    for (let i = 0; i < ordinaryNpcQueue.length; i++) for (const id of minions.get(ordinaryNpcQueue[i]) || []) ordinaryNpc(id);
    for (const offer of input.offers || []) if (spawned.has(Number(offer.npcId))
        && !/Monster|Boss|Summon|Pet/.test(npcs.get(Number(offer.npcId))?.template?.kind || '')) admit(offer.selfId, true);
    for (const row of input.npcRewards || []) {
        if (!spawned.has(Number(row.selfId)) || !/Monster|Boss/.test(npcs.get(Number(row.selfId))?.template?.kind || '')) continue;
        for (const group of [...row.rewards || [], ...row.spoils || []]) if (positive(group.overall))
            for (const item of group.items || []) if (positive(item.chance) && positive(item.max)) admit(item.selfId, ordinaryNpcs.has(Number(row.selfId)));
    }
    // Every operation is an AND gate. Count distinct prerequisites once; the
    // queue touches each item and each prerequisite edge once, including cycles.
    const reverse = new Map(), operations = [], recipeIds = new Set(), recipeSignatures = new Map();
    function operation(required, outputs, recipeId, recipeSignature) {
        const needs = [...new Set(required.map(Number))], produces = outputs.map(Number).filter(permitted);
        if (!produces.length || !needs.length || !needs.every(permitted)) return;
        const index = operations.length;
        operations.push({ left: needs.length, ordinaryLeft: needs.length, outputs: produces, recipeId: Number(recipeId) || 0, recipeSignature });
        for (const id of needs) { if (!reverse.has(id)) reverse.set(id, []); reverse.get(id).push(index); }
    }
    for (const recipe of input.recipes || []) if (positive(recipe.successRate) && positive(recipe.productCount)) {
        const needs = ids(recipe.materials);
        if (recipe.type !== 'blacksmith_exchange') needs.push(Number(recipe.recipeItemId));
        operation(needs, [recipe.productId], recipe.recipeId, signature(recipe));
    }
    for (const row of input.transformations || []) operation(row.inputs, row.outputs, row.recipeId);
    const crystals = { d: 1458, c: 1459, b: 1460, a: 1461, s: 1462 };
    for (const [id, row] of items) if (positive(row.etc?.cristals) && crystals[String(row.etc?.rank).toLowerCase()])
        operation([id], [crystals[String(row.etc.rank).toLowerCase()]]);
    for (let i = 0; i < queue.length; i++) for (const index of reverse.get(queue[i]) || []) {
        const op = operations[index];
        if (--op.left !== 0) continue;
        if (op.recipeId) { recipeIds.add(op.recipeId); if (op.recipeSignature) recipeSignatures.set(op.recipeId, op.recipeSignature); }
        for (const id of op.outputs) admit(id);
    }
    // Reuse the same AND graph for ordinary provenance; no raid-only input
    // silently becomes ordinary through a recipe, unseal or crystallisation.
    for (let i = 0; i < ordinaryQueue.length; i++) for (const index of reverse.get(ordinaryQueue[i]) || []) {
        const op = operations[index];
        if (--op.ordinaryLeft !== 0) continue;
        for (const id of op.outputs) admit(id, true);
    }
    // Temporary graph/npc indices are released. Retain numeric sets only.
    return readers(reached, nonRaid, recipeIds, recipeSignatures, { items: items.size, admitted: reached.size, nonRaid: nonRaid.size, recipes: recipeIds.size, excluded: excluded.size });
}
function nativeInputs(Data) {
    const shops = require('../World/Generics/NpcShopBuyLists');
    const SA = require('./C4WeaponSAExchange');
    const spawnedIds = new Set((Data.npcSpawns || []).flatMap(region => (region.spawns || []).filter(row => positive(row.total)).map(row => Number(row.selfId))));
    const saStations = new Set([...spawnedIds].map(id => SA.station(id)).filter(Boolean));
    const transformations = [];
    for (const row of SA.recipes) if (row.operation === 'install' && saStations.has(row.station))
        transformations.push({ inputs: [Number(row.sourceId), ...ids(SA.costs(row))], outputs: [row.productId] });
    if (spawnedIds.has(require('../World/GiranMammon').npcId)) for (const row of require('./C4Unseal').recipes)
        transformations.push({ inputs: [row.sourceId], outputs: [row.productId] });
    for (const [id, row] of Object.entries(require('./C4ExtractableItems').loadExtractableItems())) for (const group of row.products || []) if (positive(group.chance))
        transformations.push({ inputs: [Number(id)], outputs: ids(group.items || [group]) });
    const questItemIds = require('../Quest/QuestRegistry').equipmentTools();
    return { items: Data.items, npcs: Data.npcs, npcSpawns: Data.npcSpawns, npcRewards: Data.npcRewards, questItemIds,
        offers: shops.npcIds().flatMap(npcId => shops.fetchForNpc(npcId).map(row => ({ npcId, selfId: row.selfId }))),
        minions: [...require('../../../data/Npcs/Minions/c4_raid_bosses.json'), ...require('../../../data/Npcs/Minions/c4_group_leaders.json')],
        recipes: [...Object.values(require('./C4RecipeItems').loadRecipeItems()), ...require('./C4DualSwordCombinations').loadRecipes()
            .filter(recipe => spawnedIds.has(Number(recipe.station?.npcId)))], transformations };
}
function refs(Data) { return [Data.items, Data.npcs, Data.npcSpawns, Data.npcRewards]; }
function prepare(input) {
    if (input) { prepared = build(input); sourceRefs = null; generation++; return prepared; }
    const Data = invoke('GameServer/DataCache'), current = refs(Data);
    if (prepared && sourceRefs && current.every((value, i) => value === sourceRefs[i])) return prepared;
    prepared = build(nativeInputs(Data)); sourceRefs = current; generation++;
    return prepared;
}
function current() {
    const Data = invoke('GameServer/DataCache');
    if (prepared && sourceRefs && Data.items === sourceRefs[0] && Data.npcs === sourceRefs[1]
        && Data.npcSpawns === sourceRefs[2] && Data.npcRewards === sourceRefs[3]) return prepared;
    return prepare();
}
module.exports = { build, prepare, reset() { prepared = sourceRefs = null; generation++; },
    revision() { current(); return generation; },
    hasSource: id => current().hasSource(id), hasNonRaidSource: id => current().hasNonRaidSource(id), allowsRecipe: recipe => current().allowsRecipe(recipe),
    counts: () => current().counts };
