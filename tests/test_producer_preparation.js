// Native providers/network with controlled gear/recipe facts and an actual board.
// Source evidence is the same shared reader as production, no live DB.
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
const item = { selfId: 101, etc: { slot: 7 }, template: { price: 100, kind: 'Armor.Chest' } };
const recipe = { recipeId: 301, productId: 101, productCount: 1, recipeItemId: 401,
    mpCost: 1, successRate: 100, materials: [{ selfId: 202, amount: 10 }] };
const state = { characterId: 1, level: 40, inventory: {}, stats: { recipes: [301] },
    activity: 'shopping', currentRegion: 'Giran', loc: { locX: 81100, locY: 148000, locZ: -3466 } };
const board = new BoardIndex();
const persona = { primaryDrive: 'progression', understanding: 1,
    traits: { commitment: 0, caution: 0, ambition: 0 } };
let allowCraft = false, ownCraft = true, spotReads = 0;
const adapters = {
    'GameServer/DataCache': { items: [item] },
    'GameServer/Progression/ProgressionCap': { effectiveLevelCap: () => 40 },
    'GameServer/Bot/AI/KnowledgeLearning': { stages: () => [{ grade: 'c', maxLevel: 51 }], gradeOfLevel: () => 'c' },
    'GameServer/Bot/AI/GearAcquisitionPlanner': { roleFor: () => 'melee', gradeForLevel: () => 'c',
        suitable: () => true, considerable: () => true, itemScore: () => 1, withReadiness: fn => fn() },
    'GameServer/Bot/Population/ColdCombatProfile': { buildGainsFor: () => ({}),
        gainFor: (build, key, fn) => fn(), powerNumbers: () => ({ pAtk: 100, pDef: 100, mDef: 100 }),
        powerFor: () => ({ pAtk: 200, pDef: 100, mDef: 100 }), buildOptions: () => ({}) },
    'GameServer/Bot/Economy/BotImprovementPolicy': { opportunities: () => [], crystalPath: () => null },
    'GameServer/Items/C4RecipeItems': { resolveByProductId: id => allowCraft && id === 101 ? recipe : null, resolveByRecipeId: id => id === 301 ? recipe : null },
    'GameServer/Items/C4DualSwordCombinations': { loadRecipes: () => [] },
    'GameServer/Bot/Economy/CraftShopService': { canCraft: () => ownCraft, isServiceCrafter: () => true },
    'GameServer/Bot/Population/BackgroundResolver': { coldRestRegenPerTick: () => ({ mp: 100 }) },
    'GameServer/Skills/SkillBookCatalog': { missingBooks: () => [] },
    'GameServer/Bot/Economy/MarketCounters': { moveOf: () => 0, counterOf: () => 'armor c' }
};
const invokeAdapter = name => { assert(name in adapters, name); return adapters[name]; };
const valuation = load('EconomicValuation.js', () => { throw Error('unexpected require'); }, invokeAdapter);
const tendency = { MIN: 0.02, roll: () => 0.5 };
const network = load('WishNetwork.js', name => {
    if (name === './EconomyDiagnostics') return { active: () => false };
    if (name === './EconomicValuation') return valuation;
    if (name.endsWith('TendencyRoll')) return tendency;
    if (name.endsWith('Fnv1a')) return { fnv1a32: () => 1 };
    throw Error(name);
});
let supported = true;
adapters['GameServer/Items/NpcSellRules'] = { npcBuyPrice: () => 0 };
adapters['GameServer/Bot/Economy/PriceBelief'] = { prior: () => ({ mu: Math.log(100) }), sigma: () => 0.3 };
const nativePrice = load('PriceDecision.js', name => require(path.resolve(root, name)), invokeAdapter);
const producerPrice = { ...nativePrice, prospectiveExit: (...args) => supported ? nativePrice.prospectiveExit(...args) : args[1] };
const provider = load('WishProviders.js' , name => {
    if (name === './PriceDecision') return producerPrice;
    if (name === './CraftProfitPolicy') return require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
    if (name === './EconomyDiagnostics') return { active: () => false };
    if (name === './EconomicValuation') return valuation;
    if (name.endsWith('BoardIndex')) return { SELL: 1 };
    if (name === './BotImprovementPolicy') return { isCaster: () => false };
    if (name === './WishPurchaseEvidence') return require('../src/GameServer/Bot/Economy/WishPurchaseEvidence');
    if (name === './WealthCraftDecision') return { freeAmount: (state, row) => Number(row.amount || 0) };
    throw Error(name);
}, invokeAdapter);
const context = { timestamp: 1, persona, board, hunt: { perHour: 100, expPerHour: 0 }, deathHours: 0,
    price: id => id === 101 ? 100 : 1, buyback: () => 0,
    stock: () => ({ itemId: 900, missing: 0 }), spotValue: () => { spotReads++; return {}; } };
