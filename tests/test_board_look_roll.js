'use strict';
// The own_lines look (BoardLook.review): taken at its situations only, it looks at
// every own priced line against the board as it stands, with no memory of an earlier
// look; MarketPricing.look answers each line by its reasons.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const at = 1800000000000;
const state = { characterId: 42, stats: {} };
const line = { ownerId: 42, lineId: 7, recordId: 8, selfId: 1864, price: 120000, count: 1,
    storeType: 1, revision: 4, pricing: { seenCounter: 3, seenAt: at - 4 * 3600000 } };
const ctx = { characterId: 42, timestamp: at, hour: 76797, adena: 1e9, trader: { wait: 0 } };
const saved = Pricing.look;
try {
    const reviewed = [];
    Pricing.look = (_, lines, lookCtx) => { reviewed.push(...lines.map(x => [x.lineId, lookCtx.reviewReasons.get(x.lineId)])); return null; };
    const review = (lines, extra = {}, options = {}) => { reviewed.length = 0; Pricing.lookOwn(state, lines, { ...ctx, ...extra }, options); return [...reviewed]; };
    assert.deepEqual(review([]), [], 'no lines, no look');
    const many = Array.from({ length: 16 }, (_, i) => ({ ...line, lineId: 100 + i }));
    assert.equal(review(many).length, 14, 'every own line up to the native cap of 14');
    assert.deepEqual(review([line, line]).map(([, reason]) => reason), [1, 1], 'a look reads the board as it stands: no memory');
    assert.deepEqual(review([{ ...line, ownerId: 43 }, { ...line, lineId: 8, count: 0 }, { ...line, lineId: 9, pricing: null }]), [],
        'another owner\'s line, a sold-out line and an unpriced line are not its own to price');
    assert.deepEqual(review([{ ...line, fills: 1, pricing: { ...line.pricing, seenFills: 0 } }]), [[7, 3]], 'a fill since its price was set');
    const bid = { ...line, lineId: 22, selfId: 1865, storeType: 3, price: 1000, count: 2, pricing: { ...line.pricing, worth: 3e5 } };
    const worth = value => ({ preparedWorth: () => value });
    assert.deepEqual(review([bid], worth(3e5)), [[22, 1]], 'a bid whose worth stands');
    assert.deepEqual(review([bid], worth(6e5)), [[22, 5]], 'a bid whose worth moved is priced again');
    assert.deepEqual(review([bid], worth(3e5), { visit: true }), [[22, 9]], 'a bid looked at on a town visit');
    assert.deepEqual(review([{ ...bid, custodyPolicy: 1 }], { ...worth(3e5), adena: 0 }), [[22, 5]], 'a conditional bid above the cash it can pay');
} finally {
    Pricing.look = saved;
}
console.log('PASS own lines look: every own priced line, no memory, its reasons');
