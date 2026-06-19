const Config  = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Status  = invoke('GameServer/Bot/Population/PopulationStatus');

const PopulationService = {
    initialized: false,
    started: false,
    summaryTimer: null,
    initialSummaryTimer: null,

    init() {
        if (this.initialized || Config.enabled === false) return;

        Metrics.init();
        Metrics.startEventLoopMonitor();
        this.initialized = true;
        utils.infoSuccess('BotPopulation', 'population service initialized');
    },

    start() {
        if (this.started || Config.enabled === false) return;
        if (!this.initialized) this.init();

        this.started = true;
        this.initialSummaryTimer = setTimeout(() => {
            this.logSummary('start');
            this.initialSummaryTimer = null;
        }, 5000);

        if (typeof this.initialSummaryTimer.unref === 'function') {
            this.initialSummaryTimer.unref();
        }

        this.summaryTimer = setInterval(() => {
            this.logSummary('summary');
        }, Config.summaryIntervalMs);

        if (typeof this.summaryTimer.unref === 'function') {
            this.summaryTimer.unref();
        }
    },

    stop() {
        if (this.initialSummaryTimer) {
            clearTimeout(this.initialSummaryTimer);
            this.initialSummaryTimer = null;
        }
        if (this.summaryTimer) {
            clearInterval(this.summaryTimer);
            this.summaryTimer = null;
        }
        Metrics.stopEventLoopMonitor();
        this.started = false;
    },

    recordHotTick(session) {
        if (Config.enabled === false) return;
        if (!session || !session.accountId || !String(session.accountId).startsWith('bot_')) return;
        Metrics.recordHotTick();
    },

    summary() {
        return Status.summary();
    },

    logSummary(reason = 'summary') {
        const summary = this.summary();
        console.info('BotPopulation :: %s %s', reason, summary.line);
        return summary;
    }
};

module.exports = PopulationService;