const preparedTrip = town => town === 'Giran' ? 0 : Infinity;
preparedTrip.details = town => ({ known: town === 'Giran', hours: 0, fees: 0 });
context.trip = preparedTrip;
function run(craft, extra = {}) {
    allowCraft = craft;
    const projection = provider.build(state, { ...context, ...extra.context }, { board, ...(extra.deps || {}) });
    const result = new network.WishNetwork().build({ actorKey: 'character:1', inputKey: String(craft),
        characterId: 1, nodes: projection.nodes, roots: projection.roots,
        wallet: extra.wallet ?? 1000, hourAdena: 100, persona, remembered: false });
    return { publicOffers: 0, nodes: projection.nodes, focus: result.focus,
        queue: result.queue.map(row => ({ key: row.key, funded: row.funded, price: row.price })),
        plans: [...result.plans], activity: result.activity, spotReads };
}

const intent = require('../src/GameServer/Bot/Economy/TradeIntent');
adapters['GameServer/Bot/AI/GearAcquisitionPlanner'].considerable = () => false;
context.hourAdena = 100;
allowCraft = true;
state.adena = 1000;
state.phase = 'cold';
function put(id, itemId, count, price, side = 1, ownerId = 2) {
    board.put({ id, ownerId, storeType: side, town: 'Giran', revision: 1,
        kind: side === 3 ? 'buy_ad' : 'sell', custodyPolicy: side === 3 ? 1 : 0,
        lines: [{ lineId: id, selfId: itemId, count, price, enchant: 0 }] });
}
put(20, 101, 1, 100, 3);
put(21, 202, 4, 1);
function prepare({ wallet = 1000, reserve = 0, deps = {} } = {}) {
    const projection = provider.build(state, context, { board, knownRecipes: [301], ...deps });
    const result = new network.WishNetwork().build({ actorKey: 'producer:1', inputKey: 'producer',
        ...projection, characterId: 1, wallet, survivalReserve: reserve, hourAdena: 100, persona, remembered: false,
        stockFor: id => ({ owned: Math.max(0, Number(state.inventory[id]?.amount || 0) - Number(state.inventory[id]?.protectedAmount || 0)),
            incoming: Number(state.acceptedIncoming?.[id] || 0) }) });
    return { projection, result, watch: intent.project(state, result, projection, () => 1) };
}
const serviceCraft = adapters['GameServer/Bot/Economy/CraftShopService'];
serviceCraft.isServiceCrafter = () => false;
assert(!prepare().projection.roots.includes('resale:101'), 'fighter common craft cannot create an unsupported producer purchase path');
serviceCraft.isServiceCrafter = () => true;
state.stats.craftStationId = 'fixed';
assert(!prepare().projection.roots.includes('resale:101'), 'stationary crafter is outside autonomous producer nomination');
delete state.stats.craftStationId;
state.accountName = 'bot_craft_1';
assert(!prepare().projection.roots.includes('resale:101'), 'stationary service account cannot nominate autonomous production');
delete state.accountName;
let prepared = prepare();
let rootWish = prepared.result.queue.find(row => row.key === 'resale:101');
assert(rootWish, 'conditional public interest creates a finite producer goal before whole ingredient supply');
assert.equal(rootWish.plan.kind, 'craft');
assert.equal(rootWish.plan.batches, 1);
assert.equal(rootWish.plan.repeatable, false);
assert.equal(rootWish.plan.executable, false);
assert.deepEqual(prepared.watch.map(row => [row.itemId, row.amount, row.recipeId]), [[202, 10, 301]],
    'material demand is retained; finished product never becomes preparatory BUY');
