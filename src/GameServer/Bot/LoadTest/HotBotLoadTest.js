const Database = invoke('Database');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotAI = invoke('GameServer/Bot/BotAI');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');

const PREFIX = 'bot_load_';
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

    start() {
        if (this.started) return;
        this.started = true;

        const count = positiveEnv('L2NODE_HOT_LOAD_COUNT', 50, 1, 500);
        const durationMs = positiveEnv('L2NODE_HOT_LOAD_DURATION_MS', 60000, 5000, 30 * 60 * 1000);
        const tickMs = positiveEnv('L2NODE_HOT_LOAD_TICK_MS', 1000, 250, 10000);
        const spreadMs = positiveEnv('L2NODE_HOT_LOAD_SPREAD_MS', 100, 25, tickMs);
        const provisionTimeoutMs = positiveEnv('L2NODE_HOT_LOAD_PROVISION_TIMEOUT_MS', 120000, 30000, 10 * 60 * 1000);
        const runStartedAt = Date.now();

        console.info('HotLoad    :: provisioning %d real hot bot(s), duration=%dms tick=%dms', count, durationMs, tickMs);
        Array.from({ length: count }, (_, index) => profileFor(index))
            .forEach((profile, index) => BotManager.provisionAndSpawn(profile, index));

        const provisionDeadline = Date.now() + provisionTimeoutMs;
        const waitForBots = setInterval(() => {
            const spawned = hotSessions().length;
            if (spawned < count && Date.now() < provisionDeadline) return;
            clearInterval(waitForBots);
            if (spawned !== count) {
                this.finish({
                    ok: false,
                    reason: 'provision_timeout',
                    requested: count,
                    spawned,
                    provisionMs: Date.now() - runStartedAt
                });
                return;
            }
            this.measure({ count, durationMs, tickMs, spreadMs, runStartedAt });
        }, 100);
    },

    measure({ count, durationMs, tickMs, spreadMs, runStartedAt }) {
        Promise.all(hotSessions().map((session) => Database.fetchItems(session.actor.fetchId())
            .then((items) => [session.actor.fetchId(), items[0] || null])))
            .then((entries) => this.measureReady({
                count, durationMs, tickMs, spreadMs, runStartedAt, itemByCharacter: new Map(entries)
            }))
            .catch((error) => this.finish({
                ok: false,
                reason: 'inventory_load_failed',
                requested: count,
                spawned: hotSessions().length,
                provisionMs: Date.now() - runStartedAt,
                errors: [error.message || String(error)]
            }));
    },

    measureReady({ count, durationMs, tickMs, spreadMs, runStartedAt, itemByCharacter }) {
        const startedAt = Date.now();
        const baseline = Database.stats({ resetPeak: true });
        const lagSamples = [];
        const tickDurations = [];
        const errors = [];
        const profiler = createProfiler();
        const BotStatus = invoke('GameServer/Bot/AI/BotStatus');
        const HuntingState = invoke('GameServer/Bot/AI/States/HuntingState');
        const World = invoke('GameServer/World/World');
        const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
        profiler.wrap('status', BotStatus, 'getStatus');
        profiler.wrap('hunting', HuntingState, 'tick');
        profiler.wrap('npcRadius', World, 'fetchNpcsInRadius');
        profiler.wrap('lineOfSight', GeodataEngine, 'hasLineOfSight');
        let totalTicks = 0;
        let persistenceWrites = 0;
        let expectedLagAt = Date.now() + 100;
        const shards = Math.max(1, Math.ceil(tickMs / spreadMs));
        let activeShard = 0;

        hotSessions().forEach((session) => {
            session.aiActive = false;
            if (session.aiTimeout) clearTimeout(session.aiTimeout);
            session.aiTimeout = null;
        });

        const lagTimer = setInterval(() => {
            const measuredAt = Date.now();
            lagSamples.push(Math.max(0, measuredAt - expectedLagAt));
            expectedLagAt = measuredAt + 100;
        }, 100);
        const tickTimer = setInterval(() => {
            const tickStartedAt = Date.now();
            hotSessions().forEach((session, index) => {
                if (index % shards !== activeShard) return;
                try {
                    const actor = session.actor;
                    BotAI.tick(session);
                    CharacterWriteQueue.location(actor.fetchId(), {
                        locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ(), head: actor.fetchHead()
                    });
                    CharacterWriteQueue.vitals(actor.fetchId(), actor.fetchHp(), actor.fetchMaxHp(), actor.fetchMp(), actor.fetchMaxMp());
                    CharacterWriteQueue.experience(actor.fetchId(), actor.fetchLevel(), actor.fetchExp(), actor.fetchSp());
                    const item = itemByCharacter.get(actor.fetchId());
                    if (item) CharacterWriteQueue.itemAmount(actor.fetchId(), item.id, item.amount);
                    persistenceWrites += item ? 4 : 3;
                    totalTicks += 1;
                } catch (error) {
                    errors.push(error.message || String(error));
                }
            });
            tickDurations.push(Date.now() - tickStartedAt);
            activeShard = (activeShard + 1) % shards;
        }, spreadMs);

        setTimeout(() => {
            clearInterval(lagTimer);
            clearInterval(tickTimer);
            const expectedTicks = count * Math.max(1, Math.floor(durationMs / tickMs) - 1);
            const after = Database.stats();
            const result = {
                ok: errors.length === 0 && hotSessions().length === count && totalTicks >= expectedTicks * 0.9,
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
                    tickMaxMs: maximum(tickDurations)
                },
                eventLoop: {
                    samples: lagSamples.length,
                    lagP95Ms: percentile(lagSamples, 0.95),
                    lagMaxMs: maximum(lagSamples)
                },
                database: {
                    peakPending: after.maxPending,
                    total: after.total - baseline.total,
                    reads: after.reads - baseline.reads,
                    writes: after.writes - baseline.writes,
                    transactions: after.transactions - baseline.transactions,
                    failures: after.failures - baseline.failures,
                    operations: operationDelta(baseline.operations, after.operations)
                },
                profile: profiler.snapshot(),
                memory: process.memoryUsage(),
                errors: errors.slice(0, 10)
            };
            profiler.restore();
            this.finish(result);
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
