const Config  = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Status  = invoke('GameServer/Bot/Population/PopulationStatus');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const HotActivation = invoke('GameServer/Bot/Population/HotActivation');
const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
const Director = invoke('GameServer/Bot/Population/PopulationDirector');

const PopulationService = {
    initialized: false,
    started: false,
    summaryTimer: null,
    initialSummaryTimer: null,
    schedulerTimer: null,
    phasePolicyTimer: null,
    resolving: false,
    phasePolicyRunning: false,

    init() {
        if (this.initialized || Config.enabled === false) return;

        Metrics.init();
        Metrics.startEventLoopMonitor();
        LifeState.init();
        LifeEvents.init();
        Director.init();
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

        if (Config.backgroundResolverEnabled !== false) {
            this.schedulerTimer = setInterval(() => {
                this.tickBudgeted();
            }, Config.schedulerIntervalMs);

            if (typeof this.schedulerTimer.unref === 'function') {
                this.schedulerTimer.unref();
            }
        }

        if (Config.phasePolicyEnabled !== false) {
            this.phasePolicyTimer = setInterval(() => {
                this.tickPhasePolicy();
            }, Config.phasePolicyIntervalMs);

            if (typeof this.phasePolicyTimer.unref === 'function') {
                this.phasePolicyTimer.unref();
            }
        }

        Director.start();
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
        if (this.schedulerTimer) {
            clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
        }
        if (this.phasePolicyTimer) {
            clearInterval(this.phasePolicyTimer);
            this.phasePolicyTimer = null;
        }
        Director.stop();
        Metrics.stopEventLoopMonitor();
        this.started = false;
    },

    recordHotTick(session) {
        if (Config.enabled === false) return;
        if (!session || !session.accountId || !String(session.accountId).startsWith('bot_')) return;
        Metrics.recordHotTick();
    },

    markHot(session, reason = 'hot') {
        if (Config.enabled === false) return Promise.resolve(null);
        return LifeState.markHot(session, reason);
    },

    cooldownSession(session, reason = 'manual') {
        if (Config.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' });
        return Cooldown.cooldown(session, reason);
    },

    requestActivation(stateOrName, reason = 'manual') {
        if (Config.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' });
        return HotActivation.activate(stateOrName, reason);
    },

    tickPhasePolicy() {
        if (this.phasePolicyRunning || Config.enabled === false || Config.phasePolicyEnabled === false) {
            return Promise.resolve({ cooled: [], activated: [] });
        }

        this.phasePolicyRunning = true;
        return this.activateNearPlayers()
            .then((activated) => this.cooldownEligibleHot().then((cooled) => ({ activated, cooled })))
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'phase policy failed: %s', err.message);
                return { activated: [], cooled: [] };
            })
            .finally(() => {
                this.phasePolicyRunning = false;
            });
    },

    realPlayerSessions() {
        const World = invoke('GameServer/World/World');
        return World.user.sessions.filter((session) => (
            session.actor &&
            session.actor.fetchIsOnline() &&
            session.accountId &&
            !String(session.accountId).startsWith('bot_')
        ));
    },

    activateNearPlayers() {
        const players = this.realPlayerSessions();
        if (players.length === 0) return Promise.resolve([]);

        const activated = [];
        let chain = Promise.resolve();

        players.forEach((playerSession) => {
            chain = chain.then(() => {
                if (activated.length >= Config.maxActivationsPerScan) return [];
                const actor = playerSession.actor;
                const loc = {
                    locX: actor.fetchLocX(),
                    locY: actor.fetchLocY(),
                    locZ: actor.fetchLocZ()
                };
                const remaining = Config.maxActivationsPerScan - activated.length;

                return LifeState.coldNear(loc, Config.activationRadius, remaining)
                    .then((states) => states.reduce((stateChain, state) => (
                        stateChain.then(() => this.requestActivation(state, 'near_player').then((result) => {
                            if (result.ok) activated.push(result);
                        }))
                    ), Promise.resolve()));
            });
        });

        return chain.then(() => activated);
    },

    cooldownEligibleHot() {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const now = Date.now();
        const candidates = BotManager.sessions
            .filter((session) => session.actor && session.accountId && String(session.accountId).startsWith('bot_'))
            .filter((session) => {
                if (session.plan === 'merchant') return false;
                const lastHotAt = session.populationHotAt || 0;
                return !lastHotAt || now - lastHotAt >= Config.cooldownGraceMs;
            })
            .slice(0, Config.cooldownBatchSize);

        return candidates.reduce((chain, session) => (
            chain.then((results) => this.cooldownSession(session, 'policy').then((result) => {
                if (result.ok) results.push(result);
                return results;
            }))
        ), Promise.resolve([]));
    },

    tickBudgeted() {
        if (this.resolving || Config.enabled === false || Config.backgroundResolverEnabled === false) {
            return Promise.resolve([]);
        }

        this.resolving = true;
        return LifeState.dueCold(Config.maxResolvesPerTick)
            .then((states) => {
                if (states.length === 0) return [];
                return states.reduce((chain, state) => (
                    chain.then((results) => this.resolveColdState(state).then((result) => {
                        results.push(result);
                        return results;
                    }))
                ), Promise.resolve([]));
            })
            .catch((err) => {
                utils.infoWarn('BotPopulation', 'background scheduler failed: %s', err.message);
                return [];
            })
            .finally(() => {
                this.resolving = false;
            });
    },

    resolveColdState(state) {
        const spot = SpotProfiles.findForState(state);
        if (!spot) {
            Metrics.recordSkippedResolve();
            return Promise.resolve({ ok: false, reason: 'missing_spot', state });
        }

        const elapsedMs = state.timing?.lastResolvedAt ? Math.max(1000, Date.now() - state.timing.lastResolvedAt) : 60000;
        const result = BackgroundResolver.resolveSolo({
            state,
            spot,
            pressure: Director.pressureForState(state),
            elapsedMs
        });

        return LifeState.applyResolve(state, result).then((updatedState) => {
            if (!updatedState) {
                Metrics.recordSkippedResolve();
                return { ok: false, reason: 'apply_failed', state };
            }

            Metrics.recordBackgroundResolve();
            return LifeEvents.recordMany(state.characterId, result.events).then(() => ({
                ok: true,
                state: updatedState,
                debug: result.debug
            }));
        });
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