assert.equal(prepared.result.activity.activity, 'shopping');
assert.equal(prepared.result.activity.amount, 4, 'only finite available material supply executes');
assert.equal(prepared.projection.moneyPaths.some(path => path.kind === 'production'), false);
assert.equal(prepared.result.hourAdena, 100);
supported = false;
assert(!prepare().projection.roots.includes('resale:101'), 'an unsupported conditional forecast admits no production');
supported = true;
state.inventory[101] = { selfId: 101, amount: 1 };
assert(!prepare().projection.roots.includes('resale:101'), 'owned output exhausts the finite snapshot demand');
const originalBuyback = context.buyback;
context.buyback = () => 100;
assert(!prepare().projection.roots.includes('resale:101'), 'a profitable NPC residual cannot renew exhausted conditional interest');
context.buyback = originalBuyback;
delete state.inventory[101];
put(22, 101, 1, 100, 1, 1);
assert(!prepare().projection.roots.includes('resale:101'), 'backed own SELL output participates in the same finite cap');
board.remove(22);
state.acceptedIncoming = { 101: 1 };
assert(!prepare().projection.roots.includes('resale:101'), 'actual accepted incoming output also consumes remaining demand');
state.acceptedIncoming = { 202: 2 };
state.inventory[202] = { selfId: 202, amount: 4, protectedAmount: 2 };
prepared = prepare();
assert.equal(prepared.watch[0].amount, 6, 'incoming/free materials are allocated once; protected stock is unavailable');
delete state.inventory[202]; delete state.acceptedIncoming;
prepared = prepare({ wallet: 9, reserve: 5 });
assert.equal(prepared.result.queue.find(row => row.key === 'resale:101').funded, false);
assert.notEqual(prepared.result.activity?.activity, 'shopping', 'survival reserve cannot fund production purchases');
put(23, 401, 1, 1);
prepared = prepare({ deps: { knownRecipes: [], producerRecipes: [recipe] } });
rootWish = prepared.result.queue.find(row => row.key === 'resale:101');
assert(rootWish?.plan.requiresRecipeLearning, 'an unknown indexed recipe joins the preparation');
assert(prepared.watch.some(row => row.itemId === 401 && row.amount === 1), 'physical recipe scroll gets one requirement');
board.remove(23);
const planner = adapters['GameServer/Bot/AI/GearAcquisitionPlanner'];
planner.sourceIndexFor = () => new Map([[401, [{ kind: 'drop', totalCount: 1, sourceCount: 1,
    spot: { id: 'scroll-source' }, reward: { selfId: 501 } }]]]);
planner.sourceYieldReaderFor = () => () => ({ expectedYield: 1 });
planner.soloSafeForSource = () => true;
context.spotValue = () => ({ kills: 1000 });
prepared = prepare({ deps: { knownRecipes: [], producerRecipes: [recipe], spots: [{}] } });
assert(prepared.projection.roots.includes('resale:101'), 'safe physical recipe farm supports preparation without scroll SELL');
assert(prepared.result.demands.has('item:401'));
// A belief price cannot veto cheaper native acquisition before the DAG.
board.remove(21);
const priorPrice = context.price;
context.price = id => id === 202 ? 10000 : priorPrice(id);
planner.sourceIndexFor = () => new Map([[202, [{ kind: 'drop', totalCount: 1, sourceCount: 1,
    spot: { id: 'material-source' }, reward: { selfId: 502 } }]]]);
prepared = prepare({ deps: { spots: [{}] } });
assert(prepared.projection.roots.includes('resale:101'), 'negative price-proxy profit cannot erase a cheaper acquisition alternative');
assert.equal(prepared.result.activity?.activity, 'hunting', 'the shared graph chooses the cheap physical material source');
assert.equal(prepared.result.activity?.itemId, 202);
assert.notEqual(prepared.result.activity?.activity, 'shopping', 'expensive forecast inputs cannot become an unconditional purchase');
assert.equal(prepared.result.plans.get('resale:101').price, 0,
    'real farm acquisition has no imaginary input cash charge');
// Positive gross receipts do not authorise an acquisition loss.
planner.sourceIndexFor = () => new Map();
put(21, 202, 10, 10000);
prepared = prepare();
assert(prepared.projection.roots.includes('resale:101'), 'price proxy still admits graph evaluation');
assert(!prepared.result.queue.some(row => row.key === 'resale:101'), 'whole expensive path fails the shared hour comparison');
assert(!prepared.watch.some(row => row.key === 'resale:101'), 'a rejected production path creates no material BUY');
board.remove(21);
planner.sourceIndexFor = () => new Map([[202, [{ kind: 'drop', totalCount: 1, sourceCount: 1,
    spot: { id: 'material-source' }, reward: { selfId: 502 } }]]]);
