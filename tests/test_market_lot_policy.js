const assert = require('assert');
require('../src/Global');
const LotPolicy = invoke('GameServer/Bot/Economy/MarketLotPolicy');

for (const kind of ['Other.Shot', 'Other.Material', 'Weapon.Sword', 'Other.Recipe']) {
    for (const count of [1, 2, 4, 5, 499, 500, Number.MAX_SAFE_INTEGER]) {
        assert.strictEqual(LotPolicy.viable({ kind, selfId: 1865, count, price: 1, basePrice: 1 }), true,
            `${kind} count ${count} reaches the economic decision`);
    }
    for (const count of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
        assert.strictEqual(LotPolicy.viable({ kind, count }), false, `${kind} rejects invalid count ${count}`);
    }
}
assert.strictEqual(LotPolicy.viable({ selfId: 1880, kind: 'Other.Material', count: 1, basePrice: 100000 }), true,
    'a valuable single material has no bulk minimum');
assert.strictEqual(LotPolicy.viable(null), false);
console.log('Market lot policy: positive safe physical counts, no quantity or value thresholds passed');
