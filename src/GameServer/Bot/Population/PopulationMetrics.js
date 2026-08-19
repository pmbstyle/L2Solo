const Config = invoke('GameServer/Bot/Population/PopulationConfig');

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
        skippedResolves: 0,
        activations: 0,
        cooldowns: 0,
        partyFormations: 0,
        partyRecruits: 0,
        partyDissolutions: 0,
        dbFlushes: 0,
        schedulerRuns: 0,
        schedulerSkips: 0,
        schedulerBudgetStops: 0,
        partyFormationBudgetStops: 0,
        schedulerYields: 0,
        schedulerOverruns: 0,
        slowResolves: 0,
        backgroundDeferrals: 0,
        partyFormationDeferrals: 0,
        activationFloorCandidates: 0,
        activationFloorAccepted: 0,
        activationFloorRejected: 0,
        activationFloorGeoChecks: 0,
        activationFloorCacheHits: 0,
        activationFloorBudgetDeferred: 0,
        coldOwnerSelected: 0,
        coldOwnerClaimed: 0,
        coldOwnerResolved: 0,
        coldOwnerCommitted: 0,
        coldOwnerReleased: 0,
        coldOwnerCasStale: 0,
        coldOwnerRejected: 0,
        coldOwnerLeaseRecoveries: 0,
        coldOwnerLeaseExpiries: 0,
        coldOwnerTimeouts: 0,
        coldOwnerErrors: 0,
        coldOwnerLegacyDeferred: 0,
        coldOwnerDbBusy: 0,
        coldOwnerDbRetries: 0,
        coldOwnerHandoffs: 0,
        warehouseCleanupRuns: 0,
        warehouseCleanupOwners: 0,
        warehouseCleanupCompacted: 0,
        warehouseCleanupRows: 0,
        warehouseCleanupUnits: 0,
        warehouseCleanupPayout: 0,
        warehouseCleanupDeferrals: 0,
        warehouseCleanupErrors: 0,
        warehouseCleanupBudgetStops: 0,
        stateRetentionRuns: 0,
        stateRetentionRows: 0,
        stateRetentionDeferrals: 0,
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

