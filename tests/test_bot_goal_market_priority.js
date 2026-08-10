const assert = require('assert');

require('../src/Global');

const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');

const originals = {
    snapshot: GoalState.snapshot,
    load: GoalState.load,
    set: GoalState.set,
    evaluate: NeedsEvaluator.evaluate,
    plan: GoalPlanner.plan,
    findById: SpotProfiles.findById
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

    let reviewedSpot = null;
    const persistedSpot = { id: 'persisted_spot' };
    SpotProfiles.findById = (spotId) => spotId === persistedSpot.id ? persistedSpot : null;
    NeedsEvaluator.evaluate = (_state, options) => {
        reviewedSpot = options.spot;
        return [{ type: 'progress_level', status: 'active', priority: 35, plan: { expectedBenefit: 'experience_and_sp' }, blockers: [] }];
    };
    await GoalService.review({
        characterId: 9,
        phase: 'cold',
        activity: 'traveling',
        spotId: 'old_spot',
        stats: { marketReturn: { spotId: persistedSpot.id } }
    }, { now });
    assert.strictEqual(reviewedSpot, persistedSpot,
        'a transit goal review must retain its persisted return spot instead of reporting missing_spot');

    const plannedSpot = { id: 'planned_spot' };
    SpotProfiles.findById = (spotId) => spotId === plannedSpot.id ? plannedSpot : null;
    assert.strictEqual(GoalService.reviewSpot({ activity: 'merchant' }, null, {
        plan: { spotId: plannedSpot.id }
    }), plannedSpot, 'a blocked goal must retain its own planned spot when lifecycle routing has no active spot');

    const waitingForMarket = NeedsEvaluator.evaluate({
        characterId: 10,
        level: 30,
        activity: 'hunting',
        adena: 100000,
        inventory: {},
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: {
            marketRetryAfter: now + 1,
            equipmentPlan: {
                marketFallback: true,
                next: { itemId: 1880 },
                materials: [{ selfId: 1880, missing: 20 }]
            }
        }
    }, { now, spot: { id: 'test_spot' } });
    assert(!waitingForMarket.some((goal) => goal.type === 'buy_craft_material'), 'a failed material purchase must not immediately schedule another market trip');
    console.log('Bot market goal priority checks passed');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(GoalState, { snapshot: originals.snapshot, load: originals.load, set: originals.set });
    NeedsEvaluator.evaluate = originals.evaluate;
    GoalPlanner.plan = originals.plan;
    SpotProfiles.findById = originals.findById;
});
