const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const GeodataEngine = require('./GeodataEngine');
const RestartBackoff = require('../../WorkerRestartBackoff');

// Crash reasons whose stack was already logged (each crash is logged, the
// stack once per reason).
const STACK_REASONS_MAX = 32;

function taskError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

class BoundedPathfindingWorkerPool {
    constructor(options = {}) {
        const available = Math.max(1, Number(os.availableParallelism?.() || os.cpus().length || 1));
        this.size = Math.max(1, Math.min(2, Number(options.size) || Math.max(1, available - 1)));
        this.queueLimit = Math.max(this.size, Number(options.queueLimit) || 128);
        this.workerPath = options.workerPath || path.join(__dirname, 'PathfindingWorker.js');
        this.workerFactory = options.workerFactory || ((workerPath) => new Worker(workerPath, { workerData: {
            developerDiagnostics: DiagnosticConfig.developerDiagnostics === true,
            sharedGeodata: GeodataEngine.sharedDescriptor()
        } }));
        this.workers = [];
        // Per slot: crashes in a row (RestartBackoff) and the pending respawn.
        this.restartCrashes = [];
        this.restartTimers = [];
        this.stackReasons = new Set();
        this.queue = [];
        this.tasks = new Map();
        this.latestByKey = new Map();
        this.nextId = 1;
        this.started = false;
        this.shuttingDown = false;
        this.townWindowAt = Date.now();
        this.townWorkMs = 0;
        this.budgetTimer = null;
        // Always counted (status line): worker crashes and respawns.
        this.health = { crashes: 0, respawns: 0 };
        this.metrics = {
            queued: 0,
            completed: 0,
            stale: 0,
            preempted: 0,
            errors: 0,
            rejected: 0,
            maxQueue: 0,
            workerMs: 0, maxQueueWaitMs: 0, budgetDeferrals: 0
        };
    }

    init() {
        if (this.started || this.shuttingDown) return;
        this.started = true;
        for (let index = 0; index < this.size; index++) this.spawn(index);
    }

    spawn(index) {
        let worker;
        try {
            worker = this.workerFactory(this.workerPath, index);
        } catch (error) {
            this.onWorkerFailure({ index, worker: null, task: null }, error);
            return;
        }
        const slot = { index, worker, task: null, upSince: Date.now() };
        this.workers[index] = slot;
        worker.on('message', (message) => this.onMessage(slot, message));
        worker.on('error', (error) => this.onWorkerFailure(slot, error));
        worker.on('exit', (code) => {
            if (!this.shuttingDown && !slot.failed) {
                this.onWorkerFailure(slot, taskError(`path worker exited with code ${code}`, 'WORKER_EXIT'));
            }
        });
    }

    request(request, options = {}) {
        if (this.shuttingDown) return Promise.reject(taskError('path worker pool is shutting down', 'POOL_SHUTDOWN'));
        this.init();
        const key = options.key ? String(options.key) : null;
        const priority = Number(options.priority) || 0;
        if (key) this.cancel(key);
        if (this.queue.length >= this.queueLimit) {
            const victim = this.queue.reduce((lowest, queued) => (
                !lowest || queued.priority < lowest.priority ? queued : lowest
            ), null);
            if (!victim || victim.priority >= priority) {
                DiagnosticConfig.developerDiagnostics && (this.metrics.rejected += 1);
                return Promise.reject(taskError('path worker queue is full', 'QUEUE_FULL'));
            }
            this.queue.splice(this.queue.indexOf(victim), 1);
            DiagnosticConfig.developerDiagnostics && (this.metrics.preempted += 1);
            this.finishTask(victim, null, taskError('path request preempted by higher priority work', 'PATH_PREEMPTED'));
        }

        const id = this.nextId++;
        const timeoutMs = Math.max(100, Number(options.timeoutMs) || 2000);
        const task = {
            id,
            key,
            priority,
            request: { ...request },
            state: 'queued',
            cancelled: false,
            settled: false,
            timer: null,
            queuedAt: DiagnosticConfig.developerDiagnostics ? Date.now() : null,
            cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
            resolve: null,
            reject: null
        };
        const promise = new Promise((resolve, reject) => {
            task.resolve = resolve;
            task.reject = reject;
        });
        task.timer = setTimeout(() => this.cancelTask(task, 'path request timed out', 'PATH_TIMEOUT'), timeoutMs);
        task.timer.unref?.();
        this.tasks.set(id, task);
        if (key) this.latestByKey.set(key, id);
        this.queue.push(task);
        this.queue.sort((first, second) => second.priority - first.priority || first.id - second.id);
        DiagnosticConfig.developerDiagnostics && (this.metrics.queued += 1);
        DiagnosticConfig.developerDiagnostics && (this.metrics.maxQueue = Math.max(this.metrics.maxQueue, this.queue.length));
        this.dispatch();
        return promise;
    }

