// Materials go to the gnomes: the configured fixed buyers (static_wtb) take nothing
// from a bot, a gnome included, and anything from a player; an Artisan or Warsmith keeps buy lines for the materials of
// the C/B recipes its Create Item level reaches at 1.2x the NPC buy-back.
const assert = require('assert');

require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('gnome-material-bids');
require('../src/Global');
isolated.assertConfigured(options.default);

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const World = invoke('GameServer/World/World');
World.user = { sessions: [], revision: 0 };

const Configs = invoke('GameServer/Bot/MerchantStoreConfigs');
const ItemTemplateIndex = invoke('GameServer/Item/ItemTemplateIndex');
const TradeService = invoke('GameServer/Bot/TradeService');
const Stock = invoke('GameServer/Bot/Economy/CrafterStock');
const BuyAds = invoke('GameServer/Bot/Economy/BuyAdPolicy');
const NpcSell = invoke('GameServer/Items/NpcSellRules');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');

const template = id => ItemTemplateIndex.find(DataCache.items, id);
const buyer = Object.values(Configs).find((store) => Number(store?.storeType) === 3 && store.town
    && (store.items || []).some(line => String(template(line.selfId)?.template?.kind || '').startsWith('Other.Material')));
const MATERIAL = Number(buyer.items.find(line => String(template(line.selfId)?.template?.kind || '').startsWith('Other.Material')).selfId);

const bot = (classId, extra = {}) => ({ characterId: 997000 + classId, accountName: `bot_${997000 + classId}`, name: `Bot${classId}`,
    level: 50, phase: 'cold', currentRegion: 'Giran', adena: 500000000, inventory: {},
    stats: { classId, generatedCold: true }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, ...extra });
const gladiator = bot(2), warsmith = bot(57);

// 1. The hot sale at the fixed buyer's window: a Gladiator and a Warsmith bot are refused, a player is admitted.
const store = { storeType: 3, items: TradeService.normalizeStoreItems(buyer, { staticStore: true }) };
const item = { fetchSelfId: () => MATERIAL, fetchAmount: () => 10, fetchEquipped: () => false, fetchId: () => 1,
    fetchName: () => 'material', fetchKind: () => template(MATERIAL).template.kind, fetchEnchantLevel: () => 0 };
const actor = (classId, botSession) => ({ session: botSession ? { botSession: true, accountId: 'bot_1' } : { accountId: 'player' },
    fetchClassId: () => classId, fetchId: () => 1000 + classId, backpack: { fetchItems: () => [item], fetchTotalAdena: () => 0 } });
const sold = (seller, state) => TradeService.previewSaleToStore(seller, store, { state }).itemCount;
assert.strictEqual(sold(actor(2, true), gladiator), 0, 'the fixed buyer refuses a Gladiator bot\'s material');
assert.strictEqual(sold(actor(57, true), warsmith), 0, 'the fixed buyer refuses a Warsmith bot\'s material');
assert(sold(actor(2, false), null) > 0, 'the fixed buyer buys a player\'s material');

// 2. A Warsmith bids only for the materials of the pieces it stocks or some town wants:
// with neither it posts no material bid.
const Recipes = require('../src/GameServer/Knowledge/RecipeCatalog').recipeItemRows(invoke('GameServer/Items/C4RecipeItems'));
const craftLevel = state => invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state);
const allows = recipe => invoke('GameServer/Items/ItemAcquisitionCatalog').allowsRecipe(recipe);
const rank = id => String(template(id)?.etc?.rank || '').toLowerCase();
const reached = state => Recipes.filter(recipe => recipe.type === 'dwarven' && Number(recipe.level) > 0
    && Number(recipe.level) <= craftLevel(state) && Array.isArray(recipe.materials) && allows(recipe));
assert.deepStrictEqual(Stock.materialBids(warsmith, { board: new BoardIndex({ groupOf: MarketCounters.counterOf }) }), [],
    'a Warsmith whose pieces nobody wants and who stocks none bids for nothing');

// 3. A B weapon recipe its level reaches, wanted in Giran (another bot's buy line):
// the Warsmith bids for the recipe's part at 1.2x the NPC buy-back, its buy lines carry
// the bid, and a Bounty Hunter holding spoiled parts fills it.
const bRecipe = reached(warsmith).find(recipe => rank(recipe.productId) === 'b'
    && String(template(recipe.productId)?.template?.kind || '').startsWith('Weapon.'));
assert(bRecipe, 'a level-50 Warsmith reaches a B weapon recipe');
const PART = Number(bRecipe.materials.find(row => String(template(row.selfId)?.template?.kind || '').startsWith('Other.Material')).selfId);
const demandBoard = new BoardIndex({ groupOf: MarketCounters.counterOf });
demandBoard.put({ id: 990001, kind: 'buy_ad', storeType: 3, ownerId: 990002, town: 'Giran',
    lines: [{ lineId: 990003, selfId: Number(bRecipe.productId), count: 1, price: 1000000, enchant: 0 }] });
