const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

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
        this.workerFactory = options.workerFactory || ((workerPath) => new Worker(workerPath));
        this.restartLimit = Math.max(0, Number(options.restartLimit) || 3);
        this.workers = [];
        this.restartAttempts = [];
        this.queue = [];
        this.tasks = new Map();
        this.latestByKey = new Map();
        this.nextId = 1;
        this.started = false;
        this.shuttingDown = false;
        this.unavailable = false;
        this.metrics = {
            queued: 0,
            completed: 0,
            stale: 0,
            preempted: 0,
            errors: 0,
            rejected: 0,
            maxQueue: 0
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
        const slot = { index, worker, task: null };
        this.workers[index] = slot;
        this.unavailable = false;
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
        if (this.unavailable) return Promise.reject(taskError('path worker pool is unavailable', 'WORKER_UNAVAILABLE'));
        this.init();
        const key = options.key ? String(options.key) : null;
        const priority = Number(options.priority) || 0;
        if (key) this.cancel(key);
        if (this.queue.length >= this.queueLimit) {
            const victim = this.queue.reduce((lowest, queued) => (
                !lowest || queued.priority < lowest.priority ? queued : lowest
            ), null);
            if (!victim || victim.priority >= priority) {
                this.metrics.rejected += 1;
                return Promise.reject(taskError('path worker queue is full', 'QUEUE_FULL'));
            }
            this.queue.splice(this.queue.indexOf(victim), 1);
            this.metrics.preempted += 1;
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
        this.metrics.queued += 1;
        this.metrics.maxQueue = Math.max(this.metrics.maxQueue, this.queue.length);
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
        this.metrics.stale += 1;
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
        this.workers.forEach((slot) => {
            if (!slot || slot.task) return;
            let task = this.queue.shift();
            while (task?.cancelled) task = this.queue.shift();
            if (!task) return;
            task.state = 'running';
            slot.task = task;
            slot.worker.postMessage({ type: 'path', id: task.id, request: task.request });
        });
    }

    onMessage(slot, message) {
        const task = slot.task;
        if (!task || Number(message?.id) !== task.id) return;
        slot.task = null;
        if (!task.cancelled) {
            if (message.ok) {
                this.restartAttempts[slot.index] = 0;
                this.metrics.completed += 1;
                this.finishTask(task, message.path, null);
            } else {
                this.metrics.errors += 1;
                this.finishTask(task, null, taskError(message.error || 'path worker failed', 'PATH_WORKER_ERROR'));
            }
        } else {
            this.cleanupTask(task);
        }
        this.dispatch();
    }

    onWorkerFailure(slot, error) {
        if (slot.failed) return;
        slot.failed = true;
        slot.worker?.terminate?.().catch?.(() => null);
        const task = slot.task;
        slot.task = null;
        if (task) {
            this.metrics.errors += 1;
            this.finishTask(task, null, error instanceof Error ? error : taskError(String(error), 'PATH_WORKER_ERROR'));
        }
        const attempts = Number(this.restartAttempts[slot.index] || 0) + 1;
        this.restartAttempts[slot.index] = attempts;
        if (!this.shuttingDown && attempts <= this.restartLimit) {
            this.spawn(slot.index);
        } else {
            this.workers[slot.index] = null;
            if (!this.shuttingDown && this.workers.every((workerSlot) => !workerSlot)) {
                this.unavailable = true;
                this.queue.splice(0).forEach((queued) => {
                    this.metrics.errors += 1;
                    this.finishTask(queued, null, taskError('path worker pool is unavailable', 'WORKER_UNAVAILABLE'));
                });
            }
        }
        this.dispatch();
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
        return {
            ...this.metrics,
            workers: this.workers.filter(Boolean).length,
            busy: this.workers.filter((slot) => !!slot?.task).length,
            queue: this.queue.length,
            inFlight: this.tasks.size
        };
    }

    shutdown() {
        if (this.shuttingDown) return Promise.resolve();
        this.shuttingDown = true;
        this.unavailable = true;
        this.queue.splice(0).forEach((task) => this.finishTask(task, null, taskError('path worker pool shut down', 'POOL_SHUTDOWN')));
        this.workers.forEach((slot) => {
            if (slot?.task) this.finishTask(slot.task, null, taskError('path worker pool shut down', 'POOL_SHUTDOWN'));
        });
        const terminations = this.workers.map((slot) => Promise.resolve(slot?.worker?.terminate?.()).catch(() => null));
        this.workers = [];
        return Promise.allSettled(terminations).then(() => undefined);
    }
}

const PathfindingWorkerPool = new BoundedPathfindingWorkerPool();
PathfindingWorkerPool.BoundedPathfindingWorkerPool = BoundedPathfindingWorkerPool;

module.exports = PathfindingWorkerPool;
