const assert = require('assert');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('market-economy-policy');
require('../src/Global');
isolated.assertConfigured(options.default);
process.env.L2NODE_PROGRESSION_RATE = 'x10';
const Data = invoke('GameServer/DataCache'); Data.init();
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const Policy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Lot = invoke('GameServer/Bot/Economy/MarketLotPolicy');
const originalStates = Life.allStates;
(async () => {
    // No fixed lot minimum by quantity or value (45a13735): every safe
    // physical count reaches the seller's economic decision.
    assert(Lot.viable({ selfId: 1865, count: 3, price: 100000000 }), 'a small lot reaches the economic decision');
    assert(Lot.viable({ selfId: 1804, count: 1, price: 40000 }), 'a single recipe is useful stock');
    for (const selfId of [1463, 1464, 2510, 3948]) {
        assert(Lot.viable({ selfId, count: 499, price: 1000000 }), 'a shot lot below 500 is not refused by count');
        assert(Lot.viable({ selfId, count: 500, price: 60 }), '500 shots is a valid batch');
    }
    // A viable material lot is the market's: no fixed shelf of 200 units and
    // no seller limit; each seller's expected value decides (group E).
    const material = { selfId: 1865, kind: 'Other.Material', count: 100, price: 1400, basePrice: 200 };
    const state = { characterId: 1, level: 40, stats: {} };
    assert.strictEqual(Policy.classify(state, material).action, 'market');
    assert.strictEqual(Policy.classify(state, { ...material, count: 3 }).action, 'market', 'a small lot is the market\'s too');

    let scans = 0;
    const now = Date.now();
    // The shot catalogue subscribes before native lifecycle publications.
    // Its index receives each owner delta; snapshots do not rescan a roster.
    Shots.marketSnapshot(now);
    Life.allStates = () => { scans++; throw Error('market snapshot enumerated the population'); };
    const rows = Array.from({ length: 1779 }, (_, i) => ({ characterId: i + 1,
        phase: 'cold', adena: i === 0 ? 0 : 100, inventorySummary: '{}',
        statsJson: JSON.stringify({ shotDemand: { itemId: 1463, amount: 3000, maxSpend: 100, at: now } }),
        simulationRevision: 1, updatedAt: now }));
    for (const row of rows) Life.acceptLifecycleRow(row);
    const [first, second] = await Promise.all([Shots.marketSnapshot(now), Shots.marketSnapshot(now)]);
    // unlistedSupply is now only the claimed owner's own projection, built per
    // call; no foreign-bag vector is shared (71143511).
    for (const key of ['shotDemand', 'shotSupply', 'shotMinPrice', 'recipeStock', 'recipeHolders']) {
        assert.strictEqual(first[key], second[key], `${key} reuses its native incremental view`);
    }
    assert.strictEqual(scans, 0);
    // Production demand is public bids only (71143511): a foreign bot's private
    // shot want and wallet are never read (public bids: test_shot_market_index).
    assert.strictEqual(Shots.fundedDemand(first, 1463, 1, 99999), 0, 'private wants are not production demand');
    const nativeView = first.shotDemand.get(1463);
    for (let i = 0; i < 20; i++) {
        const current = await Shots.marketSnapshot(now + i * 100);
        assert.strictEqual(current.shotDemand.get(1463), nativeView, 'snapshot reuses the readonly public view');
    }
    Life.acceptLifecycleRow({ ...rows[1], adena: 0, simulationRevision: 2 });
    Life.acceptLifecycleRow({ ...rows[2], phase: 'hot', simulationRevision: 2 });
    const later = Shots.marketSnapshot(now + 31 * 60000);
    assert.strictEqual(later.shotDemand.get(1463), nativeView, 'owner wallet and phase deltas leave the public view unchanged');
    assert.strictEqual(Shots.fundedDemand(later, 1463, 1, 99999), 0);
    assert.strictEqual(scans, 0, 'repeated snapshots, time passage and owner deltas never rescan the population');
    console.log('Market lots, material lots for the market, public-only production demand and incremental native snapshot passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Life.allStates = originalStates; Shots._resetForTests();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});
