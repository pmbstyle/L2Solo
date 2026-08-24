const assert = require('assert');

require('../src/Global');

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

const originals = {
    candidates: LifeState.marketGoalCandidates,
    upsert: LifeState.upsertState,
    reviewBatch: GoalService.reviewBatch,
    travel: GoalExecutor.beginMarketTravel,
    spot: SpotProfiles.findForState
};

async function run() {
    const seller = { characterId: 51, name: 'Seller', phase: 'cold', activity: 'hunting', loc: { locX: 1, locY: 2, locZ: 3 }, stats: {} };
    LifeState.marketGoalCandidates = () => Promise.resolve([seller]);
    SpotProfiles.findForState = () => null;
    GoalService.reviewBatch = (states, options) => {
        assert.strictEqual(options.optionsForState(states[0]).spot, null);
        return Promise.resolve(states.map(() => ({
            current: { type: 'sell_inventory', plan: { expectedBenefit: 'market_sale_inventory' } }
        })));
    };
    GoalExecutor.beginMarketTravel = (state) => ({ ...state, activity: 'traveling' });
    const saved = [];
    LifeState.upsertState = (state) => {
        saved.push(state);
        return Promise.resolve(state);
    };

    const result = await PopulationService.reconcileMarketGoals();
    assert.strictEqual(result.length, 1);
    assert.strictEqual(saved[0].activity, 'traveling', 'reconcile should immediately begin a valid market trip');
    console.log('Bot market goal reconcile checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    LifeState.marketGoalCandidates = originals.candidates;
    LifeState.upsertState = originals.upsert;
    GoalService.reviewBatch = originals.reviewBatch;
    GoalExecutor.beginMarketTravel = originals.travel;
    SpotProfiles.findForState = originals.spot;
});
