const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ClanConfig = invoke('GameServer/Clan/ClanSimulationConfig');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const BackgroundJobRegistry = invoke('GameServer/Bot/Population/BackgroundJobRegistry');

async function main() {
    const original = {
        registry: PopulationService.backgroundJobRegistry,
        resolveClanActions: PopulationService.resolveClanActions,
        resolveClanFounders: PopulationService.resolveClanFounders,
        reconcileStaleGoals: PopulationService.reconcileStaleGoals,
        reconcileWarehouseReleases: PopulationService.reconcileWarehouseReleases,
        reconcileMarketGoalBatch: PopulationService.reconcileMarketGoalBatch,
        backgroundJobTickMs: Config.backgroundJobTickMs,
        backgroundResolverEnabled: Config.backgroundResolverEnabled,
        goalMetadataReconcileIntervalMs: Config.goalMetadataReconcileIntervalMs,
        clanEnabled: ClanConfig.enabled,
        clanIntervalMs: ClanConfig.resolveIntervalMs
    };

    try {
        PopulationService.backgroundJobRegistry?.stop();
        PopulationService.backgroundJobRegistry = null;
        Object.assign(Config, {
            backgroundJobTickMs: 250,
            backgroundResolverEnabled: true,
            goalMetadataReconcileIntervalMs: 10000
        });
        ClanConfig.enabled = true;
        ClanConfig.resolveIntervalMs = 60000;
        let actionRuns = 0;
        let founderRuns = 0;
        let staleRuns = 0;
        let warehouseRuns = 0;
        let marketRuns = 0;
        PopulationService.resolveClanActions = async () => { actionRuns += 1; return {}; };
        PopulationService.resolveClanFounders = async () => { founderRuns += 1; return {}; };
        PopulationService.reconcileStaleGoals = async () => { staleRuns += 1; return []; };
        PopulationService.reconcileWarehouseReleases = async () => { warehouseRuns += 1; return []; };
        PopulationService.reconcileMarketGoalBatch = async () => { marketRuns += 1; return []; };

        const registry = PopulationService.startBackgroundJobRegistry();
        await new Promise((resolve) => setImmediate(resolve));
        const snapshot = BackgroundJobRegistry.snapshot();
        assert.strictEqual(snapshot.registered, 5);
        assert.strictEqual(snapshot.tickMs, 250);
        assert.strictEqual(snapshot.jobs.clan_actions.offsetMs, 0);
        assert.strictEqual(snapshot.jobs.goal_stale_review.offsetMs, 2500);
        assert.strictEqual(snapshot.jobs.goal_warehouse_release.offsetMs, 2750);
        assert.strictEqual(snapshot.jobs.goal_market_reconcile.offsetMs, 3000);
        assert.strictEqual(snapshot.jobs.clan_founders.offsetMs, 30000);
        assert.strictEqual(actionRuns, 1, 'only the zero-offset action pass should run at startup');
        assert.strictEqual(staleRuns, 0);
        assert.strictEqual(warehouseRuns, 0);
        assert.strictEqual(marketRuns, 0);
        assert.strictEqual(founderRuns, 0);
        registry.stop();
        PopulationService.backgroundJobRegistry = null;
        console.log('Background job registry integration checks passed');
    } finally {
        PopulationService.backgroundJobRegistry?.stop();
        PopulationService.backgroundJobRegistry = original.registry;
        PopulationService.resolveClanActions = original.resolveClanActions;
        PopulationService.resolveClanFounders = original.resolveClanFounders;
        PopulationService.reconcileStaleGoals = original.reconcileStaleGoals;
        PopulationService.reconcileWarehouseReleases = original.reconcileWarehouseReleases;
        PopulationService.reconcileMarketGoalBatch = original.reconcileMarketGoalBatch;
        Config.backgroundJobTickMs = original.backgroundJobTickMs;
        Config.backgroundResolverEnabled = original.backgroundResolverEnabled;
        Config.goalMetadataReconcileIntervalMs = original.goalMetadataReconcileIntervalMs;
        ClanConfig.enabled = original.clanEnabled;
        ClanConfig.resolveIntervalMs = original.clanIntervalMs;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
