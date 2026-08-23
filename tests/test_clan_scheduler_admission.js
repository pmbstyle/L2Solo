const assert = require('assert');

require('../src/Global');

const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');
const ClanSimulationService = invoke('GameServer/Clan/ClanSimulationService');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Database = invoke('Database');

async function main() {
    const originalActionResolve = ClanActionService.resolveBatch;
    const originalFounderResolve = ClanSimulationService.resolveBatch;
    const originalProfile = PopulationService.playerActivityProfile;
    const originalDatabaseExecute = Database.execute;
    const originalConfig = {
        enabled: Config.enabled,
        resolveBudgetMs: Config.resolveBudgetMs,
        actionPlayerBudgetMs: Config.actionPlayerBudgetMs,
        founderResolveBudgetMs: Config.founderResolveBudgetMs,
        founderPlayerBudgetMs: Config.founderPlayerBudgetMs,
        actionBatchSize: Config.actionBatchSize,
        resolveBatchSize: Config.resolveBatchSize
    };

    try {
        Config.enabled = true;
        Config.resolveBudgetMs = 80;
        Config.actionPlayerBudgetMs = 20;
        Config.founderResolveBudgetMs = 20;
        Config.founderPlayerBudgetMs = 5;
        Config.actionBatchSize = 8;
        Config.resolveBatchSize = 16;
        PopulationService.clanActionRunning = false;
        PopulationService.clanFounderRunning = false;
        PopulationService.playerActivityProfile = () => ({ protected: true, realPlayers: 1 });

        ClanSimulationService.resetMetrics();
        Database.execute = async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return [];
        };
        const projectionBounded = await ClanSimulationService.resolveBatch(16, { budgetMs: 5 });
        assert.strictEqual(projectionBounded.budgetStopped, true, 'candidate projection time must consume the founder budget');
        const projectionMetrics = ClanSimulationService.metrics();
        assert.strictEqual(projectionMetrics.stages.candidate_projection.count, 1);
        assert.strictEqual(projectionMetrics.stages.clan_projection, undefined, 'a spent budget must stop before the clan projection');
        assert(projectionMetrics.stages.total.p95Ms >= 5);
        Database.execute = originalDatabaseExecute;

        const calls = [];
        ClanActionService.resolveBatch = async (options) => {
            calls.push({ service: 'actions', ...options });
            await new Promise((resolve) => setTimeout(resolve, 15));
            return { attempted: 1 };
        };
        ClanSimulationService.resolveBatch = async (limit, options) => {
            calls.push({ service: 'founders', limit, ...options });
            return { attempted: 1 };
        };

        const combined = await PopulationService.resolveClanSimulation();
        assert.strictEqual(combined.playerProtected, true);
        assert.strictEqual(calls[0].service, 'actions');
        assert.strictEqual(calls[0].budgetMs, 20, 'action admission must switch to the protected-player budget');
        assert.strictEqual(calls[1].service, 'founders');
        assert.strictEqual(calls[1].budgetMs, 5, 'founder admission must receive its full player budget, not action leftovers');

        let releaseAction;
        let founderRanWhileActionBusy = false;
        let idleActionBudget = 0;
        ClanActionService.resolveBatch = (options) => new Promise((resolve) => {
            idleActionBudget = options.budgetMs;
            releaseAction = resolve;
        });
        ClanSimulationService.resolveBatch = async (_limit, options) => {
            founderRanWhileActionBusy = PopulationService.clanActionRunning;
            return { attempted: 0, budgetMs: options.budgetMs };
        };

        const pendingAction = PopulationService.resolveClanActions({ protected: false });
        const duplicateAction = await PopulationService.resolveClanActions({ protected: false });
        assert.deepStrictEqual(duplicateAction, { skipped: true, reason: 'already_running' });
        assert.strictEqual(idleActionBudget, 80, 'idle action admission must retain the full budget');
        const independentFounder = await PopulationService.resolveClanFounders({ protected: false });
        assert.strictEqual(founderRanWhileActionBusy, true, 'founder admission must not share the action running guard');
        assert.strictEqual(independentFounder.budgetMs, 20);
        releaseAction({ attempted: 0 });
        await pendingAction;

        assert.strictEqual(PopulationService.clanActionRunning, false);
        assert.strictEqual(PopulationService.clanFounderRunning, false);
        console.log('Clan scheduler admission checks passed');
    } finally {
        ClanActionService.resolveBatch = originalActionResolve;
        ClanSimulationService.resolveBatch = originalFounderResolve;
        PopulationService.playerActivityProfile = originalProfile;
        Database.execute = originalDatabaseExecute;
        Object.assign(Config, originalConfig);
        PopulationService.clanActionRunning = false;
        PopulationService.clanFounderRunning = false;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