const bids = Stock.materialBids(warsmith, { board: demandBoard });
const partBid = bids.find(line => line.selfId === PART);
assert(partBid, `a Warsmith bids for the part ${PART} of the wanted B weapon ${bRecipe.productId}`);
assert.strictEqual(partBid.price, Math.min(Math.floor(1.2 * NpcSell.npcBuyPrice(Number(template(PART).template.price))),
    invoke('GameServer/Bot/Economy/StaticMerchantPricing').buyCeiling(PART)), 'the part bid is 1.2x the NPC buy-back, under the buy ceiling');
assert.strictEqual(partBid.count, Stock.MATERIAL_BID_UNITS, 'it bids for the standing units it lacks');
const lines = BuyAds.linesFor(warsmith, null, { watchList: [], townFor: () => 'Giran', board: demandBoard });
assert(lines.some(line => line.selfId === bids[0].selfId && line.price === bids[0].price && line.count > 0), 'its buy lines carry its first material bid');
assert(lines.length <= invoke('GameServer/AfkTrade/BoardRules').buyWants(warsmith),
    'within the bot\'s buy lines (a dwarf\'s buy store of 5 lines, and its buy ads)');
const bidBoard = new BoardIndex({ groupOf: MarketCounters.counterOf });
bidBoard.put({ id: 990010, kind: 'buy_ad', storeType: 3, ownerId: warsmith.characterId, town: 'Giran',
    lines: [{ lineId: 990011, selfId: PART, count: partBid.count, price: partBid.price, enchant: 0 }] });
const spoiler = bot(55, { inventory: { [PART]: { selfId: PART, amount: 12, kind: 'Other.Material' } } });
const sameTown = () => 0;
sameTown.details = () => ({ known: true, fees: 0, hours: 0 });
const sale = invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate(spoiler, { now: Date.now(), board: bidBoard, persona: null,
    npcOffersFor: () => [], findSpot: () => null, tripCost: sameTown, keptAmounts: {}, preparedReservations: {} });
assert.deepStrictEqual(sale.answers.map(row => [row.item.selfId, Number(row.line.recordId), row.count]), [[PART, 990010, 12]],
    'a Bounty Hunter sells its spoiled parts into the Warsmith\'s bid');

// 4. A piece it stocks (a gnomeStock row) opens its recipe's bids without any demand.
const cRecipe = reached(warsmith).find(recipe => rank(recipe.productId) === 'c');
const stocking = bot(57, { stats: { classId: 57, generatedCold: true, gnomeStock: { [cRecipe.productId]: { cost: 1000, ceiling: 2000, owed: 1 } } } });
const cBids = Stock.materialBids(stocking, { board: new BoardIndex({ groupOf: MarketCounters.counterOf }) });
const cMaterial = cBids.find(line => cRecipe.materials.some(row => Number(row.selfId) === line.selfId));
assert(cMaterial, 'a Warsmith that stocks a C piece bids for its recipe\'s materials');
// At x50 the bid stays 1.2x the NPC buy-back: the drop rate already multiplies the units.
const Rates = invoke('GameServer/ProgressionRates'), preset = process.env.L2NODE_PROGRESSION_RATE;
try {
    process.env.L2NODE_PROGRESSION_RATE = 'x50';
    Rates.reset();
    const npcSold = invoke('GameServer/Bot/Economy/BotMarketPricing').npcPriceOf(cMaterial.selfId) < Infinity;
    if (!npcSold) assert.strictEqual(Stock.materialBids(stocking, { board: null }).find(line => line.selfId === cMaterial.selfId).price, cMaterial.price,
        'x50: the bid is 1.2x the NPC buy-back, as at x1');
    // A gemstone the NPC sells (D, C, B: 2130-2132): at x50 the bid stays at most 0.9 x
    // the NPC price, so nobody buys it from the NPC to sell it to the crafter.
    const NpcPrices = invoke('GameServer/Bot/Economy/BotMarketPricing');
    const master = bot(57, { level: 76, characterId: warsmith.characterId });
    master.stats.gnomeStock = Object.fromEntries(reached(master).map(recipe => [recipe.productId, { cost: 1, ceiling: 1, owed: 0 }]));
    const capped = Stock.materialBids(master).filter(line => [2130, 2131, 2132].includes(line.selfId));
    assert.deepStrictEqual(capped.map(line => line.selfId).sort(), [2130, 2131, 2132], 'a Create Item 10 Warsmith bids for the D, C and B gemstones');
    for (const line of capped) {
        assert(line.price <= Math.floor(0.9 * NpcPrices.npcPriceOf(line.selfId)),
            `x50: the gemstone ${line.selfId} bid ${line.price} stays under 0.9 x the NPC price ${NpcPrices.npcPriceOf(line.selfId)}`);
    }
} finally {
    if (preset === undefined) delete process.env.L2NODE_PROGRESSION_RATE; else process.env.L2NODE_PROGRESSION_RATE = preset;
    Rates.reset();
}
assert.deepStrictEqual(Stock.materialBids(gladiator, { board: demandBoard }), [], 'a Gladiator keeps no material bids');
const otherSmith = bot(57, { characterId: warsmith.characterId + 1, stats: stocking.stats });
assert.notStrictEqual(Stock.materialBids(otherSmith)[0].selfId, cBids[0].selfId,
    'two Warsmiths of one level start their material bids at different materials');

console.log('test_gnome_material_bids OK');
