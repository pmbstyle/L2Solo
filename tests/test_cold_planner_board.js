// The cold planner sees the board (D2, step 3.3 group B): its offers are the
// NPC rows of the planning catalog and the board lines of the worker's index,
// built from the 'board' table, in the one order with the bot's trip.
const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const { BoardIndex, rowOf, SELL } = require('../src/GameServer/AfkTrade/BoardIndex');
const TableMirror = require('../src/GameServer/Bot/Population/TableMirror');
const ColdNpcPlanningCatalog = require('../src/GameServer/Bot/Population/ColdNpcPlanningCatalog');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

const SHORT_GLOVES = 48;
const mirror = new TableMirror();
const index = new BoardIndex();
mirror.watch('board', index.follower());
const lookup = ColdNpcPlanningCatalog.createLookup(npcPlanningCatalogRows(), () => (mirror.ready('board') ? index : null));
const npc = lookup.bestOffer({ selfId: SHORT_GLOVES }, {}, null);
assert(npc && npc.sourceType === 'npc', 'Short Gloves are sold by an NPC');

const giran = { locX: 83000, locY: 148000, locZ: -3400 };
const buyer = { characterId: 7001, level: 20, adena: 100000, loc: giran, stats: {}, inventory: {} };
const store = (id, ownerId, price, town = 'Giran', botOwned = true) => rowOf({ shopId: id, kind: 'sell_ad', storeType: SELL,
    ownerId, town, botOwned, items: [{ afkTradeLineId: id * 10, selfId: SHORT_GLOVES, enchant: 0, count: 1, price }] });

// Without the table the planner sees the NPC only; a table still loading is
// not read.
assert.strictEqual(lookup.findMarketOffer({ selfId: SHORT_GLOVES }, buyer, giran)?.sourceType, 'npc');
mirror.apply([{ name: 'board', from: null, to: 1, full: true, last: 0, rows: [[1, store(1, 7002, 1)]], removed: [] }]);
assert.strictEqual(lookup.findMarketOffer({ selfId: SHORT_GLOVES }, buyer, giran)?.sourceType, 'npc',
    'a board copy that is not whole is not read');
mirror.apply([{ name: 'board', from: 1, to: 1, full: false, last: 1, rows: [[2, store(2, 7001, 1)]], removed: [] }]);

// A cheaper board line wins; the bot's own never does.
const offer = lookup.findMarketOffer({ selfId: SHORT_GLOVES }, buyer, giran);
assert.strictEqual(offer.sourceType, 'afk_bot_store');
assert.strictEqual(offer.sourceId, 7002, 'the bot\'s own line is skipped');
assert.strictEqual(Planner.marketOfferForTarget({ selfId: SHORT_GLOVES }, buyer, lookup.plannerOptions)?.sourceType,
    'afk_bot_store', 'the cold planner\'s market search sees the board');

// A change follows: the line sold out, a player's line far away costs its trip.
mirror.apply([{ name: 'board', from: 1, to: 2, full: false, rows: [[3, store(3, 7003, Math.max(1, npc.price - 1), 'Aden', false)]],
    removed: [1] }]);
assert.strictEqual(lookup.findMarketOffer({ selfId: SHORT_GLOVES }, buyer, giran)?.sourceType, 'npc',
    'a line one Adena cheaper in a far town does not pay for the trip');
assert.strictEqual(index.list(SHORT_GLOVES, SELL).length, 2);

console.log('Cold planner board checks passed');
