const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

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
    const originalReleaseWarehouse = PopulationService.releaseWarehouseMaterials;
    const originalReconcileMarket = PopulationService.reconcileMarketGoals;
    const originalNextGoalMetadataAt = PopulationService.nextGoalMetadataAt;

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
        PopulationService.goalMetadataRunning = false;
        PopulationService.playerActivityProfile = () => ({ protected: false, realPlayers: 0 });

        let staleCalls = 0;
        LifeState.staleGoalCandidates = async () => {
            staleCalls += 1;
            return [];
        };
        PopulationService.releaseWarehouseMaterials = async () => [];
        PopulationService.reconcileMarketGoals = async () => [];

        const blocker = Governor.admit({
            job: 'clan_actions', resource: 'sqlite-heavy', requestedBudgetMs: 20,
            minimumBudgetMs: 10, timestamp: Date.now(), lagMs: 0, dbPending: 0
        });
        assert.strictEqual(blocker.ok, true);
        const deferred = await PopulationService.reconcileGoalMetadata();
        assert.deepStrictEqual(deferred, []);
        assert.strictEqual(staleCalls, 0, 'goal metadata must not start while the shared SQLite resource is busy');
        assert.strictEqual(Governor.snapshot().jobs.goal_metadata.reasons.resource_busy, 1);
        Governor.complete(blocker.lease, { durationMs: 0 });

        const resolved = await PopulationService.reconcileGoalMetadata();
        assert.deepStrictEqual(resolved, []);
        assert.strictEqual(staleCalls, 1);
        const snapshot = Governor.snapshot();
        assert.strictEqual(snapshot.jobs.goal_metadata.admitted, 1);
        assert.strictEqual(snapshot.jobs.goal_metadata.completed, 1);
        assert.strictEqual(snapshot.jobs.goal_metadata.grantedMs, 60, 'the shared governor must cap the old 1000ms local budget');
        assert.deepStrictEqual(snapshot.resources, {});

        let delayMs = PopulationService.nextGoalMetadataAt - Date.now();
        assert(delayMs > 9000 && delayMs <= 10000, 'an exhausted-free pass must return to its normal cadence');
        PopulationService.releaseWarehouseMaterials = async () => Array.from({ length: 8 }, () => ({}));
        await PopulationService.reconcileGoalMetadata();
        delayMs = PopulationService.nextGoalMetadataAt - Date.now();
        assert(delayMs > 900 && delayMs <= 1000, 'a full batch must continue in the next governor window');
        console.log('Background work governor integration checks passed');
    } finally {
        Object.assign(Config, originalConfig);
        PopulationService.playerActivityProfile = originalProfile;
        LifeState.staleGoalCandidates = originalStaleCandidates;
        PopulationService.releaseWarehouseMaterials = originalReleaseWarehouse;
        PopulationService.reconcileMarketGoals = originalReconcileMarket;
        PopulationService.goalMetadataRunning = false;
        PopulationService.nextGoalMetadataAt = originalNextGoalMetadataAt;
        Governor.reset();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