    cancel(key) {
        const normalized = String(key || '');
        const id = this.latestByKey.get(normalized);
        if (!id) return false;
        const task = this.tasks.get(id);
        if (!task) {
            this.latestByKey.delete(normalized);
            return false;
        }
        this.cancelTask(task, 'stale path request', 'STALE_PATH');
        return true;
    }

    cancelTask(task, message, code) {
        if (!task || task.cancelled) return;
        task.cancelled = true;
        Atomics.store(task.cancelFlag, 0, 1);
        DiagnosticConfig.developerDiagnostics && (this.metrics.stale += 1);
        if (task.state === 'queued') {
            const index = this.queue.indexOf(task);
            if (index >= 0) this.queue.splice(index, 1);
            this.finishTask(task, null, taskError(message, code));
        } else if (!task.settled) {
            task.settled = true;
            task.reject(taskError(message, code));
        }
    }

    dispatch() {
        if (this.shuttingDown) return;
        if (Date.now() - this.townWindowAt >= 1000) {
            this.townWindowAt = Date.now();
            this.townWorkMs = 0;
        }
        this.workers.forEach((slot) => {
            if (!slot || slot.task) return;
            const eligible = this.queue.findIndex((task) => !task.request.townCorridor || task.priority >= 100 || this.townWorkMs < 80);
            if (eligible < 0) {
                if (this.queue.length && !this.budgetTimer) {
                    DiagnosticConfig.developerDiagnostics && (this.metrics.budgetDeferrals++);
                    this.budgetTimer = setTimeout(() => {
                        this.budgetTimer = null;
                        this.dispatch();
                    }, Math.max(1, 1000 - (Date.now() - this.townWindowAt)));
                    this.budgetTimer.unref?.();
                }
                return;
            }
            let task = this.queue.splice(eligible, 1)[0];
            while (task?.cancelled) task = this.queue.shift();
            if (!task) return;
            task.state = 'running';
            slot.task = task;
            DiagnosticConfig.developerDiagnostics && (this.metrics.maxQueueWaitMs = Math.max(this.metrics.maxQueueWaitMs, Date.now() - task.queuedAt));
            slot.worker.postMessage({ type: 'path', id: task.id, request: task.request, cancelBuffer: task.cancelFlag.buffer });
        });
    }

    onMessage(slot, message) {
        const task = slot.task;
        if (!task || Number(message?.id) !== task.id) return;
        slot.task = null;
        if (message.v8Heap) slot.v8Heap = message.v8Heap;
        const workerMs = Math.max(0, Number(message.workerMs) || 0);
        DiagnosticConfig.developerDiagnostics && (this.metrics.workerMs += workerMs);
        if (task.request.townCorridor && task.priority < 100) this.townWorkMs += workerMs;
        if (!task.cancelled) {
            if (message.ok) {
                DiagnosticConfig.developerDiagnostics && (this.metrics.completed += 1);
                this.finishTask(task, message.path, null);
            } else {
                DiagnosticConfig.developerDiagnostics && (this.metrics.errors += 1);
                this.finishTask(task, null, taskError(message.error || 'path worker failed', message.code || 'PATH_WORKER_ERROR'));
            }
        } else {
            this.cleanupTask(task);
        }
        this.dispatch();
    }

