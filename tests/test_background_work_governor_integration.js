const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');

async function main() {
    const originalConfig = {
        backgroundGovernorEnabled: Config.backgroundGovernorEnabled,
        backgroundGovernorWindowMs: Config.backgroundGovernorWindowMs,
        backgroundGovernorIdleBudgetMs: Config.backgroundGovernorIdleBudgetMs,
        backgroundGovernorPlayerBudgetMs: Config.backgroundGovernorPlayerBudgetMs,
        backgroundGovernorIdleDbQueueMax: Config.backgroundGovernorIdleDbQueueMax,
        backgroundGovernorPlayerDbQueueMax: Config.backgroundGovernorPlayerDbQueueMax,
        backgroundGovernorLagAbortMs: Config.backgroundGovernorLagAbortMs,
        backgroundJobTickMs: Config.backgroundJobTickMs,
        goalMetadataReconcileIntervalMs: Config.goalMetadataReconcileIntervalMs,
        goalMetadataIdleBudgetMs: Config.goalMetadataIdleBudgetMs,
        goalMetadataIdleBatchSize: Config.goalMetadataIdleBatchSize,
        maxWarehouseReleasesPerTick: Config.maxWarehouseReleasesPerTick
    };
    const originalProfile = PopulationService.playerActivityProfile;
    const originalStaleCandidates = LifeState.staleGoalCandidates;
    const originalReviewBatch = GoalService.reviewBatch;
    const originalReleaseWarehouse = PopulationService.releaseWarehouseMaterials;
    const originalReconcileMarket = PopulationService.reconcileMarketGoals;
    const originalRuntime = {
        staleGoalReviewRunning: PopulationService.staleGoalReviewRunning,
        warehouseReleaseRunning: PopulationService.warehouseReleaseRunning,
        marketGoalReconcileRunning: PopulationService.marketGoalReconcileRunning,
        nextStaleGoalReviewAt: PopulationService.nextStaleGoalReviewAt,
        nextWarehouseReleaseAt: PopulationService.nextWarehouseReleaseAt,
        nextMarketGoalReconcileAt: PopulationService.nextMarketGoalReconcileAt
    };

    try {
        Object.assign(Config, {
            backgroundGovernorEnabled: true,
            backgroundGovernorWindowMs: 1000,
            backgroundGovernorIdleBudgetMs: 60,
            backgroundGovernorPlayerBudgetMs: 30,
            backgroundGovernorIdleDbQueueMax: 8,
            backgroundGovernorPlayerDbQueueMax: 0,
            backgroundGovernorLagAbortMs: 120,
            backgroundJobTickMs: 250,
            goalMetadataReconcileIntervalMs: 10000,
            goalMetadataIdleBudgetMs: 1000,
            goalMetadataIdleBatchSize: 32,
            maxWarehouseReleasesPerTick: 8
        });
        Governor.reset();
        PopulationService.staleGoalReviewRunning = false;
        PopulationService.warehouseReleaseRunning = false;
        PopulationService.marketGoalReconcileRunning = false;
        PopulationService.playerActivityProfile = () => ({ protected: false, realPlayers: 0 });

        let staleCalls = 0;
        LifeState.staleGoalCandidates = async () => {
            staleCalls += 1;
            return [];
        };
        GoalService.reviewBatch = async (states) => states;
        PopulationService.releaseWarehouseMaterials = async () => [];
        PopulationService.reconcileMarketGoals = async () => [];

        const blocker = Governor.admit({
            job: 'clan_actions', resource: 'sqlite-heavy', requestedBudgetMs: 20,
            minimumBudgetMs: 10, timestamp: Date.now(), lagMs: 0, dbPending: 0
        });
        assert.strictEqual(blocker.ok, true);
        const deferred = await PopulationService.reconcileStaleGoals();
        assert.deepStrictEqual(deferred, []);
        assert.strictEqual(staleCalls, 0, 'goal metadata must not start while the shared SQLite resource is busy');
        assert.strictEqual(Governor.snapshot().jobs.goal_stale_review.reasons.resource_busy, 1);
        Governor.complete(blocker.lease, { durationMs: 0 });

        const resolved = await PopulationService.reconcileStaleGoals();
        assert.deepStrictEqual(resolved, []);
        assert.strictEqual(staleCalls, 1);
        const snapshot = Governor.snapshot();
        assert.strictEqual(snapshot.jobs.goal_stale_review.admitted, 1);
        assert.strictEqual(snapshot.jobs.goal_stale_review.completed, 1);
        assert.strictEqual(snapshot.jobs.goal_stale_review.grantedMs, 60, 'the shared governor must cap the old 1000ms local budget');
        assert.deepStrictEqual(snapshot.resources, {});

        let delayMs = PopulationService.nextStaleGoalReviewAt - Date.now();
        assert(delayMs > 9000 && delayMs <= 10000, 'an exhausted-free pass must return to its normal cadence');

        Governor.reset();
        LifeState.staleGoalCandidates = async () => Array.from({ length: 32 }, (_, index) => ({
            characterId: index + 1,
            phase: 'cold'
        }));
        await PopulationService.reconcileStaleGoals();
        delayMs = PopulationService.nextStaleGoalReviewAt - Date.now();
        assert(delayMs > 900 && delayMs <= 1000, 'a full stale-goal batch must continue in the next governor window');

        Governor.reset();
        PopulationService.releaseWarehouseMaterials = async () => Array.from({ length: 8 }, () => ({}));
        await PopulationService.reconcileWarehouseReleases();
        delayMs = PopulationService.nextWarehouseReleaseAt - Date.now();
        assert(delayMs > 900 && delayMs <= 1000, 'a full warehouse batch must continue independently');

        Governor.reset();
        PopulationService.reconcileMarketGoals = async () => {
            const results = [];
            Object.defineProperty(results, 'candidateCount', { value: 32 });
            return results;
        };
        await PopulationService.reconcileMarketGoalBatch();
        delayMs = PopulationService.nextMarketGoalReconcileAt - Date.now();
        assert(delayMs > 900 && delayMs <= 1000, 'a full market batch must continue independently');
        console.log('Background work governor integration checks passed');
    } finally {
        Object.assign(Config, originalConfig);
        PopulationService.playerActivityProfile = originalProfile;
        LifeState.staleGoalCandidates = originalStaleCandidates;
        GoalService.reviewBatch = originalReviewBatch;
        PopulationService.releaseWarehouseMaterials = originalReleaseWarehouse;
        PopulationService.reconcileMarketGoals = originalReconcileMarket;
        Object.assign(PopulationService, originalRuntime);
        Governor.reset();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
