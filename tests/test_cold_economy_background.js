const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const originals = [];
function replace(object, key, value) {
    originals.push(() => { object[key] = value; });
    object[key] = value;
}
(async () => {
    const state = { characterId: 1, phase: 'cold', activity: 'hunting', simulation: { ownerId: 'worker' } };
    const calls = [];
    replace(Population, 'runGovernedGoalBackgroundJob', job => job.run({ batchSize: 1, deadlineAt: Date.now() + 1000 }));
    replace(Shots, 'candidates', async () => [state]);
    replace(Life, 'snapshot', () => state);
    replace(Coordinator, 'withEconomyState', async (current, work) => {
        calls.push('fence');
        const result = await work({ ...current, simulation: { ownerId: 'legacy' } });
        calls.push('release');
        return result;
    });
    replace(Shots, 'review', async current => {
        assert.strictEqual(current.simulation.ownerId, 'legacy');
        calls.push('shots');
        return { state: { ...current, adena: 100 }, crafted: true };
    });
    replace(Wealth, 'tryCraft', async current => {
        assert.strictEqual(current.adena, 100, 'general craft must use the post-shot wallet');
        calls.push('wealth');
        return { state: { ...current, adena: 80 }, crafted: false };
    });
    replace(Market, 'reconcile', async current => {
        assert.strictEqual(current.adena, 80);
        calls.push('publish');
    });
    await Population.reconcileShotEconomyBatch();
    assert.deepStrictEqual(calls, ['fence', 'shots', 'wealth', 'release', 'publish'],
        'ordinary worker hunters must receive both economy reviews in the governed background batch');
    calls.length = 0;
    replace(Shots, 'review', async current => ({ state: { ...current, adena: 100,
        stats: { shotCraft: { productId: 1463 } }, inventory: { 1463: { selfId: 1463, amount: 3000 } } }, crafted: false }));
    await Population.reconcileShotEconomyBatch();
    assert.deepStrictEqual(calls, ['fence', 'wealth', 'release', 'publish'],
        'existing crafted stock must return to market even when no new batch is produced');
    calls.length = 0;
    replace(Coordinator, 'withEconomyState', async current => ({ state: current, reason: 'economy_busy' }));
    await Population.reconcileShotEconomyBatch();
    assert.deepStrictEqual(calls, [], 'a busy worker state must not trigger publication outside its admitted review');
    console.log('Worker hunter economy scheduling, serialized reviews and fresh state propagation passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    originals.reverse().forEach(restore => restore());
});
