const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');

const COLUMNS = ['characterId', 'phase', 'activity', 'simulationOwner', 'simulationRevision',
    'simulationLeaseId', 'simulationLeaseUntil', 'activityStartedAt', 'nextResolveAt',
    'lastResolvedAt', 'lastHotAt', 'updatedAt'];

function createLifecycleSafetyRuntime(population, coordinator) {
    const { LifecycleSafetySweep } = require('./LifecycleSafetySweep');
    let runtime;
    const active = () => population.started && Config.enabled !== false
        && population.lifecycleSafetySweep === runtime && population.backgroundJobRegistry?.started === true;
    runtime = new LifecycleSafetySweep({
        active,
        repairTotals: () => [Metrics.counters.coldSafetyStateRepairs, Metrics.counters.coldSafetyQueueRepairs, Metrics.counters.coldSafetyOrphanRepairs],
        onFinished: deltas => { Metrics.lastSafetyRepairs = deltas; },
        now: () => Date.now(),
        budgetMs: Math.max(1, Number(Config.schedulerSliceMs) || 12),
        retryMs: Math.max(100, Number(Config.backgroundGovernorWindowMs) || 1000),
        readPage: cursor => LifeState.safetyPage(cursor),
        readCurrent: async checkpoint => {
            if (!Number.isSafeInteger(checkpoint?.characterId) || checkpoint.characterId <= 0) {
                throw new RangeError('invalid_lifecycle_safety_character');
            }
            if (!Database.isReady()) throw Object.assign(new Error('Lifecycle safety database is unavailable'),
                { code: 'BOT_LIFE_STATE_SAFETY_UNAVAILABLE' });
            const rows = await Database.execute([`SELECT ${COLUMNS.join(', ')} FROM bot_life_state
                WHERE characterId = ? LIMIT 1`, [checkpoint.characterId], { read: true }], 'bot-life:safety-current');
            return rows[0] || null;
        },
        cachedState: id => LifeState.cachedState(id),
        admit: () => {
            if (!active()) return null;
            const scheduler = Metrics.schedulerState || {};
            const admission = Governor.admit({ job: 'lifecycle_safety', resource: 'sqlite-heavy',
                requestedBudgetMs: Math.max(1, Number(Config.schedulerSliceMs) || 12), minimumBudgetMs: 1,
                playerProtected: Number(scheduler.realPlayers || 0) > 0 || scheduler.mode === 'player',
                realPlayers: scheduler.realPlayers,
                lagMs: Math.max(Number(Metrics.currentEventLoopLag?.() || 0), Number(scheduler.lagMs || 0)) });
            return admission.ok ? admission.lease : null;
        },
        complete: (lease, result) => Governor.complete(lease, result),
        onError: error => coordinator.recordError(error),
        cold: {
            current: () => coordinator.safetyCurrent(),
            excluded: id => coordinator.safetyExcluded(id),
            canRepair: checkpoint => coordinator.canRepairSafety(checkpoint),
            projection: id => coordinator.projectedEntryFor(id),
            request: (kind, rows, worker) => coordinator.requestSafety(kind, rows, worker),
            poll: timestamp => coordinator.pollSafety(timestamp),
            cancel: () => coordinator.cancelSafety()
        }
    });
    return runtime;
}

module.exports = { createLifecycleSafetyRuntime };
