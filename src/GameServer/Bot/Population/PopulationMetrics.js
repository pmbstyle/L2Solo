const { DiagnosticMetricMap } = require('./DiagnosticMetricMap');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const { monitorEventLoopDelay } = require('perf_hooks');
const WorkerHeapTelemetry = require('./WorkerHeapTelemetry');
// Main's loop delay with diagnostics: 5 ms tells one turn from the next (two tasks back to back with a timer
// run between them read as two turns); 200 timer runs a second, native.
const DELAY_RESOLUTION_MS = 5;

function now() {
    return Date.now();
}

function emptyCounters() {
    return {
        hotTicks: 0,
        backgroundResolves: 0,
        partyResolves: 0,
        combatActions: 0,
        skillUses: 0,
        heals: 0,
        partyBuffCasts: 0,
        // Cold solo fights started and the mobs they pulled: mobs per pull.
        coldPulls: 0,
        coldPullMobs: 0,
        // Cold solo area-skill hits that struck every mob of a pull.
        coldAreaPullHits: 0,
        // solo rounds the spot share cut short, and the fights it did not start.
        coldShareBoundResolves: 0,
        coldShareCutFights: 0,
        skippedResolves: 0,
        activations: 0,
        // Activations refused (HotActivation: in_transit, no_safe_activation_placement), by reason in
        // activationRefusalReasons; counted with or without developerDiagnostics.
        activationRefusals: 0,
        // Bodies placed already inside a settled player's view (PopulationService.activationSettled:
        // its last scan left no near row to the budget and it did not log in or teleport since):
        // the ring's lead past the view (activationRadius) was too short for them. The bodies an
        // arrival's or a budget cut's next scan places are not counted. Counted with or without
        // developerDiagnostics.
        lateInViewActivations: 0,
        // Of those, walkers shown on their road (PopulationService.showWalkersNear); a walker
        // that landed by a gatekeeper inside the view is not late.
        lateInViewWalkers: 0,
        // Bodies placed by a recovery of a place off the ground (ActivationPlacement), by kind:
        // a walker by a step back toward its run's start, a bot on its spot (a raid included)
        // at one of the spot's spawn points or its centre.
        walkerRoadStepBacks: 0,
        spotPlaceRecoveries: 0,
        // Walkers whose road point was still in the town their run began in, shown at the
        // run's start instead (ActivationPlacement).
        walkerStartTownPlacements: 0,
        // Hot bots' walks to their town's gatekeeper that failed (BotSpotTravel.recoverOrDefer),
        // and the Scrolls of Escape a bot stuck in a town began after repeated failures
        // (BotSpotTravel.startEmergencyScroll: an unreachable or a missing gatekeeper).
        townDepartureRouteFailures: 0,
        townStuckEscapes: 0,
        cooldowns: 0,
        partyFormations: 0,
        partyRecruits: 0,
        partyDissolutions: 0,
        dbFlushes: 0,
        partyFormationBudgetStops: 0,
        slowResolves: 0,
        backgroundDeferrals: 0,
        partyFormationDeferrals: 0,
        activationFloorCandidates: 0,
        activationFloorAccepted: 0,
        activationFloorRejected: 0,
        activationFloorGeoChecks: 0,
        activationFloorCacheHits: 0,
        activationFloorBudgetDeferred: 0,
        coldOwnerCommitted: 0,
        coldOwnerRejected: 0,
        coldOwnerErrors: 0,
        coldOwnerLegacyDeferred: 0,
        coldOwnerDbBusy: 0,
        coldOwnerHandoffs: 0,
        missedEventsRecovered: 0,
        coldSafetyStateRepairs: 0,
        boardReviewWakeups: 0,
        coldSafetyQueueRepairs: 0,
        coldSafetyOrphanRepairs: 0,
        partySafetyRepairs: 0,
        legacyOwnershipConflicts: 0,
        stateRetentionRuns: 0,
        stateRetentionRows: 0,
        stateRetentionErrors: 0,
        stateRetentionOverruns: 0
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

// The cold worker limit reads the median of the last three 1 s readings: two of three late, not one.
const LAG_WINDOW = 3;

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
    // Last LAG_WINDOW readings, kept outside eventLoop: snapshot() spreads eventLoop into the status API.
    lagHistory: [],
    // The player-activity and lag signal (recordSchedulerProfile), read by the
    // cold worker pressure and the background work admissions.
    schedulerState: {
        mode: 'unknown',
        lagMs: 0
    },
    interval: {
        resolveDurationsMs: [],
        partyFormationDurationsMs: [],
        partyFormationStageDurationsMs: new DiagnosticMetricMap(),
        actorPathDurationsMs: [],
        companionPathDurationsMs: [],
        activationFloorDurationsMs: [],
        activationFloorReasons: new DiagnosticMetricMap(),
        activationDurationsMs: [],
        cooldownDurationsMs: [],
        skippedResolveReasons: new DiagnosticMetricMap(),
        activationRefusalReasons: new DiagnosticMetricMap(),
        coldOwnerCommitDurationsMs: [],
        coldOwnerLegacyReasons: new DiagnosticMetricMap(),
        coldOwnerRejectReasons: new DiagnosticMetricMap(),
        stateRetentionDurationsMs: [],
        stateRetentionPolicyRows: new DiagnosticMetricMap()
    },
    timer: null,
    coldSafetySource: null,
    delayHistogram: null,
    heapObserver: null,
    delayWindowStartedAt: 0,

    init() {
        if (!Config.developerDiagnostics) return;
        if (!this.startedAt) {
            this.startedAt = now();
        }
    },

    beginColdSafetyEpoch(epoch) {
        if (!Config.developerDiagnostics) return false;
        if (typeof epoch !== 'string' || !epoch || epoch.length > 160) return false;
        if (this.coldSafetySource?.epoch !== epoch) {
            this.coldSafetySource = { epoch, stateRepairs: 0, coverageRepairs: 0, orphanRepairs: 0 };
        }
        return true;
    },

    clearColdSafetyEpoch(epoch) {
        if (!this.coldSafetySource || this.coldSafetySource.epoch !== epoch) return false;
        this.coldSafetySource = null;
        return true;
    },

    // Worker-owned cumulative accepted transitions survive a lost direct ACK.
    // The caller establishes an epoch on creation, never from an incoming report.
    recordColdSafetyTotals(epoch, totals) {
        if (!Config.developerDiagnostics) return 0;
        const source = this.coldSafetySource;
        if (!source || source.epoch !== epoch || !totals || typeof totals !== 'object' || Array.isArray(totals)) return 0;
        const fields = ['stateRepairs', 'coverageRepairs', 'orphanRepairs'];
        if (fields.some(key => !Number.isSafeInteger(totals[key]) || totals[key] < 0)) return 0;
        const deltas = fields.map(key => Math.max(0, totals[key] - source[key]));
        const recovered = deltas.reduce((sum, delta) => sum + delta, 0);
        const counters = ['coldSafetyStateRepairs', 'coldSafetyQueueRepairs', 'coldSafetyOrphanRepairs'];
        if (!Number.isSafeInteger(this.counters.missedEventsRecovered + recovered)
            || counters.some((key, index) => !Number.isSafeInteger(this.counters[key] + deltas[index]))) return 0;
        fields.forEach((key, index) => { source[key] += deltas[index]; });
        counters.forEach((key, index) => { this.counters[key] += deltas[index]; });
        this.counters.missedEventsRecovered += recovered;
        return recovered;
    },

    startEventLoopMonitor() {
        if (this.timer || Config.enabled === false) return;
        this.lagHistory.length = 0;

        if (Config.developerDiagnostics) {
            this.delayHistogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
            this.delayHistogram.enable();
            this.delayWindowStartedAt = now();
            this.heapObserver = WorkerHeapTelemetry.observe();
        }

        let expectedAt = now() + Config.eventLoopSampleMs;
        this.timer = setInterval(() => {
            const measuredAt = now();
            const lag = Math.max(0, measuredAt - expectedAt);

            this.eventLoop.lagMs = lag;
            this.recordLagReading(lag);
            if (Config.developerDiagnostics) {
            this.eventLoop.maxLagMs = Math.max(this.eventLoop.maxLagMs, lag);
            this.eventLoop.samples += 1;
            if (lag >= Config.slowEventLoopLagMs) {
                this.eventLoop.slowSamples += 1;
            }

            }
            expectedAt = measuredAt + Config.eventLoopSampleMs;
        }, Config.eventLoopSampleMs);

        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    },

    stopEventLoopMonitor() {
        this.delayHistogram?.disable();
        this.delayHistogram = null;
        this.heapObserver?.close();
        this.heapObserver = null;
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    },

    recordHotTick() {
        if (!Config.developerDiagnostics) return;
        this.counters.hotTicks += 1;
    },

    recordBackgroundResolve() {
        if (!Config.developerDiagnostics) return;
        this.counters.backgroundResolves += 1;
    },

    recordPartyResolve() {
        if (!Config.developerDiagnostics) return;
        this.counters.partyResolves += 1;
    },

    recordCombat(debug = {}) {
        if (!Config.developerDiagnostics) return;
        this.counters.combatActions += Math.max(0, Number(debug.combatActions) || 0);
        this.counters.skillUses += Math.max(0, Number(debug.skillUses) || 0);
        this.counters.heals += Math.max(0, Number(debug.heals) || 0);
        this.counters.partyBuffCasts += Math.max(0, Number(debug.partyBuffCasts) || 0);
        this.counters.coldPulls += Math.max(0, Number(debug.pulls) || 0);
        this.counters.coldPullMobs += Math.max(0, Number(debug.pullMobs) || 0);
        this.counters.coldAreaPullHits += Math.max(0, Number(debug.areaPullHits) || 0);
        const shareCut = Math.max(0, Number(debug.shareCut) || 0);
        if (shareCut > 0) this.counters.coldShareBoundResolves += 1;
        this.counters.coldShareCutFights += shareCut;
        // The summary line and the status show none of these; the box and batch checks read developerDiagnostics counts.
        for (const [reason, amount] of [['party_buff_casts', debug.partyBuffCasts], ['pulls', debug.pulls],
            ['pull_mobs', debug.pullMobs], ['area_pull_hits', debug.areaPullHits], ['share_cut_fights', shareCut],
            ['share_bound_resolves', shareCut > 0 ? 1 : 0]]) {
            const n = Math.trunc(Number(amount) || 0);
            if (n > 0) Diagnostics.count('cold', 'combat', reason, n);
        }
    },

    recordSkippedResolve(reason = 'unknown') {
        if (!Config.developerDiagnostics) return;
        this.counters.skippedResolves += 1;
        const key = String(reason || 'unknown');
        this.interval.skippedResolveReasons.set(key, Number(this.interval.skippedResolveReasons.get(key) || 0) + 1);
    },

    // durationMs: the whole transition of one bot (solo, party or PvP group: each member gets the
    // group's time): cold -> hot from activate() to the spawned session, hot -> cold until the
    // session is gone. The player waits on the first; the second is main-thread work as they leave.
    recordActivation(durationMs) {
        if (!Config.developerDiagnostics) return;
        this.counters.activations += 1;
        this.pushTransition('activationDurationsMs', durationMs);
    },

    // Always counted: the reason map holds at most KEY_LIMIT keys between summaries.
    recordActivationRefusal(reason = 'unknown') {
        this.counters.activationRefusals += 1;
        const key = String(reason || 'unknown');
        this.interval.activationRefusalReasons.set(key, Number(this.interval.activationRefusalReasons.get(key) || 0) + 1);
    },

    recordLateInViewActivation(kind = null) {
        this.counters.lateInViewActivations += 1;
        if (kind === 'walker') this.counters.lateInViewWalkers += 1;
    },

    recordWalkerRoadStepBack() {
        this.counters.walkerRoadStepBacks += 1;
    },

    recordSpotPlaceRecovery() {
        this.counters.spotPlaceRecoveries += 1;
    },

    recordWalkerStartTownPlacement() {
        this.counters.walkerStartTownPlacements += 1;
    },

    recordTownDepartureRouteFailure() {
        this.counters.townDepartureRouteFailures += 1;
    },

    recordTownStuckEscape() {
        this.counters.townStuckEscapes += 1;
    },

    recordCooldown(durationMs) {
        if (!Config.developerDiagnostics) return;
        this.counters.cooldowns += 1;
        this.pushTransition('cooldownDurationsMs', durationMs);
    },

    pushTransition(key, durationMs) {
        if (!Number.isFinite(durationMs)) return;
        this.interval[key].push(Math.max(0, durationMs));
        if (this.interval[key].length > Config.resolveSampleLimit) this.interval[key].shift();
    },

    recordPartySafetyRepair() {
        if (!Config.developerDiagnostics) return;
        this.counters.partySafetyRepairs++;
        this.counters.missedEventsRecovered++;
    },

    recordPartyFormation() {
        if (!Config.developerDiagnostics) return;
        this.counters.partyFormations += 1;
    },

    recordPartyRecruit(count = 1) {
        if (!Config.developerDiagnostics) return;
        this.counters.partyRecruits += Math.max(1, Number(count) || 1);
    },

    recordPartyDissolution() {
        if (!Config.developerDiagnostics) return;
        this.counters.partyDissolutions += 1;
    },

    recordDbFlush() {
        if (!Config.developerDiagnostics) return;
        this.counters.dbFlushes += 1;
    },

    recordResolveDuration(ms) {
        if (!Config.developerDiagnostics) return;
        const value = Math.max(0, Number(ms) || 0);
        this.interval.resolveDurationsMs.push(value);
        if (this.interval.resolveDurationsMs.length > Config.resolveSampleLimit) {
            this.interval.resolveDurationsMs.shift();
        }
        if (value >= Config.resolveSlowMs) {
            this.counters.slowResolves += 1;
        }
    },

    recordBackgroundDeferral() {
        if (!Config.developerDiagnostics) return;
        this.counters.backgroundDeferrals += 1;
    },

    recordColdOwnerCommit(result = {}, durationMs = 0) {
        if (!Config.developerDiagnostics) return;
        this.interval.coldOwnerCommitDurationsMs.push(Math.max(0, Number(durationMs) || 0));
        if (this.interval.coldOwnerCommitDurationsMs.length > Config.resolveSampleLimit) this.interval.coldOwnerCommitDurationsMs.shift();
        if (result.ok) this.counters.coldOwnerCommitted += 1;
        else this.recordColdOwnerRejected(result.reason);
    },

    recordColdOwnerRejected(reason = 'unknown') {
        if (!Config.developerDiagnostics) return;
        const key = String(reason || 'unknown');
        this.counters.coldOwnerRejected += 1;
        this.interval.coldOwnerRejectReasons.set(key, Number(this.interval.coldOwnerRejectReasons.get(key) || 0) + 1);
    },

    recordColdOwnerError(error = null) {
        if (!Config.developerDiagnostics) return;
        this.counters.coldOwnerErrors += 1;
        const message = String(error?.message || error || '');
        if (/SQLITE_BUSY|database is locked/i.test(message)) this.counters.coldOwnerDbBusy += 1;
    },

    recordColdOwnerLegacyDeferred(reason = 'unknown') {
        if (!Config.developerDiagnostics) return;
        const key = String(reason || 'unknown');
        this.counters.coldOwnerLegacyDeferred += 1;
        this.interval.coldOwnerLegacyReasons.set(key, Number(this.interval.coldOwnerLegacyReasons.get(key) || 0) + 1);
    },

    recordColdOwnerHandoff(result = {}) {
        if (!Config.developerDiagnostics) return;
        if (result.ok && result.reason === 'hot_handoff') this.counters.coldOwnerHandoffs += 1;
        else if (!result.ok) this.recordColdOwnerRejected(result.reason);
    },

    recordLegacyOwnershipConflict() {
        if (!Config.developerDiagnostics) return;
        this.counters.legacyOwnershipConflicts += 1;
    },

    recordStateRetention(result = {}, durationMs = 0, overBudget = false) {
        if (!Config.developerDiagnostics) return;
        const rows = Math.max(0, Number(result.rowsRemoved || 0));
        const policy = String(result.policy || 'unknown');
        this.counters.stateRetentionRuns += 1;
        this.counters.stateRetentionRows += rows;
        this.counters.stateRetentionErrors += Math.max(0, Number(result.errors || 0));
        if (overBudget) this.counters.stateRetentionOverruns += 1;
        this.schedulerState = {
            ...this.schedulerState,
            stateRetentionPolicy: policy,
            stateRetentionNextPolicy: String(result.nextPolicy || 'unknown')
        };
        this.interval.stateRetentionDurationsMs.push(Math.max(0, Number(durationMs) || 0));
        if (this.interval.stateRetentionDurationsMs.length > Config.resolveSampleLimit) {
            this.interval.stateRetentionDurationsMs.shift();
        }
        if (rows > 0) {
            this.interval.stateRetentionPolicyRows.set(
                policy,
                Number(this.interval.stateRetentionPolicyRows.get(policy) || 0) + rows
            );
        }
    },

    recordActivationFloorScan(scan = {}) {
        if (!Config.developerDiagnostics) return;
        const candidates = Math.max(0, Number(scan.candidates) || 0);
        const accepted = Math.max(0, Number(scan.accepted) || 0);
        const rejected = Math.max(0, Number(scan.rejected) || 0);
        this.counters.activationFloorCandidates += candidates;
        this.counters.activationFloorAccepted += accepted;
        this.counters.activationFloorRejected += rejected;
        this.counters.activationFloorGeoChecks += Math.max(0, Number(scan.geoChecks) || 0);
        this.counters.activationFloorCacheHits += Math.max(0, Number(scan.cacheHits) || 0);
        this.counters.activationFloorBudgetDeferred += Math.max(0, Number(scan.budgetDeferred) || 0);
        this.interval.activationFloorDurationsMs.push(Math.max(0, Number(scan.durationMs) || 0));
        if (this.interval.activationFloorDurationsMs.length > Config.resolveSampleLimit) this.interval.activationFloorDurationsMs.shift();
        Object.entries(scan.reasons || {}).forEach(([reason, count]) => {
            const key = String(reason || 'unknown');
            this.interval.activationFloorReasons.set(key, Number(this.interval.activationFloorReasons.get(key) || 0) + Math.max(0, Number(count) || 0));
        });
    },

    recordPartyFormationDeferral() {
        if (!Config.developerDiagnostics) return;
        this.counters.partyFormationDeferrals += 1;
    },

    recordSchedulerProfile(profile = {}) {
        this.schedulerState = {
            ...this.schedulerState,
            mode: profile.idle ? 'idle' : 'player',
            lagMs: Math.max(0, Number(profile.lagMs) || 0),
            playerMode: profile.activity?.mode || 'idle',
            realPlayers: Math.max(0, Number(profile.activity?.realPlayers) || 0),
            connectingPlayers: Math.max(0, Number(profile.activity?.connectingPlayers) || 0),
            companions: Math.max(0, Number(profile.activity?.companionCount) || 0)
        };
    },

    recordPartyFormationBudgetStop() {
        if (!Config.developerDiagnostics) return;
        this.counters.partyFormationBudgetStops += 1;
    },

    recordPartyFormationDuration(ms) {
        if (!Config.developerDiagnostics) return;
        const value = Math.max(0, Number(ms) || 0);
        this.interval.partyFormationDurationsMs.push(value);
        if (this.interval.partyFormationDurationsMs.length > Config.resolveSampleLimit) {
            this.interval.partyFormationDurationsMs.shift();
        }
    },

    recordPartyFormationStage(stage, ms) {
        if (!Config.developerDiagnostics) return;
        const key = String(stage || 'unknown');
        const values = this.interval.partyFormationStageDurationsMs.get(key) || [];
        values.push(Math.max(0, Number(ms) || 0));
        if (values.length > Config.resolveSampleLimit) values.shift();
        this.interval.partyFormationStageDurationsMs.set(key, values);
    },

    recordPathfindingDuration(kind, ms) {
        if (!Config.developerDiagnostics) return;
        const key = kind === 'companion' ? 'companionPathDurationsMs' : 'actorPathDurationsMs';
        const values = this.interval[key];
        values.push(Math.max(0, Number(ms) || 0));
        if (values.length > Config.resolveSampleLimit) values.shift();
    },

    currentEventLoopLag() {
        return Number(this.eventLoop.lagMs || 0);
    },

    recordLagReading(lag) {
        this.lagHistory.push(Math.max(0, Number(lag) || 0));
        if (this.lagHistory.length > LAG_WINDOW) this.lagHistory.splice(0, this.lagHistory.length - LAG_WINDOW);
    },

    // Lag that most of the recent readings reach (the median of three; the lower of two with two readings):
    // one late reading, a GC pause or a burst of queued callbacks, does not read as a loaded loop.
    sustainedEventLoopLag() {
        if (!this.lagHistory.length) return 0;
        const sorted = [...this.lagHistory].sort((a, b) => a - b);
        return sorted[Math.floor((sorted.length - 1) / 2)];
    },

    snapshot() {
        if (!Config.developerDiagnostics) return { enabled: false };
        const elapsedMs = Math.max(1, now() - (this.startedAt || now()));
        const histogram = this.delayHistogram;
        // Main's turn length over the summary's window (loopDelay: the resolution is off the numbers).
        const delay = { resolutionMs: DELAY_RESOLUTION_MS, windowMs: histogram ? Math.max(0, now() - this.delayWindowStartedAt) : 0,
            ...WorkerHeapTelemetry.loopDelay(histogram, DELAY_RESOLUTION_MS) };
        histogram?.reset();
        this.delayWindowStartedAt = now();
        const delta = {};

        Object.keys(this.counters).forEach((key) => {
            delta[key] = this.counters[key] - (this.lastSummaryCounters[key] || 0);
        });

        this.lastSummaryCounters = { ...this.counters };
        const resolveStats = stats(this.interval.resolveDurationsMs);
        const partyFormationStats = stats(this.interval.partyFormationDurationsMs);
        const actorPathStats = stats(this.interval.actorPathDurationsMs);
        const companionPathStats = stats(this.interval.companionPathDurationsMs);
        const activationFloorStats = stats(this.interval.activationFloorDurationsMs);
        const transitions = { activation: stats(this.interval.activationDurationsMs), cooldown: stats(this.interval.cooldownDurationsMs) };
        const coldOwnerCommitStats = stats(this.interval.coldOwnerCommitDurationsMs);
        const partyFormationStages = Object.fromEntries(Array.from(this.interval.partyFormationStageDurationsMs.entries())
            .map(([stage, values]) => [stage, stats(values)]));
        const skippedResolveReasons = Object.fromEntries(this.interval.skippedResolveReasons.entries());
        const activationRefusalReasons = Object.fromEntries(this.interval.activationRefusalReasons.entries());
        const activationFloorReasons = Object.fromEntries(this.interval.activationFloorReasons.entries());
        const coldOwnerLegacyReasons = Object.fromEntries(this.interval.coldOwnerLegacyReasons.entries());
        const coldOwnerRejectReasons = Object.fromEntries(this.interval.coldOwnerRejectReasons.entries());
        const stateRetentionStats = stats(this.interval.stateRetentionDurationsMs);
        const stateRetentionPolicyRows = Object.fromEntries(this.interval.stateRetentionPolicyRows.entries());
        this.interval.resolveDurationsMs = [];
        this.interval.partyFormationDurationsMs = [];
        this.interval.actorPathDurationsMs = [];
        this.interval.companionPathDurationsMs = [];
        this.interval.activationFloorDurationsMs = [];
        this.interval.activationDurationsMs = [];
        this.interval.cooldownDurationsMs = [];
        this.interval.coldOwnerCommitDurationsMs = [];
        this.interval.activationFloorReasons = new DiagnosticMetricMap();
        this.interval.coldOwnerLegacyReasons = new DiagnosticMetricMap();
        this.interval.coldOwnerRejectReasons = new DiagnosticMetricMap();
        this.interval.stateRetentionDurationsMs = [];
        this.interval.stateRetentionPolicyRows = new DiagnosticMetricMap();
        this.interval.partyFormationStageDurationsMs = new DiagnosticMetricMap();
        this.interval.skippedResolveReasons = new DiagnosticMetricMap();
        this.interval.activationRefusalReasons = new DiagnosticMetricMap();

        return {
            uptimeMs: elapsedMs,
            counters: { ...this.counters },
            delta,
            eventLoop: { ...this.eventLoop, delay },
            resolve: resolveStats,
            scheduler: { ...this.schedulerState },
            partyFormation: partyFormationStats,
            pathfinding: {
                actor: actorPathStats,
                companion: companionPathStats
            },
            activationFloor: {
                ...activationFloorStats,
                reasons: activationFloorReasons
            },
            transitions,
            coldOwner: {
                commit: coldOwnerCommitStats,
                legacyReasons: coldOwnerLegacyReasons,
                rejectReasons: coldOwnerRejectReasons
            },
            stateRetention: {
                ...stateRetentionStats,
                policy: this.schedulerState.stateRetentionPolicy || 'none',
                nextPolicy: this.schedulerState.stateRetentionNextPolicy || 'none',
                policyRows: stateRetentionPolicyRows
            },
            partyFormationStages,
            skippedResolveReasons,
            activationRefusalReasons,
            memory: process.memoryUsage ? process.memoryUsage() : null
        };
    }
};

module.exports = PopulationMetrics;
