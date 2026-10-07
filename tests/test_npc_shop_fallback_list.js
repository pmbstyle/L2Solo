const assert = require('assert');

require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('rule-c4-fallback');
require('../src/Global');
isolated.assertConfigured(options.default);

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const BuyShop = invoke('GameServer/World/Generics/NpcBypasses/BuyShop');

// C4 no-grade shots are sold by grocers; D+ production stays with crafters.
// The fallback keeps its authored items and adds only the two sourced NG rows.
const rows = NpcShopBuyLists.fetchFallback('grocer');
assert.deepStrictEqual(rows.map((row) => row.selfId), [1060, 1061, 1831, 1833, 736, 737, 1835, 3947, 735, 1062, 1863, 17]);
assert(rows.every((row) => row.price > 0), 'every fallback row has a price');

const session = {
    activeNpcTalk: { selfId: 0 },
    actor: { backpack: { fetchTotalAdena: () => 0 } },
    dataSendToMe() {}
};
BuyShop(session, ['buy', 'grocer']);
assert.deepStrictEqual([...session.activeNpcShop.itemIds], rows.map((row) => row.selfId),
    'the fallback window offers the grocer items');

console.log('NPC shop fallback list checks passed');

assert(!rows.some(row => [1463,1464,1465,1466,1467,2510,2511,2512,2513,2514,3948,3949,3950,3951,3952].includes(row.selfId)), 'fallback cannot create D+ shot supply');
require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