function revisionGapBucket(result = {}) {
    const expected = Number(result.expectedRevision);
    const actual = Number(result.actualRevision);
    if (!Number.isFinite(expected) || !Number.isFinite(actual)) return 'unknown';
    const gap = actual - expected;
    if (gap < 0) return 'ahead';
    if (gap === 0) return 'same';
    if (gap === 1) return '+1';
    if (gap <= 4) return '+2-4';
    if (gap <= 16) return '+5-16';
    return '+17';
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
    schedulerState: {
        budgetMs: 0,
        mode: 'unknown',
        lagMs: 0,
        coldBatch: 0,
        coldBatchLimit: 0,
        coldQueueSaturated: false
    },
    interval: {
        resolveDurationsMs: [],
        schedulerDurationsMs: [],
        schedulerSliceDurationsMs: [],
        partyFormationDurationsMs: [],
        partyFormationStageDurationsMs: new Map(),
        actorPathDurationsMs: [],
        companionPathDurationsMs: [],
        activationFloorDurationsMs: [],
        activationFloorReasons: new Map(),
        skippedResolveReasons: new Map(),
        coldOwnerClaimDurationsMs: [],
        coldOwnerCommitDurationsMs: [],
        coldOwnerLegacyReasons: new Map(),
        coldOwnerRejectReasons: new Map(),
        coldOwnerStaleRevisionGaps: new Map(),
        coldOwnerStaleOwners: new Map(),
        warehouseCleanupDurationsMs: [],
        warehouseCleanupDeferralReasons: new Map(),
        stateRetentionDurationsMs: [],
        stateRetentionDeferralReasons: new Map(),
        stateRetentionPolicyRows: new Map()
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

    recordCombat(debug = {}) {
        this.counters.combatActions += Math.max(0, Number(debug.combatActions) || 0);
        this.counters.skillUses += Math.max(0, Number(debug.skillUses) || 0);
        this.counters.heals += Math.max(0, Number(debug.heals) || 0);
    },

    recordSkippedResolve(reason = 'unknown') {
        this.counters.skippedResolves += 1;
        const key = String(reason || 'unknown');
        this.interval.skippedResolveReasons.set(key, Number(this.interval.skippedResolveReasons.get(key) || 0) + 1);
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

    recordSchedulerYield(sliceMs) {
        const value = Math.max(0, Number(sliceMs) || 0);
        this.counters.schedulerYields += 1;
        this.interval.schedulerSliceDurationsMs.push(value);
        if (this.interval.schedulerSliceDurationsMs.length > Config.resolveSampleLimit) {
            this.interval.schedulerSliceDurationsMs.shift();
        }
    },

    recordSchedulerSkip() {
        this.counters.schedulerSkips += 1;
    },

    recordSchedulerBudgetStop() {
        this.counters.schedulerBudgetStops += 1;
    },

    recordBackgroundDeferral() {
        this.counters.backgroundDeferrals += 1;
    },

    recordColdOwnerSelected() {
        this.counters.coldOwnerSelected += 1;
    },

    recordColdOwnerClaim(result = {}, durationMs = 0) {
        this.interval.coldOwnerClaimDurationsMs.push(Math.max(0, Number(durationMs) || 0));
        if (this.interval.coldOwnerClaimDurationsMs.length > Config.resolveSampleLimit) this.interval.coldOwnerClaimDurationsMs.shift();
        if (result.ok) this.counters.coldOwnerClaimed += 1;
        else this.recordColdOwnerRejected(result.reason, result);
    },

    recordColdOwnerResolved() {
        this.counters.coldOwnerResolved += 1;
    },

    recordColdOwnerCommit(result = {}, durationMs = 0) {
        this.interval.coldOwnerCommitDurationsMs.push(Math.max(0, Number(durationMs) || 0));
        if (this.interval.coldOwnerCommitDurationsMs.length > Config.resolveSampleLimit) this.interval.coldOwnerCommitDurationsMs.shift();
        if (result.ok) this.counters.coldOwnerCommitted += 1;
        else this.recordColdOwnerRejected(result.reason, result);
    },

    recordColdOwnerRelease(result = {}) {
        if (result.ok) this.counters.coldOwnerReleased += 1;
        else this.recordColdOwnerRejected(result.reason, result);
    },

    recordColdOwnerRejected(reason = 'unknown', result = {}) {
        const key = String(reason || 'unknown');
        this.counters.coldOwnerRejected += 1;
        if (['stale_revision', 'cas_failed', 'owner_changed', 'lease_changed', 'lease_expired'].includes(key)) {
            this.counters.coldOwnerCasStale += 1;
            const gap = revisionGapBucket(result);
            const owner = String(result.actualOwner || 'unknown');
            this.interval.coldOwnerStaleRevisionGaps.set(
                gap,
                Number(this.interval.coldOwnerStaleRevisionGaps.get(gap) || 0) + 1
            );
            this.interval.coldOwnerStaleOwners.set(
                owner,
                Number(this.interval.coldOwnerStaleOwners.get(owner) || 0) + 1
            );
        }
        this.interval.coldOwnerRejectReasons.set(key, Number(this.interval.coldOwnerRejectReasons.get(key) || 0) + 1);
    },

    recordColdOwnerRecovery(count = 0, startup = false) {
        const recovered = Math.max(0, Number(count) || 0);
        this.counters.coldOwnerLeaseRecoveries += recovered;
        if (!startup) this.counters.coldOwnerLeaseExpiries += recovered;
    },

    recordColdOwnerTimeout() {
        this.counters.coldOwnerTimeouts += 1;
    },

    recordColdOwnerError(error = null) {
        this.counters.coldOwnerErrors += 1;
        const message = String(error?.message || error || '');
        if (/SQLITE_BUSY|database is locked/i.test(message)) this.counters.coldOwnerDbBusy += 1;
    },

    recordColdOwnerLegacyDeferred(reason = 'unknown') {
        const key = String(reason || 'unknown');
        this.counters.coldOwnerLegacyDeferred += 1;
        this.interval.coldOwnerLegacyReasons.set(key, Number(this.interval.coldOwnerLegacyReasons.get(key) || 0) + 1);
    },

    recordColdOwnerDbRetry() {
        this.counters.coldOwnerDbRetries += 1;
    },

    recordColdOwnerHandoff(result = {}) {
        if (result.ok && result.reason === 'hot_handoff') this.counters.coldOwnerHandoffs += 1;
        else if (!result.ok) this.recordColdOwnerRejected(result.reason);
    },

    recordWarehouseCleanup(result = {}, durationMs = 0) {
        this.counters.warehouseCleanupRuns += 1;
        this.counters.warehouseCleanupOwners += Math.max(0, Number(result.ownersScanned || 0));
        this.counters.warehouseCleanupCompacted += Math.max(0, Number(result.ownersCompacted || 0));
        this.counters.warehouseCleanupRows += Math.max(0, Number(result.rowsRemoved || 0));
        this.counters.warehouseCleanupUnits += Math.max(0, Number(result.units || 0));
        this.counters.warehouseCleanupPayout += Math.max(0, Number(result.payout || 0));
        this.counters.warehouseCleanupErrors += Math.max(0, Number(result.errors || 0));
        if (result.budgetStopped) this.counters.warehouseCleanupBudgetStops += 1;
        this.schedulerState = {
            ...this.schedulerState,
            warehouseCleanupCursor: Math.max(0, Number(result.cursor || 0)),
            warehouseCleanupExhausted: !!result.exhausted
        };
        this.interval.warehouseCleanupDurationsMs.push(Math.max(0, Number(durationMs) || 0));
        if (this.interval.warehouseCleanupDurationsMs.length > Config.resolveSampleLimit) {
            this.interval.warehouseCleanupDurationsMs.shift();
        }
    },

    recordWarehouseCleanupDeferral(reason = 'unknown') {
        const key = String(reason || 'unknown');
        this.counters.warehouseCleanupDeferrals += 1;
        this.interval.warehouseCleanupDeferralReasons.set(
            key,
            Number(this.interval.warehouseCleanupDeferralReasons.get(key) || 0) + 1
        );
    },

    recordStateRetention(result = {}, durationMs = 0, overBudget = false) {
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

    recordStateRetentionDeferral(reason = 'unknown') {
        const key = String(reason || 'unknown');
        this.counters.stateRetentionDeferrals += 1;
        this.interval.stateRetentionDeferralReasons.set(
            key,
            Number(this.interval.stateRetentionDeferralReasons.get(key) || 0) + 1
        );
    },

    recordActivationFloorScan(scan = {}) {
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
        this.counters.partyFormationDeferrals += 1;
    },

    recordSchedulerProfile(profile = {}) {
        this.schedulerState = {
            ...this.schedulerState,
            budgetMs: Math.max(0, Number(profile.budgetMs) || 0),
            mode: profile.idle ? 'idle' : 'player',
            lagMs: Math.max(0, Number(profile.lagMs) || 0),
            playerMode: profile.activity?.mode || 'idle',
            realPlayers: Math.max(0, Number(profile.activity?.realPlayers) || 0),
            connectingPlayers: Math.max(0, Number(profile.activity?.connectingPlayers) || 0),
            companions: Math.max(0, Number(profile.activity?.companionCount) || 0)
        };
    },

    recordColdBatch(count = 0, limit = 0) {
        const batch = Math.max(0, Number(count) || 0);
        const cap = Math.max(0, Number(limit) || 0);
        this.schedulerState = {
            ...this.schedulerState,
            coldBatch: batch,
            coldBatchLimit: cap,
            coldQueueSaturated: cap > 0 && batch >= cap
        };
    },

    recordPartyFormationBudgetStop() {
        this.counters.partyFormationBudgetStops += 1;
    },

    recordPartyFormationDuration(ms) {
        const value = Math.max(0, Number(ms) || 0);
        this.interval.partyFormationDurationsMs.push(value);
        if (this.interval.partyFormationDurationsMs.length > Config.resolveSampleLimit) {
            this.interval.partyFormationDurationsMs.shift();
        }
    },

    recordPartyFormationStage(stage, ms) {
        const key = String(stage || 'unknown');
        const values = this.interval.partyFormationStageDurationsMs.get(key) || [];
        values.push(Math.max(0, Number(ms) || 0));
        if (values.length > Config.resolveSampleLimit) values.shift();
        this.interval.partyFormationStageDurationsMs.set(key, values);
    },

    recordPathfindingDuration(kind, ms) {
        const key = kind === 'companion' ? 'companionPathDurationsMs' : 'actorPathDurationsMs';
        const values = this.interval[key];
        values.push(Math.max(0, Number(ms) || 0));
        if (values.length > Config.resolveSampleLimit) values.shift();
    },

    currentEventLoopLag() {
        return Number(this.eventLoop.lagMs || 0);
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
        const schedulerSliceStats = stats(this.interval.schedulerSliceDurationsMs);
        const partyFormationStats = stats(this.interval.partyFormationDurationsMs);
        const actorPathStats = stats(this.interval.actorPathDurationsMs);
        const companionPathStats = stats(this.interval.companionPathDurationsMs);
        const activationFloorStats = stats(this.interval.activationFloorDurationsMs);
        const coldOwnerClaimStats = stats(this.interval.coldOwnerClaimDurationsMs);
        const coldOwnerCommitStats = stats(this.interval.coldOwnerCommitDurationsMs);
        const partyFormationStages = Object.fromEntries(Array.from(this.interval.partyFormationStageDurationsMs.entries())
            .map(([stage, values]) => [stage, stats(values)]));
        const skippedResolveReasons = Object.fromEntries(this.interval.skippedResolveReasons.entries());
        const activationFloorReasons = Object.fromEntries(this.interval.activationFloorReasons.entries());
        const coldOwnerLegacyReasons = Object.fromEntries(this.interval.coldOwnerLegacyReasons.entries());
        const coldOwnerRejectReasons = Object.fromEntries(this.interval.coldOwnerRejectReasons.entries());
        const coldOwnerStaleRevisionGaps = Object.fromEntries(this.interval.coldOwnerStaleRevisionGaps.entries());
        const coldOwnerStaleOwners = Object.fromEntries(this.interval.coldOwnerStaleOwners.entries());
        const warehouseCleanupStats = stats(this.interval.warehouseCleanupDurationsMs);
        const warehouseCleanupDeferralReasons = Object.fromEntries(this.interval.warehouseCleanupDeferralReasons.entries());
        const stateRetentionStats = stats(this.interval.stateRetentionDurationsMs);
        const stateRetentionDeferralReasons = Object.fromEntries(this.interval.stateRetentionDeferralReasons.entries());
        const stateRetentionPolicyRows = Object.fromEntries(this.interval.stateRetentionPolicyRows.entries());
        this.interval.resolveDurationsMs = [];
        this.interval.schedulerDurationsMs = [];
        this.interval.schedulerSliceDurationsMs = [];
        this.interval.partyFormationDurationsMs = [];
        this.interval.actorPathDurationsMs = [];
        this.interval.companionPathDurationsMs = [];
        this.interval.activationFloorDurationsMs = [];
        this.interval.coldOwnerClaimDurationsMs = [];
        this.interval.coldOwnerCommitDurationsMs = [];
        this.interval.activationFloorReasons = new Map();
        this.interval.coldOwnerLegacyReasons = new Map();
        this.interval.coldOwnerRejectReasons = new Map();
        this.interval.coldOwnerStaleRevisionGaps = new Map();
        this.interval.coldOwnerStaleOwners = new Map();
        this.interval.warehouseCleanupDurationsMs = [];
        this.interval.warehouseCleanupDeferralReasons = new Map();
        this.interval.stateRetentionDurationsMs = [];
        this.interval.stateRetentionDeferralReasons = new Map();
        this.interval.stateRetentionPolicyRows = new Map();
        this.interval.partyFormationStageDurationsMs = new Map();
        this.interval.skippedResolveReasons = new Map();

        return {
            uptimeMs: elapsedMs,
            counters: { ...this.counters },
            delta,
            eventLoop: { ...this.eventLoop },
            resolve: resolveStats,
            scheduler: { ...schedulerStats, ...this.schedulerState },
            schedulerSlice: schedulerSliceStats,
            partyFormation: partyFormationStats,
            pathfinding: {
                actor: actorPathStats,
                companion: companionPathStats
            },
            activationFloor: {
                ...activationFloorStats,
                reasons: activationFloorReasons
            },
            coldOwner: {
                claim: coldOwnerClaimStats,
                commit: coldOwnerCommitStats,
                legacyReasons: coldOwnerLegacyReasons,
                rejectReasons: coldOwnerRejectReasons,
                staleRevisionGaps: coldOwnerStaleRevisionGaps,
                staleOwners: coldOwnerStaleOwners
            },
            warehouseCleanup: {
                ...warehouseCleanupStats,
                cursor: this.schedulerState.warehouseCleanupCursor || 0,
                exhausted: !!this.schedulerState.warehouseCleanupExhausted,
                deferralReasons: warehouseCleanupDeferralReasons
            },
            stateRetention: {
                ...stateRetentionStats,
                policy: this.schedulerState.stateRetentionPolicy || 'none',
                nextPolicy: this.schedulerState.stateRetentionNextPolicy || 'none',
                deferralReasons: stateRetentionDeferralReasons,
                policyRows: stateRetentionPolicyRows
            },
            partyFormationStages,
            skippedResolveReasons,
            memory: process.memoryUsage ? process.memoryUsage() : null
        };
    }
};

module.exports = PopulationMetrics;
