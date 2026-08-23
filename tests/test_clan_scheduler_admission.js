const assert = require('assert');

require('../src/Global');

const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');
const ClanSimulationService = invoke('GameServer/Clan/ClanSimulationService');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Database = invoke('Database');
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');

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
        resolveBatchSize: Config.resolveBatchSize,
        resolveIntervalMs: Config.resolveIntervalMs
    };
    const originalNextClanActionAt = PopulationService.nextClanActionAt;

    try {
        Config.enabled = true;
        Config.resolveBudgetMs = 80;
        Config.actionPlayerBudgetMs = 20;
        Config.founderResolveBudgetMs = 20;
        Config.founderPlayerBudgetMs = 5;
        Config.actionBatchSize = 8;
        Config.resolveBatchSize = 16;
        Config.resolveIntervalMs = 60000;
        Governor.reset();
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
        const deferredFounder = await PopulationService.resolveClanFounders({ protected: false });
        assert.deepStrictEqual(deferredFounder, { skipped: true, reason: 'governor_resource_busy' });
        assert.strictEqual(founderRanWhileActionBusy, false, 'SQLite-heavy passes must not overlap');
        releaseAction({ attempted: 0 });
        await pendingAction;
        const independentFounder = await PopulationService.resolveClanFounders({ protected: false });
        assert.strictEqual(independentFounder.budgetMs, 20, 'founder must retain its own full budget after the resource is released');

        Governor.reset();
        ClanActionService.resolveBatch = async () => ({ attempted: 1, budgetStopped: true, queue: { ready: 3 } });
        await PopulationService.resolveClanActions({ protected: false });
        let delayMs = PopulationService.nextClanActionAt - Date.now();
        assert(delayMs > 900 && delayMs <= 1000, 'a ready clan backlog must continue in the next governor window');
        Governor.reset();
        ClanActionService.resolveBatch = async () => ({ attempted: 0, budgetStopped: false, queue: { ready: 0 } });
        await PopulationService.resolveClanActions({ protected: false });
        delayMs = PopulationService.nextClanActionAt - Date.now();
        assert(delayMs > 59000 && delayMs <= 60000, 'a caught-up clan queue must return to its normal cadence');

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
        PopulationService.nextClanActionAt = originalNextClanActionAt;
        Governor.reset();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
