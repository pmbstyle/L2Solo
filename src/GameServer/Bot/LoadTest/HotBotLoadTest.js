const Database = invoke('Database');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotAI = invoke('GameServer/Bot/BotAI');
const HotAiDispatcher = invoke('GameServer/Bot/AI/HotAiDispatcher');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const MixedRuntimeSlo = require('./MixedRuntimeSlo');
const { performance } = require('perf_hooks');

const PREFIX = 'bot_load_';
const PLAYER_ACCOUNT = 'load_player';
const PLAYER_NAME = 'LoadPlayer';
const CLASS_PROFILES = [
    { race: 0, classId: 0 },
    { race: 1, classId: 10 },
    { race: 2, classId: 18 },
    { race: 3, classId: 25 }
];

function positiveEnv(name, fallback, min, max) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(value)));
}

function percentile(values, ratio) {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]);
}

function maximum(values) {
    return values.reduce((current, value) => Math.max(current, value), 0);
}

function loadMode() {
    return process.env.L2NODE_HOT_LOAD_MODE === 'mixed' ? 'mixed' : 'isolated';
}

function hotSessions() {
    return BotManager.sessions.filter((session) => (
        session.actor && String(session.accountId || '').startsWith(PREFIX)
    ));
}

function operationDelta(before = {}, after = {}) {
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    return Object.fromEntries([...names].map((name) => {
        const initial = before[name] || {};
        const current = after[name] || {};
        return [name, {
            count: Number(current.count || 0) - Number(initial.count || 0),
            waitMs: Number(current.waitMs || 0) - Number(initial.waitMs || 0),
            runMs: Number(current.runMs || 0) - Number(initial.runMs || 0),
            failures: Number(current.failures || 0) - Number(initial.failures || 0)
        }];
    }));
}

function profileFor(index) {
    const profile = CLASS_PROFILES[index % CLASS_PROFILES.length];
    const serial = String(index + 1).padStart(4, '0');
    return {
        username: `${PREFIX}${serial}`,
        name: `Load${serial}`,
        race: profile.race,
        sex: index % 2,
        classId: profile.classId,
        face: index % 3,
        hair: index % 5,
        hairColor: index % 4,
        plan: 'hunting',
        fullNewbieBlessing: false
    };
}

function playerProfile() {
    return {
        username: PLAYER_ACCOUNT,
        name: PLAYER_NAME,
        race: 0,
        sex: 0,
        classId: 0,
        face: 0,
        hair: 0,
        hairColor: 0,
        plan: 'hunting',
        fullNewbieBlessing: false
    };
}

function packetBytes(packet) {
    if (Buffer.isBuffer(packet)) return packet.length;
    if (packet?.buffer && Buffer.isBuffer(packet.buffer)) return packet.buffer.length;
    return Number(packet?.length || 0);
}

class LoadPlayerSession {
    constructor(actor) {
        this.accountId = PLAYER_ACCOUNT;
        this.actor = actor;
        this.packetCount = 0;
        this.packetBytes = 0;
    }

    fetchAccountId() { return this.accountId; }

    recordPacket(packet) {
        this.packetCount += 1;
        this.packetBytes += packetBytes(packet);
    }

    dataSendToMe(packet) { this.recordPacket(packet); }
    dataSendToOthers(packet) { this.recordPacket(packet); }
    dataSendToMeAndOthers(packet) { this.recordPacket(packet); }
}

function attachPlayerProbe() {
    const source = BotManager.sessions.find((session) => (
        session?.actor && String(session.accountId || '') === PLAYER_ACCOUNT
    ));
    if (!source) return null;

    source.aiActive = false;
    if (source.aiTimeout) clearTimeout(source.aiTimeout);
    source.aiTimeout = null;
    HotAiDispatcher.cancel(source);
    BotManager.sessions = BotManager.sessions.filter((session) => session !== source);

    const player = new LoadPlayerSession(source.actor);
    player.actor.session = player;
    invoke('GameServer/World/World').insertUser(player);
    return player;
}

