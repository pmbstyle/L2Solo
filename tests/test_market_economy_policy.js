const assert = require('assert');
require('../src/Global');
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const Data = invoke('GameServer/DataCache'); Data.init();
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const Policy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Lot = invoke('GameServer/Bot/Economy/MarketLotPolicy');
const originalStates = Life.allStates;
(async () => {
    assert(!Lot.viable({ selfId: 1865, count: 3, price: 100000000 }), 'inflated prices cannot admit three cheap resources');
    assert(Lot.viable({ selfId: 1804, count: 1, price: 40000 }), 'a single recipe is useful stock');
    for (const selfId of [1463, 1464, 2510, 3948]) {
        assert(!Lot.viable({ selfId, count: 499, price: 1000000 }), 'shots need a useful batch regardless of price');
        assert(Lot.viable({ selfId, count: 500, price: 60 }), '500 shots is a valid batch');
    }
    // A viable material lot is the market's: no fixed shelf of 200 units and
    // no seller limit; each seller's expected value decides (group E).
    const material = { selfId: 1865, kind: 'Other.Material', count: 100, price: 1400, basePrice: 200 };
    const state = { characterId: 1, level: 40, stats: {} };
    assert.strictEqual(Policy.classify(state, material).action, 'market');
    assert.strictEqual(Policy.classify(state, { ...material, count: 3 }).action, 'warehouse', 'a lot too small to list');

    let scans = 0;
    const now = Date.now();
    Life.allStates = () => {
        scans++;
        return Array.from({ length: 1779 }, (_, i) => ({ characterId: i + 1, adena: i === 0 ? 0 : 100,
            inventory: {}, stats: { shotDemand: { itemId: 1463, amount: 3000, maxSpend: 100, at: now } } }));
    };
    Shots._resetForTests();
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const [first, second] = await Promise.all([Shots.marketSnapshot(now), Shots.marketSnapshot(now)]);
    assert.strictEqual(first, second);
    assert(yielded, 'building a population snapshot yields to player traffic');
    assert.strictEqual(scans, 1);
    assert.strictEqual(Shots.fundedDemand(first, 1463, 90, 99999), 1778, 'production demand must be bounded by each wallet');
    assert.strictEqual(Shots.fundedDemand(first, 1463, 101, 99999), 0, 'unfunded demand cannot trigger production');
    for (let i = 0; i < 20; i++) assert.strictEqual(await Shots.marketSnapshot(now + i * 100), first);
    assert.strictEqual(scans, 1, 'one cache serves the whole background pass');
    await Shots.marketSnapshot(now + 31000);
    assert.strictEqual(scans, 2);
    console.log('Market lots, material lots for the market, funded production and cooperative cached snapshot passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Life.allStates = originalStates; Shots._resetForTests();
});
