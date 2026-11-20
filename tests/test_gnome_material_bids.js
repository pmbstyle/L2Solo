// Materials go to the gnomes: the configured fixed buyers (static_wtb) take a bot's
// materials only from a gnome (Scavenger, Bounty Hunter, Artisan, Warsmith) and
// anything from a player; an Artisan or Warsmith keeps buy lines for the materials of
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
const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources');
const Stock = invoke('GameServer/Bot/Economy/CrafterStock');
const BuyAds = invoke('GameServer/Bot/Economy/BuyAdPolicy');
const NpcSell = invoke('GameServer/Items/NpcSellRules');

const template = id => ItemTemplateIndex.find(DataCache.items, id);
const [buyerName, buyer] = Object.entries(Configs).find(([, store]) => Number(store?.storeType) === 3 && store.town
    && (store.items || []).some(line => String(template(line.selfId)?.template?.kind || '').startsWith('Other.Material')));
const MATERIAL = Number(buyer.items.find(line => String(template(line.selfId)?.template?.kind || '').startsWith('Other.Material')).selfId);

const bot = (classId, extra = {}) => ({ characterId: 997000 + classId, accountName: `bot_${997000 + classId}`, name: `Bot${classId}`,
    level: 50, phase: 'cold', currentRegion: 'Giran', adena: 500000000, inventory: {},
    stats: { classId, generatedCold: true }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, ...extra });
const gladiator = bot(2), warsmith = bot(57);

// 1. The cold readers of the fixed buyers: a non-gnome bot sees none, a Warsmith sees them.
assert.deepStrictEqual(Sources.fixedBuyerOffersFor(MATERIAL, gladiator), [], 'a Gladiator has no fixed buyer for a material');
assert(Sources.fixedBuyerOffersFor(MATERIAL, warsmith).some(exit => exit.buyerName === buyerName), 'a Warsmith sells the material to the fixed buyer');

// 2. The hot sale at the fixed buyer's window: a Gladiator bot is refused, a Warsmith bot and a player are admitted.
const store = { storeType: 3, items: TradeService.normalizeStoreItems(buyer, { staticStore: true }) };
const item = { fetchSelfId: () => MATERIAL, fetchAmount: () => 10, fetchEquipped: () => false, fetchId: () => 1,
    fetchName: () => 'material', fetchKind: () => template(MATERIAL).template.kind, fetchEnchantLevel: () => 0 };
const actor = (classId, botSession) => ({ session: botSession ? { botSession: true, accountId: 'bot_1' } : { accountId: 'player' },
    fetchClassId: () => classId, fetchId: () => 1000 + classId, backpack: { fetchItems: () => [item], fetchTotalAdena: () => 0 } });
const sold = (seller, state) => TradeService.previewSaleToStore(seller, store, { state }).itemCount;
assert.strictEqual(sold(actor(2, true), gladiator), 0, 'the fixed buyer refuses a Gladiator bot\'s material');
assert(sold(actor(57, true), warsmith) > 0, 'the fixed buyer buys a Warsmith bot\'s material');
assert(sold(actor(2, false), null) > 0, 'the fixed buyer buys a player\'s material');

// 3. A level-50 Warsmith bids for a C recipe's material at 1.2x the NPC buy-back,
// and its buy lines carry the bids.
const Recipes = require('../src/GameServer/Knowledge/RecipeCatalog').recipeItemRows(invoke('GameServer/Items/C4RecipeItems'));
const bids = Stock.materialBids(warsmith);
const cMaterials = new Set(Recipes.filter(recipe => recipe.type === 'dwarven' && Number(recipe.level) <= invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(warsmith)
    && String(template(recipe.productId)?.etc?.rank || '').toLowerCase() === 'c').flatMap(recipe => recipe.materials.map(row => Number(row.selfId))));
const cBid = bids.find(line => cMaterials.has(line.selfId));
assert(cBid, 'a Warsmith bids for a C recipe material');
assert.strictEqual(cBid.price, Math.floor(1.2 * NpcSell.npcBuyPrice(Number(template(cBid.selfId).template.price))), 'the bid is 1.2x the NPC buy-back');
assert.strictEqual(cBid.count, Stock.MATERIAL_BID_UNITS, 'it bids for the standing units it lacks');
assert.deepStrictEqual(Stock.materialBids(gladiator), [], 'a Gladiator keeps no material bids');
const otherSmith = bot(57, { characterId: warsmith.characterId + 1 });
assert.notStrictEqual(Stock.materialBids(otherSmith)[0].selfId, bids[0].selfId,
    'two Warsmiths of one level start their material bids at different materials');
const lines = BuyAds.linesFor(warsmith, null, { watchList: [], townFor: () => 'Giran' });
assert(lines.some(line => line.selfId === cBid.selfId && line.price === cBid.price && line.count > 0), 'its buy lines carry the material bid');
assert(lines.length <= 8, 'within the bot\'s buy lines');

console.log('test_gnome_material_bids OK');
