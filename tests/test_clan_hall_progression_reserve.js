const assert = require('assert');
require('../src/Global');
const Policy = invoke('GameServer/ClanHall/Policy');

// Clan money held back from the clan hall: the next level's fund below level 2,
// then only the price of a planned progression purchase. The Blood Mark for
// level 3 is hunted, not bought, so no fixed price is held for it.
const levelGoal = { type: 'level', status: 'executing', target: { level: 3 } };
assert.strictEqual(Policy.progressionReserve({ level: 1 }, levelGoal), Infinity, 'below level 2 the warehouse is the level fund');
assert.strictEqual(Policy.progressionReserve({ level: 2 }, levelGoal), 0, 'no fixed Blood Mark price is held at level 2');
assert.strictEqual(Policy.progressionReserve({ level: 2 }, { type: 'item', status: 'executing', plan: { market: { price: 1200000 } } }), 1200000,
    'a planned purchase stays protected');
assert.strictEqual(Policy.progressionReserve({ level: 2 }, { type: 'item', status: 'completed', plan: { market: { price: 1200000 } } }), 0);
console.log('Clan hall progression reserve checks passed');