function positionPacket(actor, sequence = 0) {
    const packet = Buffer.alloc(21);
    packet.writeInt32LE(Number(actor.fetchLocX?.() || 0), 1);
    packet.writeInt32LE(Number(actor.fetchLocY?.() || 0), 5);
    packet.writeInt32LE(Number(actor.fetchLocZ?.() || 0), 9);
    packet.writeInt32LE((Number(actor.fetchHead?.() || 0) + sequence) & 0xffff, 13);
    packet.writeInt32LE(0, 17);
    return packet;
}

function counterDelta(before = {}, after = {}) {
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    return Object.fromEntries([...names].map((name) => [
        name,
        Number(after[name] || 0) - Number(before[name] || 0)
    ]));
}

function latencyStats(values) {
    return {
        samples: values.length,
        p50Ms: percentile(values, 0.50),
        p95Ms: percentile(values, 0.95),
        p99Ms: percentile(values, 0.99),
        maxMs: maximum(values)
    };
}

function createProfiler() {
    const samples = new Map();
    const restore = [];
    return {
        wrap(label, target, method) {
            if (!target || typeof target[method] !== 'function') return;
            const original = target[method];
            target[method] = function profiledMethod(...args) {
                const startedAt = Date.now();
                try {
                    return original.apply(this, args);
                } finally {
                    if (!samples.has(label)) samples.set(label, []);
                    samples.get(label).push(Date.now() - startedAt);
                }
            };
            restore.push(() => { target[method] = original; });
        },
        snapshot() {
            return Object.fromEntries([...samples.entries()].map(([label, values]) => [label, {
                count: values.length,
                totalMs: values.reduce((sum, value) => sum + value, 0),
                p95Ms: percentile(values, 0.95),
                maxMs: maximum(values)
            }]));
        },
        restore() {
            restore.splice(0).reverse().forEach((callback) => callback());
        }
    };
}

function emit(result) {
    process.stdout.write(`HOT_LOAD_RESULT ${JSON.stringify(result)}\n`);
}

