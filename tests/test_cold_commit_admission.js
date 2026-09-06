const assert = require('assert');

require('../src/Global');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Database = invoke('Database');
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

async function main() {
    const settings = {
        backgroundGovernorEnabled: true, backgroundGovernorWindowMs: 1000,
        backgroundGovernorPlayerBudgetMs: 50, backgroundGovernorPlayerDbQueueMax: 0,
        schedulerSliceMs: 12, schedulerLagThrottleMs: 40
    };
    const saved = Object.fromEntries(Object.keys(settings).map(key => [key, Config[key]]));
    const originalNow = Date.now;
    const originalLag = Metrics.currentEventLoopLag;
    const originalStats = Database.stats;
    let now = 1000;
    Date.now = () => now;
    Metrics.currentEventLoopLag = () => 0;
    Database.stats = () => ({ pending: 0 });
    Object.assign(Config, settings);

    function create(availableMs, atomic = false) {
        Governor.reset();
        now = 1000;
        const spent = Governor.admit({ job: 'goal_market_reconcile', requestedBudgetMs: 50 - availableMs,
            playerProtected: true, lagMs: 0, dbPending: 0 });
        assert(spent.ok);
        Governor.complete(spent.lease, { durationMs: 50 - availableMs });
        const coordinator = new ColdSimulationCoordinator();
        coordinator.desiredWorkerPressure = () => ({ player: true, lagMs: 0 });
        const queue = coordinator.queue;
        queue.prepare = async proposal => ({ characterId: proposal.characterId });
        queue.commit = async entries => {
            now += 3;
            return entries.map(entry => ({ ok: true, characterId: entry.nextState.characterId }));
        };
        queue.afterCommit = async () => {};
        queue.onResults = () => {};
        for (let id = 1; id <= (atomic ? 2 : 4); id++) queue.enqueue({
            characterId: id, token: { leaseId: `lease-${id}`, revision: 1 },
            priority: atomic ? 'P1' : 'P2',
            ...(atomic ? { atomicGroup: { id: 'party', memberIds: [1, 2] } } : {})
        });
        queue.capacityBlocked = true;
        return { coordinator, queue };
    }

    try {
        for (const available of [4, 5, 6, 7, 8, 11, 12]) {
            const { queue } = create(available);
            assert.strictEqual(await queue.flushDue(), true, `${available} ms must admit useful work`);
            assert.strictEqual(queue.size(), 4 - Math.floor(available / 4), 'batch size must follow the granted budget');
            assert.strictEqual(Governor.snapshot().jobs.cold_commit_early.grantedMs, available);
            assert.strictEqual(Governor.snapshot().usedMs, 50 - available + 3, 'charge actual work and return unused reservation');
        }
        for (const available of [0, 1, 2, 3]) {
            const { queue } = create(available);
            assert.strictEqual(await queue.flushDue(), false, 'never bypass an exhausted budget');
            assert.strictEqual(queue.size(), 4);
            assert.strictEqual(Governor.snapshot().jobs.cold_commit_early.reasons.budget_exhausted, 1);
        }
        const atomic = create(7, true).queue;
        assert.strictEqual(await atomic.flushDue(), false, 'one-row admission must not split a two-member party');
        assert.strictEqual(atomic.size(), 2);
        assert.strictEqual(Governor.snapshot().usedMs, 43, 'an empty atomic selection returns its entire reservation');
        now += 100;
        assert.strictEqual(await atomic.flushDue(), true, 'the ordinary critical deadline still commits the whole party');
        assert.strictEqual(atomic.size(), 0);

        const pressured = create(7);
        pressured.coordinator.desiredWorkerPressure = () => ({ player: true, lagMs: 40 });
        assert.strictEqual(await pressured.queue.flushDue(), false, 'lag protection still rejects early work');
        now += 100;
        pressured.coordinator.desiredWorkerPressure = () => ({ player: true, lagMs: 0 });
        Database.stats = () => ({ pending: 1 });
        assert.strictEqual(await pressured.queue.flushDue(), false, 'database queue protection still rejects early work');
        assert.strictEqual(Governor.snapshot().jobs.cold_commit_early.reasons.database_queue, 1);
    } finally {
        Date.now = originalNow;
        Metrics.currentEventLoopLag = originalLag;
        Database.stats = originalStats;
        Object.assign(Config, saved);
        Governor.reset();
    }
    console.log('Cold commit partial-budget admission and protection checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
