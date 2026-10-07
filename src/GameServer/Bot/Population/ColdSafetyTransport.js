'use strict';
const { randomUUID } = require('crypto');
const Protocol = require('./ColdSimulationProtocol');

const TYPES = { presence: 'worker_presence_request', repair: 'worker_repair_request' };
const COVERAGE_STATUSES = new Set(['covered', 'deferred', 'ineligible', 'uncovered']);
const REPAIR_STATUSES = new Set(['accepted', 'covered', 'deferred', 'stale', 'ineligible']);
const refused = reason => ({ ok: false, results: [], reason });
const version = value => Number.isSafeInteger(value) && value >= 0;

// One bounded request on the captured Worker attachment. The existing
// registry pulse owns its deadline; this adapter never creates a clock.
class ColdSafetyTransport {
    constructor({ worker, epoch, post, isCurrent, onTotals, now, timeoutMs } = {}) {
        if (!worker || typeof worker.on !== 'function'
            || (typeof worker.off !== 'function' && typeof worker.removeListener !== 'function')) {
            throw new TypeError('invalid_safety_worker');
        }
        if (typeof epoch !== 'string' || !epoch || epoch.length > 160) throw new TypeError('invalid_safety_epoch');
        for (const provider of [post, isCurrent, onTotals, now]) {
            if (typeof provider !== 'function') throw new TypeError('invalid_safety_provider');
        }
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('invalid_safety_timeout');
        this.worker = worker;
        this.epoch = epoch;
        this.post = post;
        this.isCurrent = isCurrent;
        this.onTotals = onTotals;
        this.now = now;
        this.timeoutMs = timeoutMs;
        this.requestPrefix = `safety:${randomUUID()}`;
        this.sequence = 0;
        this.pending = null;
        this.disposed = false;
        this.listener = message => this.accept(message);
        this.removeListener = (worker.off || worker.removeListener).bind(worker);
        worker.on('message', this.listener);
    }

    current() {
        if (this.disposed) return false;
        try { return this.isCurrent(this.worker, this.epoch) === true; }
        catch (_) { return false; }
    }

    finish(pending, result) {
        if (this.pending !== pending) return false;
        this.pending = null;
        pending.resolve(result);
        return true;
    }

    request(kind, rows) {
        if (this.disposed) return Promise.resolve(refused('disposed'));
        if (!this.current()) {
            if (this.pending) this.finish(this.pending, refused('stale'));
            return Promise.resolve(refused('stale'));
        }
        if (this.pending) return Promise.resolve(refused('busy'));
        if (!Object.hasOwn(TYPES, kind) || !Array.isArray(rows) || rows.length > Protocol.MAX_BATCH) {
            return Promise.resolve(refused('invalid_request'));
        }
        const msgId = `${this.requestPrefix}:${++this.sequence}`;
        const message = Protocol.envelope(TYPES[kind], this.epoch, { rows }, msgId);
        const valid = Protocol.validateEnvelope(message, 'main', { workerEpoch: this.epoch });
        if (!valid.ok) return Promise.resolve(refused(valid.reason));
        const expected = new Map();
        for (const row of rows) {
            const checkpoint = kind === 'presence' ? row : row?.checkpoint;
            const id = checkpoint?.characterId;
            if (!Number.isSafeInteger(id) || id <= 0 || expected.has(id)) return Promise.resolve(refused('invalid_rows'));
            expected.set(id, { checkpoint: { ...checkpoint }, edgeId: row.edgeId, kind: row.kind });
        }
        let timestamp;
        try { timestamp = this.now(); }
        catch (_) { return Promise.resolve(refused('invalid_clock')); }
        const deadline = timestamp + this.timeoutMs;
        if (!Number.isFinite(timestamp) || !Number.isFinite(deadline)) return Promise.resolve(refused('invalid_clock'));
        return new Promise(resolve => {
            const pending = { kind, msgId, expected, deadline, resolve };
            this.pending = pending;
            try {
                const posted = this.post(message.type, message.payload, msgId);
                if (posted !== msgId && posted !== true) this.finish(pending, refused('post_failed'));
            } catch (_) { this.finish(pending, refused('post_failed')); }
        });
    }

    exactResults(pending, results) {
        if (!Array.isArray(results) || results.length !== pending.expected.size || results.length > Protocol.MAX_BATCH) return false;
        const seen = new Set();
        for (const result of results) {
            const requested = pending.expected.get(result?.characterId);
            if (!requested || seen.has(result.characterId)
                || !version(result.workerVersion)
                || !Protocol.sameSafetyCheckpoint(requested.checkpoint, result.checkpoint)
                || (result.observedCheckpoint !== null && !Protocol.safetyCheckpoint(result.observedCheckpoint))) return false;
            if (pending.kind === 'presence') {
                if (!COVERAGE_STATUSES.has(result.normal?.status) || typeof result.normal.reason !== 'string') return false;
            } else if (result.edgeId !== requested.edgeId || result.kind !== requested.kind
                || !REPAIR_STATUSES.has(result.status) || typeof result.reason !== 'string') return false;
            seen.add(result.characterId);
        }
        return true;
    }

    accept(message) {
        const pending = this.pending;
        if (!pending) return;
        if (!this.current()) { this.finish(pending, refused('stale')); return; }
        if (message?.workerEpoch !== this.epoch || message.msgId !== pending.msgId
            || message.type !== TYPES[pending.kind].replace('_request', '_ack')) return;
        let timestamp;
        try { timestamp = this.now(); }
        catch (_) { this.finish(pending, refused('invalid_clock')); return; }
        if (!Number.isFinite(timestamp)) { this.finish(pending, refused('invalid_clock')); return; }
        if (timestamp >= pending.deadline) { this.finish(pending, refused('timeout')); return; }
        try {
            const valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: this.epoch });
            if (!valid.ok || !this.exactResults(pending, message.payload.results)) {
                this.finish(pending, refused('invalid_ack'));
                return;
            }
            const totals = message.payload.safety;
            if (!totals || typeof totals !== 'object' || Array.isArray(totals)
                || !['stateRepairs', 'coverageRepairs', 'orphanRepairs']
                .every(key => Number.isSafeInteger(totals[key]) && totals[key] >= 0)) {
                this.finish(pending, refused('invalid_ack'));
                return;
            }
            this.onTotals(this.epoch, totals);
        } catch (_) { this.finish(pending, refused('invalid_ack')); return; }
        this.finish(pending, { ok: true, results: message.payload.results });
    }

    pulse(timestamp) {
        if (!this.pending) return false;
        if (!this.current()) return this.finish(this.pending, refused('stale'));
        if (Number.isFinite(timestamp) && timestamp >= this.pending.deadline) return this.finish(this.pending, refused('timeout'));
        return false;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.pending) this.finish(this.pending, refused('disposed'));
        this.removeListener('message', this.listener);
    }
}

module.exports = ColdSafetyTransport;
