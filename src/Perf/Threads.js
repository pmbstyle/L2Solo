'use strict';

const path = require('path');
const { performance } = require('perf_hooks');

// The threads of this process the live recorder measures: main, and every worker main creates
// (process "worker" event), each named by what the inspector shows for it (the worker's `name`,
// else its file). Main reaches a worker's profilers through the Worker object (CPU) and through one
// in-process inspector session (NodeWorker domain: the heap sampler, read without stopping), so
// the worker has no code and no protocol message for it, and a restarted worker comes back as a
// new thread. Must start before the first worker: an earlier one is not seen.
class Threads {
    constructor() {
        this.threads = new Map();
        this.labels = new Map();
        this.workers = new Map();
        this.sessions = new Map();
        this.sessionOf = new Map();
        this.pending = new Map();
        this.nextId = 0;
        this.session = null;
        // Main-thread time spent here: parsing worker replies and main's own inspector calls (the
        // in-process session runs them synchronously). The recorder reports it as its cost.
        this.syncMs = 0;
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
        // The thread id is the N of the title's "[worker N]": workerInfo.workerId counts attaches and
        // differs from Worker#threadId when workers start together (seen: 2 named the third worker).
        this.session.on('NodeWorker.attachedToWorker', ({ params }) => {
            const id = Number(/^\[worker (\d+)\]/.exec(params.workerInfo.title || '')?.[1]);
            if (!Number.isInteger(id)) {
                utils.infoWarn('Perf', 'worker %s not measured: its inspector title %j has no "[worker N]"',
                    params.workerInfo.url, params.workerInfo.title);
                return;
            }
            this.sessions.set(params.sessionId, id);
            this.sessionOf.set(id, params.sessionId);
            this.labels.set(id, this.labelOf(params.workerInfo, id));
            this.ready(id);
        });
        this.session.on('NodeWorker.detachedFromWorker', ({ params }) => {
            const id = this.sessions.get(params.sessionId);
            this.sessions.delete(params.sessionId);
            if (id !== undefined) this.exited(id);
        });
        this.session.on('NodeWorker.receivedMessageFromWorker', ({ params }) => this.received(params.message));
        this.session.post('NodeWorker.enable', { waitForDebuggerOnStart: false });
        this.add({ threadId: 0, label: 'main', worker: null });
    }

    stop() {
        if (this.onWorker) process.off('worker', this.onWorker);
        this.session?.disconnect();
        this.session = null;
        for (const waiter of this.pending.values()) waiter.reject(new Error('inspector stopped'));
        for (const map of [this.threads, this.workers, this.labels, this.sessions, this.sessionOf, this.pending]) map.clear();
    }

    all() {
        return [...this.threads.values()];
    }

    // Several path workers share one file: a repeated label gets the thread id.
    labelOf(info, id) {
        const named = String(info.title || '').replace(/^\[worker \d+\]\s*/, '');
        const base = named && named !== 'WorkerThread' ? named : path.basename(String(info.url || 'worker'), '.js');
        const taken = [...this.labels.values(), ...this.all().map(thread => thread.label)];
        return taken.includes(base) ? `${base}#${id}` : base;
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
        const thread = this.threads.get(id), session = this.sessionOf.get(id);
        this.threads.delete(id);
        this.workers.delete(id);
        this.labels.delete(id);
        this.sessionOf.delete(id);
        for (const [key, waiter] of this.pending) {
            if (waiter.session !== session) continue;
            this.pending.delete(key);
            waiter.reject(new Error(`thread ${thread?.label || id} exited`));
        }
        if (thread) this.onExit(thread);
    }

    // An inspector command on a thread: main's own session, or the worker's through NodeWorker.
    post(thread, method, params = {}) {
        if (!this.session) return Promise.reject(new Error('inspector stopped'));
        if (!thread.worker) {
            return new Promise((resolve, reject) => {
                const began = performance.now();
                this.session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
                this.syncMs += performance.now() - began;
            });
        }
        const session = this.sessionOf.get(thread.threadId);
        if (!session) return Promise.reject(new Error(`no inspector session for ${thread.label}`));
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            this.pending.set(id, { resolve, reject, session });
            this.session.post('NodeWorker.sendMessageToWorker',
                { sessionId: session, message: JSON.stringify({ id, method, params }) }, (error) => {
                    if (!error || !this.pending.delete(id)) return;
                    reject(error);
                });
        });
    }

    // A worker's reply arrives as text and is parsed on main (a heap profile is a few MB).
    received(message) {
        const began = performance.now();
        const reply = JSON.parse(message);
        this.syncMs += performance.now() - began;
        const waiter = reply.id === undefined ? null : this.pending.get(reply.id);
        if (!waiter) return;
        this.pending.delete(reply.id);
        if (reply.error) waiter.reject(new Error(reply.error.message));
        else waiter.resolve(reply.result);
    }
}

module.exports = Threads;
