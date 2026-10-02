const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const BuyShop = invoke('GameServer/World/Generics/NpcBypasses/BuyShop');

// The fallback grocer list opens a buy window with its items; shots are
// left to crafters and static traders, as on every NPC list.
const rows = NpcShopBuyLists.fetchFallback('grocer');
assert.deepStrictEqual(rows.map((row) => row.selfId), [1060, 1061, 1831, 1833, 736, 737, 735, 1062, 1863, 17]);
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
