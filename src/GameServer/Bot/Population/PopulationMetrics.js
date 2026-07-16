const Config = invoke('GameServer/Bot/Population/PopulationConfig');

function now() {
    return Date.now();
}

function emptyCounters() {
    return {
        hotTicks: 0,
        backgroundResolves: 0,
        partyResolves: 0,
        skippedResolves: 0,
        activations: 0,
        cooldowns: 0,
        partyFormations: 0,
        partyRecruits: 0,
        partyDissolutions: 0,
        dbFlushes: 0,
        schedulerRuns: 0,
        schedulerSkips: 0,
        schedulerOverruns: 0,
        slowResolves: 0
    };
}

function stats(values) {
    if (!values.length) {
        return { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return {
        count: sorted.length,
        avgMs: Math.round(sum / sorted.length),
        p95Ms: Math.round(sorted[p95Index]),
        maxMs: Math.round(sorted[sorted.length - 1])
    };
}

const PopulationMetrics = {
    startedAt: null,
    counters: emptyCounters(),
    lastSummaryCounters: emptyCounters(),
    eventLoop: {
        lagMs: 0,
        maxLagMs: 0,
        samples: 0,
        slowSamples: 0
    },
    interval: {
        resolveDurationsMs: [],
        schedulerDurationsMs: []
    },
    timer: null,

    init() {
        if (!this.startedAt) {
            this.startedAt = now();
        }
    },

    startEventLoopMonitor() {
        if (this.timer || Config.enabled === false) return;

        let expectedAt = now() + Config.eventLoopSampleMs;
        this.timer = setInterval(() => {
            const measuredAt = now();
            const lag = Math.max(0, measuredAt - expectedAt);

            this.eventLoop.lagMs = lag;
            this.eventLoop.maxLagMs = Math.max(this.eventLoop.maxLagMs, lag);
            this.eventLoop.samples += 1;
            if (lag >= Config.slowEventLoopLagMs) {
                this.eventLoop.slowSamples += 1;
            }

            expectedAt = measuredAt + Config.eventLoopSampleMs;
        }, Config.eventLoopSampleMs);

        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    },

    stopEventLoopMonitor() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    },

    recordHotTick() {
        this.counters.hotTicks += 1;
    },

    recordBackgroundResolve() {
        this.counters.backgroundResolves += 1;
    },

    recordPartyResolve() {
        this.counters.partyResolves += 1;
    },

    recordSkippedResolve() {
        this.counters.skippedResolves += 1;
    },

    recordActivation() {
        this.counters.activations += 1;
    },

    recordCooldown() {
        this.counters.cooldowns += 1;
    },

    recordPartyFormation() {
        this.counters.partyFormations += 1;
    },

    recordPartyRecruit(count = 1) {
        this.counters.partyRecruits += Math.max(1, Number(count) || 1);
    },

    recordPartyDissolution() {
        this.counters.partyDissolutions += 1;
    },

    recordDbFlush() {
        this.counters.dbFlushes += 1;
    },

    recordResolveDuration(ms) {
        const value = Math.max(0, Number(ms) || 0);
        this.interval.resolveDurationsMs.push(value);
        if (this.interval.resolveDurationsMs.length > Config.resolveSampleLimit) {
            this.interval.resolveDurationsMs.shift();
        }
        if (value >= Config.resolveSlowMs) {
            this.counters.slowResolves += 1;
        }
    },

    recordSchedulerRun(ms) {
        const value = Math.max(0, Number(ms) || 0);
        this.counters.schedulerRuns += 1;
        this.interval.schedulerDurationsMs.push(value);
        if (this.interval.schedulerDurationsMs.length > Config.resolveSampleLimit) {
            this.interval.schedulerDurationsMs.shift();
        }
        if (value >= Config.schedulerIntervalMs) {
            this.counters.schedulerOverruns += 1;
        }
    },

    recordSchedulerSkip() {
        this.counters.schedulerSkips += 1;
    },

    snapshot() {
        const elapsedMs = Math.max(1, now() - (this.startedAt || now()));
        const delta = {};

        Object.keys(this.counters).forEach((key) => {
            delta[key] = this.counters[key] - (this.lastSummaryCounters[key] || 0);
        });

        this.lastSummaryCounters = { ...this.counters };
        const resolveStats = stats(this.interval.resolveDurationsMs);
        const schedulerStats = stats(this.interval.schedulerDurationsMs);
        this.interval.resolveDurationsMs = [];
        this.interval.schedulerDurationsMs = [];

        return {
            uptimeMs: elapsedMs,
            counters: { ...this.counters },
            delta,
            eventLoop: { ...this.eventLoop },
            resolve: resolveStats,
            scheduler: schedulerStats,
            memory: process.memoryUsage ? process.memoryUsage() : null
        };
    }
};

module.exports = PopulationMetrics;
