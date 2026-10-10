// MVP-6 admission: every gear candidate is valued by the network's own path
// solver over a scratch arena of item descriptors; family winners enter by
// score, shared stock re-evaluates only affected candidates, an arena over
// the bound is pending, never a zero cost. The final cut and the group use
// one admitRoots. Real board, evidence, recipe and solver modules.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
require('../src/Global');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const root = path.resolve(__dirname, '../src/GameServer/Bot/Economy');
function load(file, requireAdapter, invokeAdapter = () => { throw Error('unexpected invoke'); }) {
    const module = { exports: {} };
    new Function('require', 'invoke', 'module', 'exports', fs.readFileSync(path.join(root, file), 'utf8'))(
        requireAdapter, invokeAdapter, module, module.exports);
    return module.exports;
}
const data = { items: [] }, recipes = new Map(), gains = new Map(), prices = new Map();
let gearIds = new Set(), opportunities = [];
const counts = new Map();
let diagnostics = false;
const Diagnostics = { active: () => diagnostics, enabled: () => false, push: () => {}, duration: () => {}, count: (group, name, reason, amount = 1) => {
    const key = [group, name, reason].join('/'); counts.set(key, (counts.get(key) || 0) + amount); } };
const adapters = {
    'GameServer/DataCache': data,
    'GameServer/Progression/ProgressionCap': { effectiveLevelCap: () => 40 },
    'GameServer/Bot/AI/KnowledgeLearning': { stages: () => [{ grade: 'c', maxLevel: 51 }], gradeOfLevel: () => 'c' },
    'GameServer/Bot/AI/GearAcquisitionPlanner': { roleFor: () => 'melee', gradeForLevel: () => 'c',
        suitable: item => gearIds.has(item.selfId), considerable: () => true, itemScore: () => 1, withReadiness: fn => fn(),
        equipmentCandidate: () => true, equipmentItemBetter: (item, current) => !current },
    // The worn candidate raises attack by its own gain; nothing else changes.
    'GameServer/Bot/Population/ColdCombatProfile': { withEquipmentPreparation: fn => fn(), buildGainsFor: () => ({}),
        gainFor: (build, key, fn) => fn(), powerNumbers: () => ({ pAtk: 100, pDef: 100, mDef: 100 }),
        powerFor: ({ inventory }) => {
            const worn = Object.values(inventory).find(row => row.equipped && gains.has(row.selfId));
            return { pAtk: 100 * (1 + (worn ? gains.get(worn.selfId) : 0)), pDef: 100, mDef: 100 };
        }, buildOptions: () => ({}) },
    'GameServer/Bot/Economy/BotImprovementPolicy': { opportunities: () => opportunities, crystalPath: () => null },
    'GameServer/Items/C4RecipeItems': { resolveByProductId: id => recipes.get(Number(id)) || null,
        resolveByRecipeId: id => [...recipes.values()].find(row => row.recipeId === Number(id)) || null },
    'GameServer/Items/C4DualSwordCombinations': { loadRecipes: () => [] },
    'GameServer/Bot/Economy/CraftShopService': { canCraft: () => true, isServiceCrafter: () => false },
    'GameServer/Bot/Population/BackgroundResolver': { coldRestRegenPerTick: () => ({ mp: 100 }) },
    'GameServer/Skills/SkillBookCatalog': { missingBooks: () => [] },
    'GameServer/Bot/Economy/MarketCounters': { moveOf: () => 0, counterOf: () => 'armor c' },
    'GameServer/Bot/Economy/ItemDisposition': { saleCandidates: () => [] },
    'GameServer/Inventory/ShotStock': { keptAmounts: () => ({}) },
    'GameServer/Bot/AI/HealingPotionStock': { keptAmounts: () => ({}) },
    'GameServer/Bot/Travel/ScrollStock': { keptAmounts: () => ({}) }
};
const invokeAdapter = name => { assert(name in adapters, name); return adapters[name]; };
const valuation = load('EconomicValuation.js', () => { throw Error('unexpected require'); }, invokeAdapter);
const network = load('WishNetwork.js', name => {
    if (name === './EconomyDiagnostics') return { active: () => false };
    if (name === './EconomicValuation') return valuation;
    if (name.endsWith('TendencyRoll')) return { MIN: 0.02, roll: () => 0.5 };
    if (name.endsWith('Fnv1a')) return { fnv1a32: () => 1 };
    throw Error(name);
});
const provider = load('WishProviders.js', name => {
    if (name.endsWith('ItemAcquisitionCatalog')) return { revision: () => 1, hasSource: () => true, hasNonRaidSource: () => true, allowsRecipe: () => true };
    if (name === './CraftProfitPolicy') return require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
    if (name === './EconomyDiagnostics') return Diagnostics;
    if (name === './EconomicValuation') return valuation;
    if (name === './WishNetwork') return network;
    if (name === '../AI/BotEquipmentCompatibility') return require('../src/GameServer/Bot/AI/BotEquipmentCompatibility');
    if (name === '../../Item/ItemTemplateIndex') return require('../src/GameServer/Item/ItemTemplateIndex');
    if (name.endsWith('BoardIndex')) return { SELL: 1 };
    if (name === './BotImprovementPolicy') return { isCaster: () => false };
    if (name === './WishPurchaseEvidence') return require('../src/GameServer/Bot/Economy/WishPurchaseEvidence');
    if (name === './WealthCraftDecision') return { freeAmount: (state, row) => Number(row.amount || 0) };
    throw Error(name);
}, invokeAdapter);
// Level 40 is the cap: the horizon is 1 + 24 x commitment = 13 hours.
const persona = { primaryDrive: 'progression', understanding: 1,
    traits: { commitment: 0.5, caution: 0, ambition: 0, assertiveness: 0 } };
