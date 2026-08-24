const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Database = invoke('Database');

const state = {
    windowStartedAt: 0,
    generation: 0,
    usedMs: 0,
    mode: 'idle',
    nextLeaseId: 1,
    resources: new Map()
};

const metrics = {
    admitted: 0,
    deferred: 0,
    completed: 0,
    overruns: 0,
    grantedMs: 0,
    actualMs: 0,
    deferralReasons: new Map(),
    jobs: new Map()
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function increment(map, key, amount = 1) {
    if (!key) return;
    map.set(String(key), number(map.get(String(key))) + amount);
}

function jobMetrics(job) {
    const key = String(job || 'unknown');
    if (!metrics.jobs.has(key)) {
        metrics.jobs.set(key, {
            admitted: 0,
            deferred: 0,
            completed: 0,
            overruns: 0,
            grantedMs: 0,
            actualMs: 0,
            reasons: new Map(),
            stages: new Map()
        });
    }
    return metrics.jobs.get(key);
}

function recordStage(job, stage, durationMs) {
    const name = String(stage || 'unknown');
    const values = jobMetrics(job).stages;
    if (!values.has(name)) values.set(name, []);
    const samples = values.get(name);
    samples.push(Math.max(0, number(durationMs)));
    if (samples.length > 128) samples.splice(0, samples.length - 128);
}

function stageStats(values = []) {
    if (!values.length) return { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };
    const sorted = [...values].sort((left, right) => left - right);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
        count: values.length,
        avgMs: Math.round(total / values.length),
        p95Ms: Math.round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]),
        maxMs: Math.round(sorted[sorted.length - 1])
    };
}

function windowMs() {
    return Math.max(100, Math.floor(number(Config.backgroundGovernorWindowMs, 1000)));
}

function budgetMs(playerProtected) {
    return Math.max(1, Math.floor(number(playerProtected
        ? Config.backgroundGovernorPlayerBudgetMs
        : Config.backgroundGovernorIdleBudgetMs, playerProtected ? 50 : 250)));
}

function refreshWindow(timestamp) {
    const now = number(timestamp, Date.now());
    if (!state.windowStartedAt || now < state.windowStartedAt || now - state.windowStartedAt >= windowMs()) {
        state.windowStartedAt = now;
        state.generation += 1;
        state.usedMs = 0;
    }
    return now;
}

function pressureSnapshot(options = {}) {
    let lagMs = number(options.lagMs, NaN);
    if (!Number.isFinite(lagMs)) {
        try {
            lagMs = Math.max(0, number(Metrics.currentEventLoopLag()));
        } catch (_) {
            lagMs = 0;
        }
    }

    let dbPending = number(options.dbPending, NaN);
    if (!Number.isFinite(dbPending)) {
        try {
            dbPending = Math.max(0, number(Database.stats().pending));
        } catch (_) {
            dbPending = 0;
        }
    }

    return {
        playerProtected: !!options.playerProtected,
        realPlayers: Math.max(0, Math.floor(number(options.realPlayers))),
        lagMs: Math.max(0, lagMs),
        dbPending: Math.max(0, Math.floor(dbPending))
    };
}

function defer(job, reason, pressure, timestamp) {
    metrics.deferred += 1;
    increment(metrics.deferralReasons, reason);
    const perJob = jobMetrics(job);
    perJob.deferred += 1;
    increment(perJob.reasons, reason);
    return {
        ok: false,
        job: String(job || 'unknown'),
        reason,
        pressure,
        timestamp
    };
}