context.price = priorPrice;
const originalTrip = context.trip;
const distantTrip = town => town === 'Giran' ? 205 : Infinity;
distantTrip.details = town => ({ known: town === 'Giran', hours: 2, fees: 5 });
context.trip = distantTrip;
prepared = prepare({ deps: { spots: [{}] } });
const salePath = prepared.result.plans.get('resale:101');
assert.equal(salePath.price, 5, 'sale travel fees enter the same cash path once');
assert.equal(salePath.tripEntries.length, 1);
assert(salePath.effort >= 2, 'the future selling trip remains part of production effort');
assert(!prepared.watch.some(row => row.key === 'resale:101'), 'an unprofitable remote sale cannot fund material acquisition');
put(21, 202, 10, 1);
prepared = prepare();
assert.equal(prepared.result.plans.get('resale:101').price, 15, 'buy and sale in one town share their route fee');
assert.equal(prepared.result.plans.get('resale:101').tripEntries.length, 1);
context.trip = originalTrip;
put(24, 101, 1, 1);
assert(!prepare().projection.roots.includes('resale:101'), 'cheaper competitive output exhausts the finite remaining interest');
board.remove(24); board.remove(20);
assert(!prepare().projection.roots.includes('resale:101'), 'withdrawn public demand retires production preparation');
// Ordinary gear and a producer share an item but keep their source-choice
// contracts: immediate farm for gear, cheaper unquoted purchase for a trial.
const plannedNodes = [
    { key: 'item:202', object: 202, price: 1, paths: [
        { kind: 'buy', activity: 'shopping', price: 1, available: true, executable: false, availableUnits: 0 },
        { kind: 'drop', activity: 'hunting', itemId: 202, spotId: 'expensive-farm', costHours: 100 }] },
    { key: 'power:202:7', need: 'power', object: { itemId: 202 }, valueHours: 200,
        paths: [{ requirements: [{ key: 'item:202', amount: 1 }] }] },
    { key: 'resale:501', need: 'power', object: { itemId: 501, kind: 'resale' }, valueHours: 1,
        paths: [{ kind: 'craft', activity: 'crafting', trial: true, repeatable: false, productCount: 1,
            requirements: [{ key: 'item:202', amount: 1 }], grossRequirements: [{ key: 'item:202', amount: 1 }] }] }
];
for (const stockFor of [undefined, () => ({ owned: 0, incoming: 0 })]) {
    const preparedTrial = new network.WishNetwork().build({ actorKey: 'planned-trial', inputKey: String(!!stockFor),
        nodes: plannedNodes, roots: ['power:202:7', 'resale:501'], wallet: 1000, hourAdena: 100,
        persona, remembered: false, stockFor });
    assert(preparedTrial.queue.some(row => row.key === 'resale:501'), 'cheap intended input purchase preserves the finite trial');
    const producerPath = preparedTrial.plans.get('resale:501');
    assert.equal(producerPath.executable, false, 'the preparation cannot craft without physical ingredients');
    assert.equal(producerPath.requirements[0].plan.kind, 'buy');
    assert.equal(producerPath.requirements[0].plan.executable, false);
    assert.equal(preparedTrial.plans.get('power:202:7').effort, 100, 'the normal root retains executable-first acquisition');
    const commands = intent.project({}, preparedTrial, { nodes: plannedNodes }, () => 1);
    assert(commands.some(row => row.itemId === 202), 'the missing material remains a public purchase intention');
    assert.notEqual(preparedTrial.activity?.rootKey, 'resale:501', 'unsupported purchase/craft leaves remain blocked');
}
const sharedTrialNodes = [501, 502].map((id, index) => ({ key: `resale:${id}`, need: 'power',
    object: { itemId: id, kind: 'resale' }, valueHours: index ? 0.5 : 1,
    paths: [{ kind: 'craft', activity: 'crafting', trial: true, repeatable: false, productCount: 1,
        ownInputOpportunityValue: 10, requirements: [], grossRequirements: [{ key: 'item:202', amount: 1 }] }] }));
sharedTrialNodes.push({ key: 'item:202', object: 202, price: 10,
    paths: [{ kind: 'buy', activity: 'shopping', price: 100 }] });
const sharedTrials = new network.WishNetwork().build({ actorKey: 'shared-producer', inputKey: 'shared-producer',
    nodes: sharedTrialNodes, roots: ['resale:501', 'resale:502'], wallet: 1000, hourAdena: 100,
    persona, remembered: false, stockFor: () => ({ owned: 1, incoming: 0 }) });
assert.equal(sharedTrials.activity?.rootKey, 'resale:501');
assert(!sharedTrials.queue.some(row => row.key === 'resale:502'),
    'profitability is checked again when the first trial takes shared physical stock');
console.log('PASS finite producer graph: partial inputs, native conditional forecast, direct materials, own output, incoming/protected stock, funding, unknown book/farm and demand retirement');
