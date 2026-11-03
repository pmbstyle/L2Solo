'use strict';

const path = require('path');

// The threads of this process the live recorder measures: main, and every worker main creates
// (process "worker" event), each named by what the inspector shows for it (the worker's `name`,
// else its file). Main reaches a worker's profiler through the Worker object, so the worker has
// no code and no protocol message for it, and a restarted worker comes back as a new thread.
// Must start before the first worker: an earlier one is not seen.
class Threads {
    constructor() {
        this.threads = new Map();
        this.labels = new Map();
        this.workers = new Map();
        this.session = null;
    }

    start({ onReady, onExit } = {}) {
        this.onReady = onReady || (() => {});
        this.onExit = onExit || (() => {});
        this.onWorker = (worker) => {
            this.workers.set(worker.threadId, worker);
            this.ready(worker.threadId);
        };
        process.on('worker', this.onWorker);
        const inspector = require('node:inspector');
        this.session = new inspector.Session();
        this.session.connect();
        // The inspector's detach is the exit signal: the Worker's own "exit" listener added from
        // the process "worker" event did not fire on terminate() (Node 24.15).
        this.sessions = new Map();
        this.session.on('NodeWorker.attachedToWorker', ({ params }) => {
            const id = Number(params.workerInfo.workerId);
            this.sessions.set(params.sessionId, id);
            this.labels.set(id, this.labelOf(params.workerInfo));
            this.ready(id);
        });
        this.session.on('NodeWorker.detachedFromWorker', ({ params }) => {
            const id = this.sessions.get(params.sessionId);
            this.sessions.delete(params.sessionId);
            if (id !== undefined) this.exited(id);
        });
        this.session.post('NodeWorker.enable', { waitForDebuggerOnStart: false });
        this.add({ threadId: 0, label: 'main', worker: null });
    }

    stop() {
        if (this.onWorker) process.off('worker', this.onWorker);
        this.session?.disconnect();
        this.session = null;
        this.threads.clear();
        this.workers.clear();
        this.labels.clear();
        this.sessions?.clear();
    }

    all() {
        return [...this.threads.values()];
    }

    // Several path workers share one file: a repeated label gets the thread id.
    labelOf(info) {
        const named = String(info.title || '').replace(/^\[worker \d+\]\s*/, '');
        const base = named && named !== 'WorkerThread' ? named : path.basename(String(info.url || 'worker'), '.js');
        const taken = [...this.labels.values(), ...this.all().map(thread => thread.label)];
        return taken.includes(base) ? `${base}#${info.workerId}` : base;
    }

    // A worker is ready when both its object and its name are known; they come in either order.
    ready(id) {
        if (this.threads.has(id) || !this.workers.has(id) || !this.labels.has(id)) return;
        this.add({ threadId: id, label: this.labels.get(id), worker: this.workers.get(id) });
    }

    add(thread) {
        this.threads.set(thread.threadId, thread);
        this.onReady(thread);
    }

    exited(id) {
        const thread = this.threads.get(id);
        this.threads.delete(id);
        this.workers.delete(id);
        this.labels.delete(id);
        if (thread) this.onExit(thread);
    }
}

module.exports = Threads;
