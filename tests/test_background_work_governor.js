const assert = require('assert');

require('../src/Global');

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');

function main() {
    const original = {
        backgroundGovernorEnabled: Config.backgroundGovernorEnabled,
        backgroundGovernorWindowMs: Config.backgroundGovernorWindowMs,
        backgroundGovernorIdleBudgetMs: Config.backgroundGovernorIdleBudgetMs,
        backgroundGovernorPlayerBudgetMs: Config.backgroundGovernorPlayerBudgetMs,
        backgroundGovernorIdleDbQueueMax: Config.backgroundGovernorIdleDbQueueMax,
        backgroundGovernorPlayerDbQueueMax: Config.backgroundGovernorPlayerDbQueueMax,
        backgroundGovernorLagAbortMs: Config.backgroundGovernorLagAbortMs
    };

    try {
        Object.assign(Config, {
            backgroundGovernorEnabled: true,
            backgroundGovernorWindowMs: 1000,
            backgroundGovernorIdleBudgetMs: 100,
            backgroundGovernorPlayerBudgetMs: 30,
            backgroundGovernorIdleDbQueueMax: 4,
            backgroundGovernorPlayerDbQueueMax: 0,
            backgroundGovernorLagAbortMs: 120
        });
        Governor.reset();

        const action = Governor.admit({
            job: 'clan_actions', resource: 'sqlite-heavy', requestedBudgetMs: 80,
            minimumBudgetMs: 10, timestamp: 1000, lagMs: 0, dbPending: 0
        });
        assert.strictEqual(action.ok, true);
        assert.strictEqual(action.budgetMs, 80);

        const resourceBusy = Governor.admit({
            job: 'goal_metadata', resource: 'sqlite-heavy', requestedBudgetMs: 50,
            minimumBudgetMs: 25, timestamp: 1001, lagMs: 0, dbPending: 0
        });
        assert.strictEqual(resourceBusy.reason, 'resource_busy');

        Governor.complete(action.lease, { timestamp: 1040, durationMs: 40 });
        const goal = Governor.admit({
            job: 'goal_metadata', resource: 'sqlite-heavy', requestedBudgetMs: 50,
            minimumBudgetMs: 25, timestamp: 1041, lagMs: 0, dbPending: 0
        });
        assert.strictEqual(goal.ok, true, 'unused reservation must return to the shared window');
        assert.strictEqual(goal.budgetMs, 50);
        Governor.complete(goal.lease, { timestamp: 1091, durationMs: 50 });
        Governor.recordStage('goal_metadata', 'projection', 12);
        Governor.recordStage('goal_metadata', 'projection', 28);

        const playerExhausted = Governor.admit({
            job: 'clan_founders', resource: 'sqlite-heavy', requestedBudgetMs: 10,
            minimumBudgetMs: 5, playerProtected: true, timestamp: 1092, lagMs: 0, dbPending: 0
        });
        assert.strictEqual(playerExhausted.reason, 'budget_exhausted', 'mode switch must not erase idle work used in the same window');

        const playerAction = Governor.admit({
            job: 'clan_actions', resource: 'sqlite-heavy', requestedBudgetMs: 20,
            minimumBudgetMs: 10, playerProtected: true, timestamp: 2001, lagMs: 0, dbPending: 0
        });
        assert.strictEqual(playerAction.budgetMs, 20);
        Governor.complete(playerAction.lease, { timestamp: 2026, durationMs: 25 });
        assert.strictEqual(Governor.snapshot(2026).overruns, 1);

        const databasePressure = Governor.admit({
            job: 'goal_metadata', requestedBudgetMs: 25, minimumBudgetMs: 25,
            playerProtected: true, timestamp: 3002, lagMs: 0, dbPending: 1
        });
        assert.strictEqual(databasePressure.reason, 'database_queue');

        const lagPressure = Governor.admit({
            job: 'clan_founders', requestedBudgetMs: 5, minimumBudgetMs: 5,
            timestamp: 4003, lagMs: 120, dbPending: 0
        });
        assert.strictEqual(lagPressure.reason, 'event_loop_lag');

        const snapshot = Governor.snapshot(4003);
        assert.strictEqual(snapshot.admitted, 3);
        assert.strictEqual(snapshot.completed, 3);
        assert.strictEqual(snapshot.deferred, 4);
        assert.strictEqual(snapshot.deferralReasons.resource_busy, 1);
        assert.strictEqual(snapshot.deferralReasons.budget_exhausted, 1);
        assert.strictEqual(snapshot.deferralReasons.database_queue, 1);
        assert.strictEqual(snapshot.deferralReasons.event_loop_lag, 1);
        assert.strictEqual(snapshot.jobs.clan_actions.overruns, 1);
        assert.strictEqual(snapshot.jobs.goal_metadata.stages.projection.p95Ms, 28);
        assert.strictEqual(snapshot.jobs.goal_metadata.stages.projection.avgMs, 20);
        console.log('Background work governor checks passed');
    } finally {
        Object.assign(Config, original);
        Governor.reset();
    }
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