const state = { characterId: 1, level: 40, adena: 0, inventory: {}, stats: { recipes: [] },
    activity: 'hunting', currentRegion: 'Giran', loc: { locX: 81100, locY: 148000, locZ: -3466 } };
const stockFor = id => ({ owned: Number(state.inventory[id]?.amount || 0), incoming: 0 });
const trip = town => town === 'Giran' ? 0 : Infinity;
trip.details = town => ({ known: town === 'Giran', hours: 0, fees: 0 });
const gear = (selfId, slot, gain, price) => {
    gains.set(selfId, gain); prices.set(selfId, price);
    return { selfId, etc: { slot, rank: 'c' }, template: { price, kind: 'Armor' } };
};
const recipe = (recipeId, productId, materials) => {
    recipes.set(productId, { recipeId, productId, productCount: 1, recipeItemId: recipeId + 1000, mpCost: 1,
        successRate: 100, materials: materials.map(selfId => Array.isArray(selfId)
            ? { selfId: selfId[0], amount: selfId[1] } : { selfId, amount: 1 }) });
    return recipeId;
};
// Each scenario has its own item array (the kit cache follows it), board and stock.
function scenario({ items, asks = [], known = [], inventory = {}, improvements = [] }) {
    data.items = items; gearIds = new Set(items.map(row => row.selfId));
    opportunities = improvements; state.inventory = inventory;
    const board = new BoardIndex();
    asks.forEach(([selfId, price, count = 1], at) => board.put({ id: at + 1, ownerId: 2, storeType: 1, kind: 'sell_ad',
        town: 'Giran', revision: 1, lines: [{ lineId: at + 1, selfId, count, price, enchant: 0 }] }));
    const ctx = { timestamp: 1, persona, board, hunt: { perHour: 0, expPerHour: 0 }, deathHours: 0,
        hourAdena: 100, riskWeight: 1, wallet: 0, survivalReserve: 0, stockFor,
        price: id => prices.get(Number(id)) ?? 1, buyback: () => 0,
        stock: () => ({ itemId: 900, missing: 0 }), spotValue: () => ({}), trip };
    const projection = provider.build(state, ctx, { board, knownRecipes: known.map(recipeId => ({ recipeId })) });
    const result = new network.WishNetwork().build({ actorKey: 'character:1', inputKey: 'admission', characterId: 1,
        nodes: projection.nodes, roots: projection.roots, wallet: 0, survivalReserve: 0, hourAdena: 100, riskWeight: 1,
        persona, remembered: false, stockFor });
    return { projection, admission: projection.admission, result };
}
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
const witness = (admission, key) => admission.admitted.find(row => row.key === key);

