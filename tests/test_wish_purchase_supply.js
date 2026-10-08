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
let allowCraft = false, spotReads = 0;
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
    'GameServer/Items/C4RecipeItems': { resolveByProductId: id => allowCraft && id === 101 ? recipe : null },
    'GameServer/Items/C4DualSwordCombinations': { loadRecipes: () => [] },
    'GameServer/Bot/Economy/CraftShopService': { canCraft: () => true },
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
const provider = load('WishProviders.js', name => {
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
    const projection = provider.build(state, { ...context, ...extra.context }, { board });
    const result = new network.WishNetwork().build({ actorKey: 'character:1', inputKey: String(craft),
        characterId: 1, nodes: projection.nodes, roots: projection.roots,
        wallet: extra.wallet ?? 1000, hourAdena: 100, persona, remembered: false });
    return { publicOffers: 0, nodes: projection.nodes, focus: result.focus,
        queue: result.queue.map(row => ({ key: row.key, funded: row.funded, price: row.price })),
        plans: [...result.plans], activity: result.activity, spotReads };
}
const buy = run(false), craft = run(true);
assert.equal(buy.activity, null, 'known price with no offer preserves wish without shopping');
assert(buy.queue.length && buy.focus, 'unknown future supply does not erase the desired gear');
assert.equal(craft.activity, null, 'missing ingredient forecast cannot execute shopping/craft');
assert.equal(craft.plans.find(([key]) => key === 'item:202')[1].executable, false);
assert.equal(spotReads, 0, 'gear gain still has no hypothetical best-spot evaluation');
function stock(id, amount, ownerId = 2, enchant = 0) {
    board.put({ id: 11, ownerId, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
        lines: [{ lineId: 11, selfId: id, count: amount, price: 1, enchant }] });
}
stock(202, 6);
const partial = run(true);
assert.equal(partial.activity.activity, 'shopping');
assert.equal(partial.activity.object, 202);
assert.equal(partial.activity.amount, 6, 'partial source cannot purchase the unavailable remainder');
assert.equal(partial.plans.find(([key]) => key === 'item:101')[1].executable, false);
stock(202, 10);
const full = run(true);
assert.equal(full.activity.activity, 'shopping', 'ingredients must be acquired before crafting');
assert.equal(full.activity.amount, 10);
assert.equal(full.plans.find(([key]) => key === 'item:101')[1].executable, true);
stock(202, 10, 1);
assert.equal(run(true).activity, null, 'own standing stock does not establish external buying supply');
stock(202, 10, 2, 1);
assert.equal(run(true).activity, null, 'enchanted item is not a normal recipe ingredient');
stock(101, 1);
board.put({ id: 11, ownerId: 2, storeType: 1, kind: 'sell_ad', town: 'Giran',
    lines: [{ lineId: 11, selfId: 101, count: 1, price: 1200 }] });
const expensive = run(false);
assert.equal(expensive.queue[0].price, 1200, 'observed ask replaces the optimistic 100-adena forecast in the purse');
assert.equal(expensive.queue[0].funded, false);
assert.equal(expensive.activity, null, 'an unaffordable actual ask cannot execute shopping');
const paidTrip = town => town === 'Giran' ? 6 : Infinity;
paidTrip.details = town => ({ known: town === 'Giran', hours: 2, fees: 400 });
const travelTooDear = run(false, { wallet: 1500, context: { trip: paidTrip } });
assert.equal(travelTooDear.queue[0].price, 1600, 'the purse includes actual future road fees');
assert.equal(travelTooDear.queue[0].funded, false);
assert.equal(travelTooDear.activity, null);
assert.equal(run(false, { context: { trip: undefined } }).activity, null,
    'unprepared route keeps desire but cannot synchronously prove supply');

// Two ingredients share one prepared visit. Price and effort charge its fee
// once for the complete craft, while individual leaves retain their own trip.
const basketNodes = [{ key: 'gear', need: 'power', price: 1, valueHours: 100,
    paths: [{ kind: 'craft', activity: 'crafting', price: 0, requirements: [
        { key: 'a', amount: 10 }, { key: 'b', amount: 4 }] }] },
...['a', 'b'].map(key => ({ key, paths: [{ kind: 'buy', activity: 'shopping', price: 2,
    executable: true, quoted: true, availableUnits: 20, town: 'Giran', tripFees: 100, tripHours: 3 }] }))];
const basket = new network.WishNetwork().build({ actorKey: 'basket', inputKey: 'basket', nodes: basketNodes,
    roots: ['gear'], wallet: 128, hourAdena: 100, persona, remembered: false });
assert.equal(basket.queue[0].price, 128, '28 adena of ingredients plus one 100-adena trip');
assert.equal(basket.queue[0].effort, 4.28, 'ingredient work plus one three-hour trip and cash cost');
assert.equal(basket.queue[0].funded, true);
const memberNodes = [{ key: 'group', need: 'power', valueHours: 100,
    paths: [{ requirements: [{ key: 'first', amount: 1 }, { key: 'second', amount: 1 }] }] },
...['first', 'second'].map(key => ({ key, paths: [{ kind: 'buy', activity: 'shopping', quoted: true,
    price: 100, town: 'Giran', tripScope: key, tripFees: 900, tripHours: 1 }] }))];
const memberBasket = new network.WishNetwork().build({ actorKey: 'group', inputKey: 'members',
    nodes: memberNodes, roots: ['group'], wallet: 1900, hourAdena: 100, persona, remembered: false });
assert.equal(memberBasket.queue[0].price, 2000, 'different members pay their own same-town trips');
assert.equal(memberBasket.queue[0].funded, false, 'a group cannot afford two trips with only one trip in its purse');
const manyNodes = [{ key: 'crowd', need: 'power', valueHours: 1000, paths: [{
    requirements: Array.from({ length: 39 }, (_, index) => ({ key: `member:${index}`, amount: 1 })) }] },
...Array.from({ length: 39 }, (_, index) => ({ key: `member:${index}`, paths: [{ kind: 'buy',
    activity: 'shopping', quoted: true, price: 100, town: 'Giran', tripScope: `member:${index}`,
    tripFees: 900, tripHours: 1 }] }))];
const crowdBasket = new network.WishNetwork().build({ actorKey: 'crowd', inputKey: 'crowd', nodes: manyNodes,
    roots: ['crowd'], wallet: 39000, hourAdena: 100, persona, remembered: false });
assert.equal(crowdBasket.queue[0].price, 39000, 'all bounded graph scopes survive beyond seventeen towns and thirty-two mask bits');
assert.equal(crowdBasket.plans.get('crowd').tripEntries.length, 39);
const zeroIncome = new network.WishNetwork().build({ actorKey: 'zero', inputKey: 'zero', nodes: basketNodes,
    roots: ['gear'], wallet: 128, hourAdena: 0, persona, remembered: false });
assert.equal(zeroIncome.queue[0].effort, Infinity, 'unknown hour conversion is infinite, never NaN');
const freeNodes = [{ key: 'free', need: 'power', valueHours: 10, paths: [{ kind: 'buy', activity: 'shopping',
    price: 0, quoted: true, town: 'Giran', tripFees: 0, tripHours: 3 }] }];
const freeVisit = new network.WishNetwork().build({ actorKey: 'free', inputKey: 'free', nodes: freeNodes,
    roots: ['free'], wallet: 0, hourAdena: 0, persona, remembered: false });
assert.equal(freeVisit.plans.get('free').effort, 3, 'zero cash is not multiplied by an unknown hour price');

const ColdDecision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const decoded = ColdDecision.compact({ key: 'city', updatedAt: 1, riskWeight: 1,
    activity: { activity: 'shopping', itemId: 202, amount: 6, price: 106, unitPrice: 1,
        rootKey: 'gear', town: 'Giran', sourceType: 'npc' } }).activity;
assert.equal(decoded.town, 'Giran'); assert.equal(decoded.sourceType, 'npc');
assert.equal(decoded.heldAtDecision, undefined, 'optional town fields do not manufacture held inventory');
const goalsModule = { exports: {} };
new Function('require', 'invoke', 'module', 'exports', fs.readFileSync(path.join(root, '../Goals/NeedsEvaluator.js'), 'utf8'))(
    name => name.includes('ItemTemplateIndex') ? { find: () => null }
        : name.endsWith('Fnv1a') ? { fnv1a32: () => 1 } : (() => { throw Error(name); })(),
    name => name.endsWith('SurvivalFloor') ? { forState: () => null }
        : name.endsWith('EconomyContext') ? { survivalReserve: () => 0 }
        : name.endsWith('DataCache') ? { items: [] } : (() => { throw Error(name); })(),
    goalsModule, goalsModule.exports);
const otherTownBoard = new BoardIndex();
otherTownBoard.put({ id: 2, ownerId: 3, storeType: 1, town: 'Dion', kind: 'sell_ad',
    lines: [{ lineId: 2, selfId: 202, price: 1, count: 20 }] });
const goal = goalsModule.exports.evaluate(state, { errand: null, board: otherTownBoard, npcOffersFor: () => [],
    economy: { network: { activity: decoded }, inputKey: 'city' } })[0];
assert.equal(goal.plan.marketTown, 'Giran', 'execution keeps the selected reachable city instead of first public head');
assert.equal(goal.plan.sourceType, 'npc', 'execution keeps the chosen source class');
assert.equal(goal.target.adena, 1, 'travel fee cannot inflate the executable unit quote');
assert.equal(goal.plan.estimatedCost, 106, 'the complete monetary estimate retains its future trip');
const wideDecision = ColdDecision.compact({ key: '65|57|hunting|0|', updatedAt: 1, riskWeight: 1,
    usefulness: Array.from({ length: 80 }, (_, i) => i + 1),
    watch: Array.from({ length: 3 }, (_, i) => [200 + i, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 3]),
    materials: Array.from({ length: 8 }, (_, i) => [300 + i, Number.MAX_SAFE_INTEGER]),
    wish: [0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    activity: { ...decoded, town: 'DarkElf', amount: Number.MAX_SAFE_INTEGER, price: Number.MAX_SAFE_INTEGER,
        unitPrice: Number.MAX_SAFE_INTEGER, heldAtDecision: Number.MAX_SAFE_INTEGER } });
assert(require('node:v8').serialize(wideDecision).byteLength <= ColdDecision.MAX_BYTES,
    'selected source and exact unit quote retain the existing 800-byte compact wire bound');
console.log('PASS actual prices/road funding, one basket trip, zero-hour arithmetic, compact and native goal city/source');
console.log('PASS actual provider/network: unknown wish retained, no unsupported activity, finite partial/full sources, prerequisite acquisition, owner/enchant restrictions');
const Evidence = require('../src/GameServer/Bot/Economy/WishPurchaseEvidence');
const knownNpc = Evidence.reader(state, context, { board: new BoardIndex(), npcOffersFor: () => [
    { sourceType: 'npc', selfId: 202, town: 'Giran', price: 3, available: true }] })(202);
assert.equal(knownNpc.availableUnits, Infinity, 'permitted static NPC source is unlimited');
assert.equal(Evidence.reader(state, context, { board: new BoardIndex(), tripCost: () => 0,
    npcOffersFor: () => [{ sourceType: 'npc', selfId: 202, town: 'Giran', price: 3 }] })(202), null,
    'a generic scalar cost without separate prepared cash/time cannot claim a free road');
const unknownTown = Evidence.reader(state, context, { board: new BoardIndex(), npcOffersFor: () => [
    { sourceType: 'npc', selfId: 202, town: 'Unknown', price: 3 }] })(202);
assert.equal(unknownTown, null, 'unknown route is not an executable quote');
const limitedBoard = new BoardIndex();
for (let id = 1; id <= 30; id++) limitedBoard.put({ id, ownerId: id < 30 ? 1 : 2,
    storeType: 1, kind: 'sell_ad', town: 'Giran', lines: [{ lineId: id, selfId: 202, count: 1, price: id }] });
assert.equal(Evidence.reader(state, context, { board: limitedBoard })(202), null,
    'quote evidence stops at its twenty-row budget rather than scanning an owner-heavy book');
console.log('PASS source evidence: native quote query, allowed NPC, unknown route, finite inspection budget');

// Native producer -> compact transport -> main consumer. A rich buyer loses
// benefit while waiting even when no earning gap remains in its saved packet.
const NativeData = invoke('GameServer/DataCache'); NativeData.init();
const NativeEconomy = invoke('GameServer/Bot/Economy/EconomyContext');
const nativeState = { ...state, characterId: 90110, phase: 'cold', adena: 1e12,
    inventory: { 57: { selfId: 57, amount: 1e12 } },
    stats: { classId: 1, exp: NativeData.experience[39] + 1 },
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
const nativeDeps = { board: new BoardIndex(), spots: [], npcOffersFor: () => [], tripCost: preparedTrip,
    persona, timestamp: 1000, nodes: [{ key: 'fixture:power', need: 'power', valueHours: 1e9,
        object: { itemId: 101 }, paths: [{ kind: 'owned', price: 100, costHours: 1 }] }] };
const richNative = NativeEconomy.forState(nativeState, nativeDeps);
assert.equal(richNative.network.gap, null);
assert.equal(richNative.statsPacket.money[3], 0);
assert(richNative.gapHorizonHours > 0);
const committedRich = { ...nativeState, stats: { ...nativeState.stats, ...richNative.statsPacket } };
const richTransport = ColdDecision.compact(structuredClone(ColdDecision.capture(richNative, committedRich, nativeState)));
const richView = ColdDecision.view(committedRich, richTransport, nativeDeps);
assert.equal(richView.gapHorizonHours, richNative.gapHorizonHours, 'funded wish urgency reaches the native main-thread consumer');
assert(invoke('GameServer/Bot/Economy/PriceDecision').waitRate(richView) > 0,
    'zero earning gap cannot make waiting free for a rich buyer');
const waitingTransport = ColdDecision.capture({ ...richNative, network: { ...richNative.network, activity: null } }, committedRich);
assert.equal(ColdDecision.view(committedRich, waitingTransport, nativeDeps).gapHorizonHours, richView.gapHorizonHours,
    'waiting for prepared source evidence does not remove an existing wish urgency');
for (const kind of ['shots', 'potions']) {
    const key = `stock:${kind}`, stockWish = { key, object: { kind, amount: 10 }, price: 100 };
    const stockTransport = ColdDecision.capture({ ...richNative, network: {
        queue: [stockWish], focus: [key, 0, 100], gap: null, activity: null } }, committedRich);
    assert.equal(ColdDecision.view(committedRich, stockTransport, nativeDeps).gapHorizonHours,
        NativeEconomy.basics(committedRich, nativeDeps).stock(kind).targetHours,
        'funded stock keeps its own consumption horizon through transport');
}
const emptyTransport = ColdDecision.capture({ ...richNative, network: {
    queue: [], focus: null, gap: null, activity: null } }, committedRich);
assert.equal(ColdDecision.view(committedRich, emptyTransport, nativeDeps).gapHorizonHours, 0,
    'an empty queue has no useful wish urgency');
assert(require('node:v8').serialize(richTransport).byteLength <= ColdDecision.MAX_BYTES);
NativeEconomy.reset();
console.log('PASS native capture/transport/view: rich funded urgency, unknown arrival, stock horizons, empty queue and wire bound');
