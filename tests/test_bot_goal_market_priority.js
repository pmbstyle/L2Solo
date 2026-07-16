const assert = require('assert');

require('../src/Global');

const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');

const originals = {
    snapshot: GoalState.snapshot,
    load: GoalState.load,
    set: GoalState.set,
    evaluate: NeedsEvaluator.evaluate,
    plan: GoalPlanner.plan
};

const now = 1000;
const existing = {
    characterId: 9,
    current: {
        type: 'progress_level', status: 'active', nextReviewAt: now + 10 * 60 * 1000,
        plan: { expectedBenefit: 'experience_and_sp' }, createdAt: 1
    }
};
const marketGoal = {
    type: 'sell_inventory', status: 'active', priority: 54, nextReviewAt: now + 10 * 60 * 1000,
    plan: { expectedBenefit: 'market_sale_inventory' }
};

async function run() {
    GoalState.snapshot = () => existing;
    GoalState.load = () => Promise.resolve(existing);
    GoalState.set = (_id, goal) => Promise.resolve({ characterId: 9, current: goal });
    NeedsEvaluator.evaluate = () => [marketGoal];
    GoalPlanner.plan = (candidates) => candidates[0];

    const reviewed = await GoalService.review({ characterId: 9, phase: 'cold' }, { now });
    assert.strictEqual(reviewed.current.type, 'sell_inventory', 'fresh leveling goals must yield to newly accumulated market stock');

    const staleMarket = { ...existing, current: { ...marketGoal, nextReviewAt: now + 10 * 60 * 1000 } };
    GoalState.snapshot = () => staleMarket;
    GoalState.load = () => Promise.resolve(staleMarket);
    NeedsEvaluator.evaluate = () => [{ type: 'progress_level', status: 'active', priority: 35, plan: { expectedBenefit: 'experience_and_sp' } }];
    const cleared = await GoalService.review({ characterId: 9, phase: 'cold' }, { now });
    assert.strictEqual(cleared.current.type, 'progress_level', 'an empty stale market goal must be replaced immediately');
    console.log('Bot market goal priority checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(GoalState, { snapshot: originals.snapshot, load: originals.load, set: originals.set });
    NeedsEvaluator.evaluate = originals.evaluate;
    GoalPlanner.plan = originals.plan;
});