// 1. Four armour pieces at 1000 (delay 10 h of a 13 h horizon, ready 0.5 x 3 =
// 1.5 hours per 10 hours of effort) and a chest at 500 (0.2 x 8 = 1.6 per 5).
// The old value/price proxy ranked the chest last (2.6/500 < 6.5/1000) and cut
// it with the fifth slot; benefit from the moment it is ready ranks it first.
diagnostics = true;
const cut = scenario({ items: [111, 112, 113, 114].map((id, at) => gear(id, at + 1, 0.5, 1000)).concat(gear(115, 10, 0.2, 500)),
    asks: [[111, 1000], [112, 1000], [113, 1000], [114, 1000], [115, 500]] });
diagnostics = false;
assert.deepEqual(cut.projection.roots.filter(key => key.startsWith('power:')).sort(),
    ['power:111:1', 'power:112:2', 'power:113:3', 'power:115:10'], 'the chest enters, the fourth equal piece waits');
assert.equal(cut.admission.candidates, 5);
assert.equal(cut.admission.evaluations, 5, 'no shared stock: one evaluation each');
assert.equal(cut.admission.rounds, 1);
const chest = witness(cut.admission, 'power:115:10');
close(chest.valueHours, 1.6, 'chest ready benefit');
close(chest.effort, 5, 'chest effort');
assert.equal(chest.price, 500);
close(witness(cut.admission, 'power:111:1').valueHours, 1.5, 'armour ready benefit');
const expanded = cut.result.queue.find(row => row.key === 'power:115:10');
// The money queue weighs every wish except the held focus by 1 - loyalty (0.5).
const loyalty = cut.result.focus?.[0] === 'power:115:10' ? 1 : 1 - persona.traits.commitment;
assert.deepEqual([expanded.price, expanded.effort, expanded.valueHours], [chest.price, chest.effort, chest.valueHours * loyalty],
    'the witness is the expanded network wish when no other root shares its stock');
assert.equal(counts.get('provider/admission/candidate'), 5);
assert.equal(counts.get('provider/admission/evaluation'), 5);
assert.equal(counts.get('provider/admission/round'), 1);
assert.equal(counts.get('provider/admission/gear_root'), 4);
console.log('PASS ready benefit admits the cheaper chest the old proxy cut; witness equals the expanded wish; counts');

// 2. Weapon slots 7 and 14 are one family: one weapon root, the better one.
const weapons = scenario({ items: [gear(121, 7, 0.4, 1000), gear(122, 14, 0.6, 1000), gear(115, 10, 0.2, 500)],
    asks: [[121, 1000], [122, 1000], [115, 500]] });
assert.equal(weapons.admission.candidates, 3);
assert.deepEqual(weapons.projection.roots.filter(key => key.startsWith('power:')).sort(), ['power:115:10', 'power:122:14']);
assert.equal(witness(weapons.admission, 'power:122:14').family, 'weapon');
console.log('PASS one weapon family across both weapon slots');

// 3. Two crafts each need 10 of a material the bot holds 10 of. The first
// admitted claims the stock; only the other is re-evaluated and now buys it.
const shared = scenario({ items: [gear(131, 1, 0.5, 1000), gear(132, 2, 0.5, 1000)],
    asks: [[202, 1, 20]], known: [recipe(331, 131, [[202, 10]]), recipe(332, 132, [[202, 10]])],
    inventory: { 202: { selfId: 202, amount: 10 } } });