    // A crashed slot respawns at once on its first crash in a row, then after
    // the shared worker backoff (1, 2, 5, 10, then every 30 s, forever). The
    // queue is kept while no slot is up: each task waits for a worker or its
    // own timeout (PATH_TIMEOUT); only the crashed slot's own task fails.
    onWorkerFailure(slot, error) {
        if (slot.failed) return;
        slot.failed = true;
        slot.worker?.terminate?.().catch?.(() => null);
        const failure = error instanceof Error ? error : taskError(String(error), 'PATH_WORKER_ERROR');
        const task = slot.task;
        slot.task = null;
        if (task) {
            DiagnosticConfig.developerDiagnostics && (this.metrics.errors += 1);
            this.finishTask(task, null, failure);
        }
        if (this.workers[slot.index] === slot) this.workers[slot.index] = null;
        if (this.shuttingDown) return;
        const index = slot.index;
        const restart = RestartBackoff.next(this.restartCrashes[index], slot.upSince || 0, Date.now(), RestartBackoff.AT_ONCE_FIRST_MS);
        this.restartCrashes[index] = restart.crashes;
        this.health.crashes += 1;
        this.logCrash(index, failure, restart);
        clearTimeout(this.restartTimers[index]);
        this.restartTimers[index] = setTimeout(() => {
            this.restartTimers[index] = null;
            if (this.shuttingDown) return;
            this.health.respawns += 1;
            this.spawn(index);
            this.dispatch();
        }, restart.delayMs);
        this.restartTimers[index].unref?.();
        this.dispatch();
    }

    logCrash(index, error, restart) {
        const reason = `${error.code || error.name || 'Error'}: ${error.message}`;
        const firstOfReason = !this.stackReasons.has(reason) && this.stackReasons.size < STACK_REASONS_MAX;
        if (firstOfReason) this.stackReasons.add(reason);
        utils.infoWarn('PathWorker', 'path worker %d crashed (%s); restarting in %dms, %d in a row, %d since start%s',
            index, reason, restart.delayMs, restart.crashes, this.health.crashes,
            firstOfReason && error.stack ? `\n${error.stack}` : '');
    }

    finishTask(task, value, error) {
        if (!task.settled) {
            task.settled = true;
            if (error) task.reject(error);
            else task.resolve(value);
        }
        this.cleanupTask(task);
    }

    cleanupTask(task) {
        clearTimeout(task.timer);
        this.tasks.delete(task.id);
        if (task.key && this.latestByKey.get(task.key) === task.id) this.latestByKey.delete(task.key);
    }

    stats() {
        const isCompanion = (task) => String(task?.key || '').startsWith('companion:');
        return {
            ...(DiagnosticConfig.developerDiagnostics ? this.metrics : { diagnosticsEnabled: false }),
            started: this.started,
            workers: this.workers.filter(Boolean).length,
            size: this.size,
            ...this.health,
            busy: this.workers.filter((slot) => !!slot?.task).length,
            queue: this.queue.length,
            companionBusy: this.workers.filter((slot) => isCompanion(slot?.task)).length,
            companionQueue: this.queue.filter(isCompanion).length,
            inFlight: this.tasks.size,
            // Each worker's heap as of its last path answer (WorkerHeapTelemetry.heapRecord).
            ...(DiagnosticConfig.developerDiagnostics ? { v8Heaps: this.workers.map(slot => slot?.v8Heap || null) } : {})
        };
    }

    shutdown() {
        if (this.shuttingDown) return Promise.resolve();
        this.shuttingDown = true;
        clearTimeout(this.budgetTimer);
        this.restartTimers.forEach((timer) => clearTimeout(timer));
        this.queue.splice(0).forEach((task) => this.finishTask(task, null, taskError('path worker pool shut down', 'POOL_SHUTDOWN')));
        this.workers.forEach((slot) => {
            if (slot?.task) {
                Atomics.store(slot.task.cancelFlag, 0, 1);
                this.finishTask(slot.task, null, taskError('path worker pool shut down', 'POOL_SHUTDOWN'));
            }
        });
        const terminations = this.workers.map((slot) => Promise.resolve(slot?.worker?.terminate?.()).catch(() => null));
        this.workers = [];
        return Promise.allSettled(terminations).then(() => undefined);
    }
}

const PathfindingWorkerPool = new BoundedPathfindingWorkerPool();
PathfindingWorkerPool.BoundedPathfindingWorkerPool = BoundedPathfindingWorkerPool;

module.exports = PathfindingWorkerPool;
