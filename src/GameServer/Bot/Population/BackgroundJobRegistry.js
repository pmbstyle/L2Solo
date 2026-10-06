let activeRegistry = null;

function finiteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

class Registry {
    constructor(options = {}) {
        this.tickMs = Math.max(50, Math.floor(finiteNumber(options.tickMs, 250)));
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.setInterval = typeof options.setInterval === 'function' ? options.setInterval : global.setInterval;
        this.clearInterval = typeof options.clearInterval === 'function' ? options.clearInterval : global.clearInterval;
        this.onError = typeof options.onError === 'function' ? options.onError : () => {};
        this.jobs = new Map();
        this.tickSubscribers = new Set();
        this.timer = null;
        this.started = false;
        this.startedAt = 0;
        this.deadlines = null;
        this.deadlineTokens = new Map();
        this.metrics = { ticks: 0, due: 0, started: 0, completed: 0, skipped: 0, deferred: 0, coalesced: 0, errors: 0 };
    }

    register(options = {}) {
        if (this.started) throw new Error('background job registry is already started');
        const name = String(options.name || '').trim();
        if (!name) throw new Error('background job name is required');
        if (this.jobs.has(name)) throw new Error(`background job already registered: ${name}`);
        if (typeof options.run !== 'function') throw new Error(`background job run callback is required: ${name}`);
        const intervalMs = Math.max(this.tickMs, Math.floor(finiteNumber(options.intervalMs, this.tickMs)));
        // The initial phase may be longer than the recurring interval. This is
        // useful for fast continuation polling without moving startup work
        // back into the bootstrap burst.
        const offsetMs = Math.max(0, Math.floor(finiteNumber(options.offsetMs, 0)));
        this.jobs.set(name, {
            name,
            intervalMs,
            offsetMs,
            run: options.run,
            nextDueAt: 0,
            inFlight: false,
            promise: null,
            due: 0,
            started: 0,
            completed: 0,
            skipped: 0,
            deferred: 0,
            coalesced: 0,
            errors: 0,
            lastStartedAt: 0,
            lastCompletedAt: 0
        });
        return this;
    }

    start(startedAt = this.now()) {
        if (this.started) return this;
        this.started = true;
        this.startedAt = Math.floor(finiteNumber(startedAt, this.now()));
        for (const job of this.jobs.values()) job.nextDueAt = this.startedAt + job.offsetMs;
        this.tick(this.startedAt);
        if (!this.started) return this;
        this.timer = this.setInterval(() => this.tick(), this.tickMs);
        if (typeof this.timer?.unref === 'function') this.timer.unref();
        return this;
    }

    stop() {
        if (this.timer) this.clearInterval(this.timer);
        this.timer = null;
        this.started = false;
        this.deadlineTokens.clear();
        this.deadlines = null;
    }

    armDeadline(key, dueAt, callback) {
        if (!Number.isSafeInteger(dueAt) || dueAt < 0 || typeof callback !== 'function') {
            throw new TypeError('invalid_background_deadline');
        }
        this.cancelDeadline(key);
        this.deadlines ||= new (require('./ColdSimulationKernel').DueHeap)();
        const token = { key, dueAt, callback };
        this.deadlineTokens.set(key, token);
        this.deadlines.push(token);
        return token;
    }

    cancelDeadline(key, expected = null) {
        const token = this.deadlineTokens.get(key);
        if (!token || expected && token !== expected) return false;
        this.deadlineTokens.delete(key);
        this.deadlines.remove(token);
        return true;
    }

    subscribeTicks(listener) {
        if (typeof listener !== 'function') throw new TypeError('background tick listener is required');
        this.tickSubscribers.add(listener);
        return () => this.tickSubscribers.delete(listener);
    }

    tick(timestamp = this.now()) {
        if (!this.started) return;
        const now = Math.floor(finiteNumber(timestamp, this.now()));
        this.metrics.ticks += 1;
        // Every Main deadline consumer shares this heap and the existing clock.
        for (let inspected = 0; inspected < 64 && this.started; inspected++) {
            const token = this.deadlines?.peek();
            if (!token || token.dueAt > now) break;
            this.deadlines.pop();
            if (this.deadlineTokens.get(token.key) !== token) continue;
            this.deadlineTokens.delete(token.key);
            try { token.callback(now); }
            catch (error) { this.metrics.errors++; this.onError('deadline', error); }
        }
        for (const job of this.jobs.values()) {
            if (now < job.nextDueAt) continue;
            const dueCount = Math.floor((now - job.nextDueAt) / job.intervalMs) + 1;
            job.nextDueAt += dueCount * job.intervalMs;
            job.due += dueCount;
            this.metrics.due += dueCount;
            if (job.inFlight) {
                job.deferred += dueCount;
                this.metrics.deferred += dueCount;
                continue;
            }
            if (dueCount > 1) {
                job.coalesced += dueCount - 1;
                this.metrics.coalesced += dueCount - 1;
            }
            job.inFlight = true;
            job.started += 1;
            job.lastStartedAt = now;
            this.metrics.started += 1;
            job.promise = Promise.resolve()
                .then(() => job.run())
                .then((result) => {
                    job.completed += 1;
                    this.metrics.completed += 1;
                    if (result?.skipped === true) {
                        job.skipped += 1;
                        this.metrics.skipped += 1;
                    }
                    return result;
                })
                .catch((error) => {
                    job.errors += 1;
                    this.metrics.errors += 1;
                    this.onError(job.name, error);
                    return null;
                })
                .finally(() => {
                    job.inFlight = false;
                    job.promise = null;
                    job.lastCompletedAt = this.now();
                });
        }
        // Continuations only request cooperative work. They share this
        // existing clock even when no ordinary job is due.
        for (const listener of [...this.tickSubscribers]) {
            if (!this.started) break;
            if (!this.tickSubscribers.has(listener)) continue;
            try { listener(now); } catch (error) {
                this.metrics.errors += 1;
                this.onError('tick_subscriber', error);
            }
        }
    }

    snapshot() {
        const jobs = Object.fromEntries([...this.jobs.entries()].map(([name, job]) => [name, {
            intervalMs: job.intervalMs,
            offsetMs: job.offsetMs,
            nextDueAt: job.nextDueAt,
            inFlight: job.inFlight,
            due: job.due,
            started: job.started,
            completed: job.completed,
            skipped: job.skipped,
            deferred: job.deferred,
            coalesced: job.coalesced,
            errors: job.errors,
            lastStartedAt: job.lastStartedAt,
            lastCompletedAt: job.lastCompletedAt
        }]));
        return {
            running: this.started,
            startedAt: this.startedAt,
            tickMs: this.tickMs,
            registered: this.jobs.size,
            inFlight: Object.values(jobs).filter((job) => job.inFlight).length,
            ...this.metrics,
            jobs
        };
    }
}

function create(options = {}) {
    activeRegistry = new Registry(options);
    return activeRegistry;
}

function snapshot() {
    return activeRegistry?.snapshot() || {
        running: false, startedAt: 0, tickMs: 0, registered: 0, inFlight: 0,
        ticks: 0, due: 0, started: 0, completed: 0, skipped: 0,
        deferred: 0, coalesced: 0, errors: 0, jobs: {}
    };
}

module.exports = { create, snapshot };