function admit(options = {}) {
    const requestedBudgetMs = Math.max(1, Math.floor(number(options.requestedBudgetMs, 1)));
    const minimumBudgetMs = Math.max(1, Math.min(requestedBudgetMs, Math.floor(number(options.minimumBudgetMs, 1))));
    const pressure = pressureSnapshot(options);
    const timestamp = refreshWindow(options.timestamp);
    const job = String(options.job || 'unknown');
    const resource = options.resource ? String(options.resource) : '';

    if (Config.backgroundGovernorEnabled === false) {
        return {
            ok: true,
            budgetMs: requestedBudgetMs,
            pressure,
            lease: {
                id: 0,
                job,
                resource,
                budgetMs: requestedBudgetMs,
                startedAt: timestamp,
                generation: state.generation,
                bypassed: true
            }
        };
    }

    state.mode = pressure.playerProtected ? 'player' : 'idle';
    const lagAbortMs = Math.max(1, number(Config.backgroundGovernorLagAbortMs, Config.schedulerLagAbortMs || 120));
    if (pressure.lagMs >= lagAbortMs) return defer(job, 'event_loop_lag', pressure, timestamp);

    const dbQueueMax = Math.max(0, Math.floor(number(pressure.playerProtected
        ? Config.backgroundGovernorPlayerDbQueueMax
        : Config.backgroundGovernorIdleDbQueueMax, pressure.playerProtected ? 0 : 8)));
    if (pressure.dbPending > dbQueueMax) return defer(job, 'database_queue', pressure, timestamp);
    if (resource && state.resources.has(resource)) return defer(job, 'resource_busy', pressure, timestamp);

    const capMs = budgetMs(pressure.playerProtected);
    const availableMs = Math.max(0, capMs - state.usedMs);
    if (availableMs < minimumBudgetMs) return defer(job, 'budget_exhausted', pressure, timestamp);

    const grantedBudgetMs = Math.max(minimumBudgetMs, Math.min(requestedBudgetMs, Math.floor(availableMs)));
    const lease = {
        id: state.nextLeaseId++,
        job,
        resource,
        budgetMs: grantedBudgetMs,
        startedAt: timestamp,
        generation: state.generation,
        playerProtected: pressure.playerProtected
    };
    state.usedMs += grantedBudgetMs;
    if (resource) state.resources.set(resource, lease.id);
    metrics.admitted += 1;
    metrics.grantedMs += grantedBudgetMs;
    const perJob = jobMetrics(job);
    perJob.admitted += 1;
    perJob.grantedMs += grantedBudgetMs;
    return { ok: true, budgetMs: grantedBudgetMs, pressure, lease };
}

function complete(lease, options = {}) {
    if (!lease || lease.bypassed) return null;
    const finishedAt = number(options.timestamp, Date.now());
    const durationMs = Math.max(0, number(options.durationMs, finishedAt - number(lease.startedAt, finishedAt)));
    if (lease.resource && state.resources.get(lease.resource) === lease.id) state.resources.delete(lease.resource);
    if (lease.generation === state.generation) {
        state.usedMs = Math.max(0, state.usedMs - number(lease.budgetMs) + durationMs);
    }
    metrics.completed += 1;
    metrics.actualMs += durationMs;
    const perJob = jobMetrics(lease.job);
    perJob.completed += 1;
    perJob.actualMs += durationMs;
    if (durationMs > number(lease.budgetMs)) {
        metrics.overruns += 1;
        perJob.overruns += 1;
    }
    return { durationMs, overrun: durationMs > number(lease.budgetMs) };
}

function serializeJobMetrics() {
    return Object.fromEntries([...metrics.jobs.entries()].map(([job, value]) => [job, {
        admitted: value.admitted,
        deferred: value.deferred,
        completed: value.completed,
        overruns: value.overruns,
        grantedMs: value.grantedMs,
        actualMs: value.actualMs,
        reasons: Object.fromEntries(value.reasons.entries()),
        stages: Object.fromEntries([...value.stages.entries()].map(([stage, samples]) => [stage, stageStats(samples)]))
    }]));
}

function snapshot(timestamp = Date.now()) {
    const now = refreshWindow(timestamp);
    const capMs = budgetMs(state.mode === 'player');
    return {
        enabled: Config.backgroundGovernorEnabled !== false,
        mode: state.mode,
        windowMs: windowMs(),
        windowAgeMs: Math.max(0, now - state.windowStartedAt),
        usedMs: Math.round(state.usedMs),
        availableMs: Math.max(0, Math.round(capMs - state.usedMs)),
        capMs,
        resources: Object.fromEntries(state.resources.entries()),
        admitted: metrics.admitted,
        deferred: metrics.deferred,
        completed: metrics.completed,
        overruns: metrics.overruns,
        grantedMs: Math.round(metrics.grantedMs),
        actualMs: Math.round(metrics.actualMs),
        deferralReasons: Object.fromEntries(metrics.deferralReasons.entries()),
        jobs: serializeJobMetrics()
    };
}

function reset() {
    state.windowStartedAt = 0;
    state.generation = 0;
    state.usedMs = 0;
    state.mode = 'idle';
    state.nextLeaseId = 1;
    state.resources.clear();
    metrics.admitted = 0;
    metrics.deferred = 0;
    metrics.completed = 0;
    metrics.overruns = 0;
    metrics.grantedMs = 0;
    metrics.actualMs = 0;
    metrics.deferralReasons.clear();
    metrics.jobs.clear();
}

module.exports = { admit, complete, recordStage, pressureSnapshot, snapshot, reset };