const HotBotLoadTest = {
    started: false,
    playerSession: null,
    stableStateTotal: -1,
    stableSince: 0,

    start() {
        if (this.started) return;
        this.started = true;

        const count = positiveEnv('L2NODE_HOT_LOAD_COUNT', 50, 1, 500);
        const durationMs = positiveEnv('L2NODE_HOT_LOAD_DURATION_MS', 60000, 5000, 30 * 60 * 1000);
        const tickMs = positiveEnv('L2NODE_HOT_LOAD_TICK_MS', 1000, 250, 10000);
        const spreadMs = positiveEnv('L2NODE_HOT_LOAD_SPREAD_MS', 100, 25, tickMs);
        const provisionTimeoutMs = positiveEnv('L2NODE_HOT_LOAD_PROVISION_TIMEOUT_MS', 120000, 30000, 10 * 60 * 1000);
        const mode = loadMode();
        const coldMin = mode === 'mixed'
            ? positiveEnv('L2NODE_MIXED_LOAD_COLD_MIN', 100, 1, 2000)
            : 0;
        const warmupStableMs = mode === 'mixed'
            ? positiveEnv('L2NODE_MIXED_WARMUP_STABLE_MS', 2000, 500, 30000)
            : 0;
        const runStartedAt = Date.now();

        console.info(
            'HotLoad    :: mode=%s provisioning %d hot bot(s), coldMin=%d duration=%dms tick=%dms',
            mode, count, coldMin, durationMs, tickMs
        );
        Array.from({ length: count }, (_, index) => profileFor(index))
            .forEach((profile, index) => BotManager.provisionAndSpawn(profile, index));
        if (mode === 'mixed') BotManager.provisionAndSpawn(playerProfile(), count + 1);

        const provisionDeadline = Date.now() + provisionTimeoutMs;
        const waitForBots = setInterval(() => {
            const spawned = hotSessions().length;
            const lifeCounts = mode === 'mixed'
                ? invoke('GameServer/Bot/Population/BotLifeState').counts()
                : { cold: 0, total: 0 };
            const cold = lifeCounts.cold;
            const seeding = mode === 'mixed'
                ? invoke('GameServer/Bot/Population/GeneratedColdSeeder').running
                : false;
            const playerSourceReady = mode !== 'mixed' || BotManager.sessions.some((session) => (
                session?.actor && String(session.accountId || '') === PLAYER_ACCOUNT
            ));
            const warmupReady = spawned === count
                && (mode !== 'mixed' || (playerSourceReady && cold >= coldMin));
            if (!warmupReady || seeding || lifeCounts.total !== this.stableStateTotal) {
                this.stableStateTotal = lifeCounts.total;
                this.stableSince = Date.now();
            }
            const stable = warmupReady && !seeding && Date.now() - this.stableSince >= warmupStableMs;
            if (mode === 'mixed' && stable && !this.playerSession) this.playerSession = attachPlayerProbe();
            const ready = stable && (mode !== 'mixed' || !!this.playerSession);
            if (!ready && Date.now() < provisionDeadline) return;
            clearInterval(waitForBots);
            if (!ready) {
                this.finish({
                    ok: false,
                    reason: 'provision_timeout',
                    mode,
                    requested: count,
                    spawned,
                    cold,
                    coldMin,
                    playerReady: !!this.playerSession,
                    provisionMs: Date.now() - runStartedAt
                });
                return;
            }
            this.measure({ count, durationMs, tickMs, spreadMs, runStartedAt, mode, coldMin });
        }, 100);
    },

    prepareMixedWorld(coldMin) {
        const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
        const candidates = LifeState.allStates(Math.max(100, coldMin + 100))
            .filter((state) => state.phase === 'cold'
                && (!state.simulation?.ownerId || state.simulation.ownerId === 'legacy_main')
                && !state.partyId
                && !state.party?.partyId
                && ['hunting', 'resting'].includes(state.activity))
            .slice(0, Math.min(32, Math.max(8, coldMin)));
        Coordinator.setPauseReason('mixed_load_warmup', true);
        const dueAt = Date.now() - 1000;
        let prepared = 0;
        return invoke('GameServer/Bot/Population/GeneratedColdSeeder').cooperativeEach(candidates, (state) => (
            LifeState.upsertState({
                ...state,
                timing: { ...(state.timing || {}), nextResolveAt: dueAt }
            }, 'mixed_load_due')
                .then((saved) => {
                    if (!saved) return null;
                    return Coordinator.acceptColdState(saved, 2000).then((accepted) => {
                        if (accepted.ok) prepared += 1;
                        return accepted;
                    });
                })
        )).then(() => prepared);
    },

    measure({ count, durationMs, tickMs, spreadMs, runStartedAt, mode, coldMin }) {
        const prepare = mode === 'mixed' ? this.prepareMixedWorld(coldMin) : Promise.resolve(0);
        prepare.then((preparedDue) => Promise.all(hotSessions().map((session) => Database.fetchItems(session.actor.fetchId())
            .then((items) => [session.actor.fetchId(), items[0] || null])))
            .then((entries) => ({ entries, preparedDue })))
            .then(({ entries, preparedDue }) => this.measureReady({
                count, durationMs, tickMs, spreadMs, runStartedAt, mode, coldMin, preparedDue,
                itemByCharacter: new Map(entries)
            }))
            .catch((error) => this.finish({
                ok: false,
                reason: 'inventory_load_failed',
                mode,
                requested: count,
                spawned: hotSessions().length,
                provisionMs: Date.now() - runStartedAt,
                errors: [error.message || String(error)]
            }));
    },

    measureReady({ count, durationMs, tickMs, spreadMs, runStartedAt, mode, coldMin, preparedDue, itemByCharacter }) {
        const startedAt = Date.now();
        const baseline = Database.stats({ resetPeak: true });
        const lagSamples = [];
        const tickDurations = [];
        const actorTickDurations = [];
        const persistenceDurations = [];
        const slowActorTicks = [];
        const errors = [];
        const profiler = createProfiler();
        const BotStatus = invoke('GameServer/Bot/AI/BotStatus');
        const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');
        const World = invoke('GameServer/World/World');
        const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
        const mixed = mode === 'mixed';
        const PopulationMetrics = mixed ? invoke('GameServer/Bot/Population/PopulationMetrics') : null;
        const LifeState = mixed ? invoke('GameServer/Bot/Population/BotLifeState') : null;
        const PopulationService = mixed ? invoke('GameServer/Bot/Population/PopulationService') : null;
        const WorldObserver = mixed ? invoke('WorldObserver/WorldObserverServer') : null;
        const ValidatePosition = mixed ? invoke('GameServer/Network/Request/ValidatePosition') : null;
        const populationBaseline = mixed ? { ...PopulationMetrics.counters } : {};
        const observerBaseline = mixed ? WorldObserver.snapshotCacheStats() : {};
        const playerIntervalMs = positiveEnv('L2NODE_MIXED_PLAYER_PROBE_MS', 50, 20, 1000);
        const observerIntervalMs = positiveEnv('L2NODE_MIXED_OBSERVER_PROBE_MS', 1000, 250, 10000);
        const thresholds = mixed ? {
            scheduleP95Ms: positiveEnv('L2NODE_MIXED_SCHEDULE_P95_MS', 40, 1, 5000),
            scheduleP99Ms: positiveEnv('L2NODE_MIXED_SCHEDULE_P99_MS', 120, 1, 10000),
            scheduleMaxMs: positiveEnv('L2NODE_MIXED_SCHEDULE_MAX_MS', 150, 1, 30000),
            handlerP95Ms: positiveEnv('L2NODE_MIXED_HANDLER_P95_MS', 25, 1, 5000),
            handlerP99Ms: positiveEnv('L2NODE_MIXED_HANDLER_P99_MS', 75, 1, 10000),
            observerP95Ms: positiveEnv('L2NODE_MIXED_OBSERVER_P95_MS', 250, 1, 30000),
            eventLoopMaxMs: positiveEnv('L2NODE_MIXED_EVENT_LOOP_MAX_MS', 150, 1, 30000)
        } : null;
        profiler.wrap('status', BotStatus, 'getStatus');
        profiler.wrap('hunting', HuntingState, 'tick');
        profiler.wrap('npcRadius', World, 'fetchNpcsInRadius');
        profiler.wrap('lineOfSight', GeodataEngine, 'hasLineOfSight');
        let totalTicks = 0;
        let persistenceWrites = 0;
        let expectedLagAt = Date.now() + 100;
        const shards = Math.max(1, Math.ceil(tickMs / spreadMs));
        let activeShard = 0;
        const playerScheduleDelays = [];
        const playerHandlerDurations = [];
        const observerDurations = [];
        const observerPending = new Set();
        let playerSequence = 0;
        let expectedPlayerAt = performance.now() + playerIntervalMs;

        hotSessions().forEach((session) => {
            session.aiActive = false;
            if (session.aiTimeout) clearTimeout(session.aiTimeout);
            session.aiTimeout = null;
            HotAiDispatcher.cancel(session);
        });
        // Provisioning intentionally exercises normal BotAI lifecycle. Start
        // the measured interval with an empty queue and fresh dispatcher
        // telemetry so startup wakes cannot contaminate player-tail results.
        HotAiDispatcher.resetForTest();

        const lagTimer = setInterval(() => {
            const measuredAt = Date.now();
            lagSamples.push(Math.max(0, measuredAt - expectedLagAt));
            expectedLagAt = measuredAt + 100;
        }, 100);
        const tickTimer = setInterval(() => {
            const tickStartedAt = performance.now();
            const scheduled = hotSessions().filter((session, index) => index % shards === activeShard);
            let remaining = scheduled.length;
            scheduled.forEach((session) => {
                HotAiDispatcher.enqueue(session, () => {
                  try {
                    const actor = session.actor;
                    const actorTickStartedAt = performance.now();
                    BotAI.tick(session);
                    const actorTickDuration = performance.now() - actorTickStartedAt;
                    actorTickDurations.push(actorTickDuration);
                    if (actorTickDuration >= 10) {
                        slowActorTicks.push({
                            name: actor.fetchName?.() || session.accountId,
                            plan: session.plan || 'none',
                            lod: session.hotActorLod?.tier || 'unknown',
                            durationMs: Number(actorTickDuration.toFixed(3))
                        });
                        if (slowActorTicks.length > 20) {
                            slowActorTicks.sort((left, right) => right.durationMs - left.durationMs);
                            slowActorTicks.length = 20;
                        }
                    }
                    const persistenceStartedAt = performance.now();
                    CharacterWriteQueue.location(actor.fetchId(), {
                        locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ(), head: actor.fetchHead()
                    });
                    CharacterWriteQueue.vitals(actor.fetchId(), actor.fetchHp(), actor.fetchMaxHp(), actor.fetchMp(), actor.fetchMaxMp());
                    CharacterWriteQueue.experience(actor.fetchId(), actor.fetchLevel(), actor.fetchExp(), actor.fetchSp());
                    const item = itemByCharacter.get(actor.fetchId());
                    if (item) CharacterWriteQueue.itemAmount(actor.fetchId(), item.id, item.amount);
                    persistenceDurations.push(performance.now() - persistenceStartedAt);
                    persistenceWrites += item ? 4 : 3;
                    totalTicks += 1;
                  } catch (error) {
                    errors.push(error.message || String(error));
                  } finally {
                    remaining -= 1;
                    if (remaining === 0) tickDurations.push(performance.now() - tickStartedAt);
                  }
                }, { onError: (error) => errors.push(error.message || String(error)) });
            });
            if (scheduled.length === 0) tickDurations.push(0);
            activeShard = (activeShard + 1) % shards;
        }, spreadMs);

        const playerTimer = mixed ? setInterval(() => {
            const measuredAt = performance.now();
            playerScheduleDelays.push(Math.max(0, measuredAt - expectedPlayerAt));
            expectedPlayerAt = measuredAt + playerIntervalMs;
            const handlerStartedAt = performance.now();
            try {
                ValidatePosition(this.playerSession, positionPacket(this.playerSession.actor, playerSequence));
                playerSequence += 1;
            } catch (error) {
                errors.push(`player_probe: ${error.message || error}`);
            } finally {
                playerHandlerDurations.push(performance.now() - handlerStartedAt);
            }
        }, playerIntervalMs) : null;

        const observerTimer = mixed ? setInterval(() => {
            const observerStartedAt = performance.now();
            let pending;
            pending = Promise.resolve()
                .then(() => WorldObserver.snapshotJson())
                .then(() => observerDurations.push(performance.now() - observerStartedAt))
                .catch((error) => errors.push(`observer_probe: ${error.message || error}`))
                .finally(() => observerPending.delete(pending));
            observerPending.add(pending);
        }, observerIntervalMs) : null;
        if (mixed) {
            invoke('GameServer/Bot/Population/ColdSimulationCoordinator')
                .setPauseReason('mixed_load_warmup', false);
        }

        setTimeout(() => {
            clearInterval(lagTimer);
            clearInterval(tickTimer);
            hotSessions().forEach((session) => HotAiDispatcher.cancel(session));
            if (playerTimer) clearInterval(playerTimer);
            if (observerTimer) clearInterval(observerTimer);
            Promise.allSettled([...observerPending]).then(() => {
                const expectedTicks = count * Math.max(1, Math.floor(durationMs / tickMs) - 1);
                const after = Database.stats();
                const databaseFailures = after.failures - baseline.failures;
                const playerSchedule = latencyStats(playerScheduleDelays);
                const playerHandler = latencyStats(playerHandlerDurations);
                const observerLatency = latencyStats(observerDurations);
                const cadenceExpected = mixed
                    ? durationMs / Math.max(1, playerIntervalMs + playerSchedule.p50Ms)
                    : 0;
                const cadenceRatio = cadenceExpected > 0 ? playerSchedule.samples / cadenceExpected : 1;
                const population = mixed ? {
                    preparedDue,
                    coldMinimum: coldMin,
                    counts: LifeState.counts(),
                    delta: counterDelta(populationBaseline, PopulationMetrics.counters),
                    activity: PopulationService.playerActivityProfile(),
                    worker: invoke('GameServer/Bot/Population/ColdSimulationCoordinator').snapshot()
                } : null;
                const observerAfter = mixed ? WorldObserver.snapshotCacheStats() : null;
                const observerBuilds = mixed
                    ? Number(observerAfter.builds || 0) - Number(observerBaseline.builds || 0)
                    : 0;
                const violations = mixed ? MixedRuntimeSlo.evaluate({
                    cadenceRatio,
                    playerSchedule,
                    playerHandler,
                    observerLatency,
                    observerBuilds,
                    eventLoopMaxMs: maximum(lagSamples),
                    population,
                    preparedDue,
                    databaseFailures,
                    thresholds
                }) : (databaseFailures > 0 ? ['database_failures'] : []);
                const baseOk = errors.length === 0
                    && hotSessions().length === count
                    && totalTicks >= expectedTicks * 0.9;
                const result = {
                    ok: baseOk && violations.length === 0,
                    mode,
                    requested: count,
                    spawned: hotSessions().length,
                    durationMs: Date.now() - startedAt,
                    provisionMs: startedAt - runStartedAt,
                    schedule: { tickMs, spreadMs, shards },
                    ticks: {
                        total: totalTicks,
                        expected: expectedTicks,
                        persistenceWrites,
                        tickP95Ms: percentile(tickDurations, 0.95),
                        tickMaxMs: maximum(tickDurations),
                        actorP95Ms: percentile(actorTickDurations, 0.95),
                        actorP99Ms: percentile(actorTickDurations, 0.99),
                        actorMaxMs: maximum(actorTickDurations),
                        persistenceP95Ms: percentile(persistenceDurations, 0.95),
                        persistenceMaxMs: maximum(persistenceDurations),
                        slowActors: slowActorTicks.sort((left, right) => right.durationMs - left.durationMs)
                    },
                    eventLoop: {
                        samples: lagSamples.length,
                        lagP95Ms: percentile(lagSamples, 0.95),
                        lagMaxMs: maximum(lagSamples)
                    },
                    player: mixed ? {
                        intervalMs: playerIntervalMs,
                        expectedSamples: Math.max(1, Math.floor(durationMs / playerIntervalMs) - 1),
                        cadenceRatio: Number(cadenceRatio.toFixed(3)),
                        schedule: playerSchedule,
                        handler: playerHandler,
                        packets: this.playerSession.packetCount,
                        packetBytes: this.playerSession.packetBytes
                    } : null,
                    observer: mixed ? {
                        intervalMs: observerIntervalMs,
                        builds: observerBuilds,
                        latency: observerLatency
                    } : null,
                    population,
                    slo: mixed ? { thresholds, violations } : null,
                    database: {
                        peakPending: after.maxPending,
                        total: after.total - baseline.total,
                        reads: after.reads - baseline.reads,
                        writes: after.writes - baseline.writes,
                        transactions: after.transactions - baseline.transactions,
                        failures: databaseFailures,
                        operations: operationDelta(baseline.operations, after.operations)
                    },
                    profile: profiler.snapshot(),
                    hotDispatch: HotAiDispatcher.snapshot(),
                    memory: process.memoryUsage(),
                    errors: errors.slice(0, 10)
                };
                profiler.restore();
                this.finish(result);
            }).catch((error) => {
                profiler.restore();
                this.finish({
                    ok: false,
                    mode,
                    reason: 'measurement_finalize_failed',
                    errors: [error.message || String(error)]
                });
            });
        }, durationMs).unref?.();
    },

    finish(result) {
        CharacterWriteQueue.flushAll()
            .catch((error) => {
                result.ok = false;
                result.errors = [...(result.errors || []), `flush: ${error.message || error}`];
            })
            .then(() => Database.checkpoint())
            .catch((error) => {
                result.ok = false;
                result.errors = [...(result.errors || []), `checkpoint: ${error.message || error}`];
            })
            .finally(() => {
                emit(result);
                setTimeout(() => process.exit(result.ok ? 0 : 1), 0);
            });
    }
};

module.exports = HotBotLoadTest;
