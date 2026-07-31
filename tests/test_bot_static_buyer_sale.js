const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');

DataCache.init();

const originals = {
    execute: Database.execute,
    syncInventorySummary: Database.syncInventorySummary
};

async function run() {
    Database.execute = () => Promise.resolve([]);
    Database.syncInventorySummary = () => Promise.resolve();

    const state = {
        characterId: 991,
        name: 'MaterialSeller',
        adena: 100,
        phase: 'cold',
        activity: 'shopping',
        level: 10,
        inventory: {
            57: { selfId: 57, name: 'Adena', amount: 100 },
            1864: { selfId: 1864, name: 'Stem', amount: 10, kind: 'Other.Material' },
            1: { selfId: 1, name: 'Short Sword', amount: 1, kind: 'Weapon.Sword', rank: 'c' }
        },
        stats: {}
    };

    const preview = StaticBuyerService.candidatesFor(state, 'Talking Island');
    assert.strictEqual(preview.length, 1, 'the local buyer should accept listed materials');
    assert.strictEqual(preview[0].selfId, 1864);
    assert(preview[0].npcPrice > 0, 'the buyer price must use its configured rate');
    assert.strictEqual(StaticBuyerService.bestTownFor(state).town, 'Talking Island', 'market travel should target a town that buys the held material');

    const result = await StaticBuyerService.sell(state, 'Talking Island');
    assert.strictEqual(result.sold, true);
    assert.strictEqual(result.state.inventory['1864'].amount, 0, 'accepted materials are removed');
    assert.strictEqual(result.state.inventory['1'].amount, 1, 'equipment remains available for the player market');
    assert.strictEqual(result.state.adena, 100 + preview[0].npcPrice * 10);
    assert.strictEqual(result.state.stats.lastNpcLiquidation.source, 'static_buyer');
    console.log('Bot static buyer sale checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Database.execute = originals.execute;
    Database.syncInventorySummary = originals.syncInventorySummary;
    LifeState.reset?.();
});