assert.equal(shared.admission.rounds, 2);
assert.equal(shared.admission.evaluations, 3, 'two first evaluations and one affected re-evaluation');
assert.equal(witness(shared.admission, 'power:131:1').evaluations, 1);
assert.equal(witness(shared.admission, 'power:132:2').evaluations, 2);
assert.equal(witness(shared.admission, 'power:131:1').price, 0, 'held material costs no money');
assert.equal(witness(shared.admission, 'power:132:2').price, 10, 'the second craft buys its material');
console.log('PASS shared stock re-evaluates only the affected candidate');
recipes.clear();

// 4. An improvement already placed a 30-node crafted material in the graph.
// A gear recipe of 12 more materials plus that one needs 12 + 30 + 1 = 43 > 40
// descriptors: it is pending as a limit, not admitted at zero cost.
const leaves = Array.from({ length: 29 }, (_, at) => 151 + at), parts = Array.from({ length: 12 }, (_, at) => 181 + at);
const limited = scenario({ items: [gear(142, 1, 0.5, 1000)],
    known: [recipe(341, 141, leaves), recipe(342, 142, [...parts, 141])],
    improvements: [{ key: 'improvement:1', kind: 'enchant', materials: [{ selfId: 141, amount: 1 }],
        valueHours: 5, price: 100, fee: 0 }] });
assert.equal(limited.admission.maxScratch, 43);
assert.deepEqual(limited.admission.pending.filter(row => row.key === 'power:142:1'),
    [{ key: 'power:142:1', reason: 'evaluation_limit' }]);
assert(!limited.projection.roots.includes('power:142:1'));
assert(limited.projection.roots.includes('improvement:1'), 'the placed root still proceeds');
console.log('PASS an arena over forty descriptors is pending evaluation_limit');
recipes.clear();

// 5. The final cut: a root whose union does not fit is pending, smaller ones proceed.
const chain = (name, size) => [{ key: name, need: 'power', paths: [{ requirements:
    Array.from({ length: size - 1 }, (_, at) => ({ key: `${name}:${at}`, amount: 1 })) }] },
...Array.from({ length: size - 1 }, (_, at) => ({ key: `${name}:${at}` }))];
const byKey = new Map([...chain('r1', 30), ...chain('r2', 15), ...chain('r3', 5)].map(node => [node.key, node]));
const final = network.admitRoots(['r1', 'r2', 'r3'], byKey, { rootLimit: 12, nodeLimit: 40 });
assert.deepEqual(final.roots, ['r1', 'r3']);
assert.deepEqual(final.pending, [{ key: 'r2', reason: 'node_limit' }]);
assert.equal(final.kept.size, 35);
assert.deepEqual(network.admitRoots(['r3', 'r2', 'r1'], byKey, { rootLimit: 1 }).pending.map(row => row.reason),
    ['root_limit', 'root_limit']);
console.log('PASS admitRoots: node_limit keeps the smaller roots, root_limit beyond the count');

// 6. A group plan: member keys are prefixed in gross inputs too, so a risky
// craft of a repeatable material is planned until success for the group.
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const member = { characterId: 5, adena: 0, inventory: {}, stats: {} };
const memberProjection = { moneyPaths: [], roots: ['gear'], nodes: [
    { key: 'gear', need: 'power', valueHours: 100, price: 10, paths: [{ kind: 'craft', activity: 'crafting',
        successProbability: 0.6, costHours: 0.01, requirements: [{ key: 'item:202', amount: 10 }],
        grossRequirements: [{ key: 'item:202', amount: 10 }] }] },
    { key: 'item:202', price: 1, paths: [{ kind: 'buy', activity: 'shopping', price: 1, quoted: true,
        executable: true, availableUnits: 100, town: 'Giran', tripHours: 0, tripFees: 0 }] }] };
const group = Economy.forGroup({ id: 'proposal:1', adena: 10000 }, [member], { memberContexts: [{ state: member,
    projection: memberProjection, inputKey: 'member', actorKey: 'character:5', hunt: { perHour: 100, expPerHour: 0 },
    persona, riskWeight: 1, itemUsefulness: () => 0 }] });
assert.equal(group.network.plans.get('0:gear').untilSuccess, true, 'prefixed gross inputs reach the repeatable check');
console.log('PASS group gross inputs are prefixed: until-success applies to group crafts');
