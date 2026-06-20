const Config = invoke('GameServer/Bot/Population/PopulationConfig');

function now() {
    return Date.now();
}

function emptyCounters() {
    return {
        hotTicks: 0,
        backgroundResolves: 0,
        skippedResolves: 0,
        activations: 0,
        cooldowns: 0,
        partyFormations: 0,
        dbFlushes: 0
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

    recordDbFlush() {
        this.counters.dbFlushes += 1;
    },

    snapshot() {
        const elapsedMs = Math.max(1, now() - (this.startedAt || now()));
        const delta = {};

        Object.keys(this.counters).forEach((key) => {
            delta[key] = this.counters[key] - (this.lastSummaryCounters[key] || 0);
        });

        this.lastSummaryCounters = { ...this.counters };

        return {
            uptimeMs: elapsedMs,
            counters: { ...this.counters },
            delta,
            eventLoop: { ...this.eventLoop }
        };
    }
};

module.exports = PopulationMetrics;
