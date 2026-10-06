const { performance } = require('perf_hooks');
const { randomUUID } = require('crypto');
const Protocol = require('./ColdSimulationProtocol');
const { PAGE_BYTES } = require('./ColdMessagePages');
const INTERVAL_MS = 30 * 60000;

// One fixed native PK page and one request in flight. The existing Registry
// pulse services continuations and the transport's watchdog; no clock lives here.
class LifecycleSafetySweep {
    constructor(options = {}) {
        for (const key of ['readPage', 'readCurrent', 'cachedState', 'active', 'admit', 'complete', 'onError', 'now']) {
            if (typeof options[key] !== 'function') throw new TypeError(`lifecycle safety requires ${key}`);
        }
        for (const key of ['current', 'excluded', 'canRepair', 'projection', 'request', 'poll', 'cancel']) {
            if (typeof options.cold?.[key] !== 'function') throw new TypeError(`lifecycle safety requires cold.${key}`);
        }
        Object.assign(this, options);
        this.retryMs = Math.max(50, Number(options.retryMs) || 1000);
        this.budgetMs = Math.max(1, Number(options.budgetMs) || 12);
        this.running = false;
        this.generation = 0;
        this.inFlight = null;
        this.cycle = null;
        this.metrics = { completedCycles: 0, pages: 0, inspected: 0, deferred: 0,
            stateRepairAttempts: 0, boardRepairAttempts: 0, hotRepairAttempts: 0, errors: 0 };
    }

    start(registry) {
        if (this.running) return false;
        if (!registry?.started || typeof registry.subscribeTicks !== 'function' || !this.active()) return false;
        this.registry = registry;
        this.running = true;
        this.generation++;
        this.nextAt = this.now() + INTERVAL_MS;
        try {
            this.unsubscribe = registry.subscribeTicks(timestamp => this.pulse(timestamp));
        } catch (error) {
            this.running = false;
            this.generation++;
            throw error;
        }
        return true;
    }

    stop() {
        if (!this.running) return false;
        this.running = false;
        this.generation++;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.cold.cancel();
        this.cycle = null;
        return true;
    }

    current(cycle) {
        return this.running && this.active() && this.registry?.started
            && this.cycle === cycle && cycle.generation === this.generation;
    }

    workerCurrent(expected) {
        const actual = this.cold.current();
        return !!expected && actual?.ready === true && actual.worker === expected.worker && actual.epoch === expected.epoch;
    }

    eligible(row) {
        const checkpoint = Protocol.safetyCheckpoint(row);
        if (!checkpoint || !['cold', 'hot'].includes(checkpoint.phase)
            || checkpoint.simulationLeaseId || checkpoint.simulationLeaseUntil > this.now()
            || !['legacy_main', 'cold_worker'].includes(checkpoint.simulationOwner)) return null;
        const state = this.cachedState(checkpoint.characterId);
        if (!state || !Protocol.sameSafetyCheckpoint(checkpoint, Protocol.safetyCheckpoint(state))) return null;
        if (checkpoint.phase === 'cold' && this.cold.excluded(checkpoint.characterId)) return null;
        return checkpoint;
    }

    pulse(timestamp = this.now()) {
        if (!this.running) return;
        if (!this.active() || !this.registry?.started) { this.stop(); return; }
        this.cold.poll(timestamp);
        // A stopped generation may still be releasing an awaited SQL lease.
        // Its token also prevents a restarted generation overlapping that read.
        if (this.inFlight || this.cycle?.waiting || timestamp < (this.cycle?.retryAt || 0)) return;
        if (!this.cycle) {
            if (timestamp < this.nextAt) return;
            this.cycle = { generation: this.generation, startedAt: timestamp,
                cursor: { afterId: 0 }, phase: 'read', page: null, waiting: false, retryAt: 0, edgeIdentities: new Map() };
        }
        const lease = this.admit();
        if (!lease) return;
        const cycle = this.cycle;
        const started = performance.now();
        const token = {};
        this.inFlight = token;
        Promise.resolve().then(() => this.step(cycle, started + this.budgetMs)).catch(error => {
            if (this.current(cycle)) {
                this.metrics.errors++;
                cycle.retryAt = this.now() + this.retryMs;
                this.onError(error);
            }
        }).finally(() => {
            this.complete(lease, { durationMs: performance.now() - started });
            if (this.inFlight === token) this.inFlight = null;
        });
    }

    async step(cycle, deadline) {
        if (!this.current(cycle)) return;
        if (cycle.phase === 'read') {
            const page = await this.readPage({ ...cycle.cursor, limit: 64 });
            if (!this.current(cycle)) return;
            if (!Array.isArray(page?.rows) || page.rows.length > 64 || !page.cursor
                || typeof page.done !== 'boolean') throw new Error('invalid lifecycle safety page');
            cycle.page = page;
            cycle.phase = 'probe';
            this.metrics.pages++;
            this.metrics.inspected += page.rows.length;
            return;
        }
        if (cycle.phase === 'probe') {
            const rows = [];
            cycle.hotReceipts = [];
            for (const native of cycle.page.rows) {
                const checkpoint = this.eligible(native);
                if (!checkpoint) { this.metrics.deferred++; continue; }
                if (checkpoint.phase === 'hot') {
                    const receipt = this.hot?.probe(checkpoint);
                    if (receipt?.status === 'uncovered'
                        && Protocol.sameSafetyCheckpoint(checkpoint, receipt.checkpoint)) cycle.hotReceipts.push(receipt);
                } else rows.push(checkpoint);
            }
            cycle.coldRows = rows;
            cycle.hotIndex = 0;
            cycle.phase = 'hot';
            return;
        }
        if (cycle.phase === 'hot') {
            const receipt = cycle.hotReceipts[cycle.hotIndex];
            if (receipt) {
                if (!this.eligible(receipt.checkpoint)) { cycle.hotIndex++; return; }
                const native = await this.readCurrent(receipt.checkpoint);
                if (!this.current(cycle)) return;
                if (Protocol.sameSafetyCheckpoint(receipt.checkpoint, Protocol.safetyCheckpoint(native))
                    && this.eligible(receipt.checkpoint)) {
                    this.metrics.hotRepairAttempts++;
                    this.hot.repair(receipt);
                } else this.metrics.deferred++;
                cycle.hotIndex++;
                return;
            }
            const rows = cycle.coldRows;
            const worker = this.cold.current();
            if (!rows.length || worker?.ready !== true) { this.finishPage(cycle); return; }
            this.request(cycle, 'presence', rows, worker, reply => {
                cycle.results = new Map(reply.results.map(row => [row.characterId, row]));
                cycle.reviewIndex = 0;
                cycle.edges = [];
                cycle.repairIndex = 0;
                cycle.baseBytes = Protocol.byteLength(Protocol.envelope('worker_repair_request', worker.epoch, { rows: [] })) + 256;
                cycle.phase = 'review';
            });
            return;
        }
        if (cycle.phase === 'review') {
            if (!this.workerCurrent(cycle.worker)) { cycle.phase = 'probe'; return; }
            while (cycle.reviewIndex < cycle.page.rows.length && performance.now() < deadline) {
                const native = cycle.page.rows[cycle.reviewIndex++];
                const checkpoint = this.eligible(native);
                const receipt = checkpoint && cycle.results.get(checkpoint.characterId);
                if (!receipt || checkpoint.phase !== 'cold'
                    || !Protocol.sameSafetyCheckpoint(checkpoint, receipt.checkpoint)
                    || !Number.isSafeInteger(receipt.workerVersion) || receipt.workerVersion < 0) continue;
                if (receipt.normal?.status === 'uncovered' && receipt.normal.reason === 'missing_state') {
                    if (!this.cold.canRepair(checkpoint)) { this.metrics.deferred++; continue; }
                    const projected = this.cold.projection(checkpoint.characterId, checkpoint);
                    if (!projected?.entry) { this.metrics.deferred++; continue; }
                    this.appendEdge(cycle, { edgeId: this.edgeIdentity(cycle, 'state', checkpoint, receipt), kind: 'state', checkpoint,
                        expectedWorkerVersion: receipt.workerVersion, entry: projected.entry });
                } else if (receipt.normal?.status === 'covered' && receipt.board?.status === 'uncovered'
                    && Number.isSafeInteger(receipt.board.coverageVersion) && receipt.board.coverageVersion >= 0) {
                    if (!this.cold.canRepair(checkpoint)) { this.metrics.deferred++; continue; }
                    this.appendEdge(cycle, { edgeId: this.edgeIdentity(cycle, 'board', checkpoint, receipt), kind: 'board', checkpoint,
                        expectedWorkerVersion: receipt.workerVersion,
                        expectedBoardCoverageVersion: receipt.board.coverageVersion });
                }
            }
            if (cycle.reviewIndex === cycle.page.rows.length) cycle.phase = 'repair';
            return;
        }
        if (cycle.phase === 'repair') {
            if (!this.workerCurrent(cycle.worker)) { cycle.phase = 'probe'; return; }
            // Inputs may have changed between the presence response, sparse
            // projection and the next pulse. Recheck before actual dispatch.
            const edge = cycle.edges[cycle.repairIndex];
            if (!edge) { this.finishPage(cycle); return; }
            if (!this.edgeCurrent(edge)) { cycle.repairIndex++; return; }
            // Only an uncovered edge pays for this indexed scalar native read.
            // Repair one edge per request, so no earlier row waits while later
            // native reads let its durable-before-cache authority drift.
            const native = await this.readCurrent(edge.checkpoint);
            if (!this.current(cycle) || !this.workerCurrent(cycle.worker)) return;
            if (!Protocol.sameSafetyCheckpoint(edge.checkpoint, Protocol.safetyCheckpoint(native)) || !this.edgeCurrent(edge)) {
                this.metrics.deferred++;
                cycle.repairIndex++;
                return;
            }
            this.metrics[edge.kind === 'state' ? 'stateRepairAttempts' : 'boardRepairAttempts']++;
            this.request(cycle, 'repair', [edge], cycle.worker, () => { cycle.repairIndex++; });
        }
    }

    edgeCurrent(edge) {
        return !!this.eligible(edge.checkpoint) && this.cold.canRepair(edge.checkpoint)
            && (edge.kind !== 'state' || this.cold.projection(edge.checkpoint.characterId, edge.checkpoint)?.entry === edge.entry);
    }

    edgeIdentity(cycle, kind, checkpoint, receipt) {
        const previous = cycle.edgeIdentities.get(checkpoint.characterId);
        const boardVersion = kind === 'board' ? receipt.board.coverageVersion : null;
        if (previous?.kind === kind && previous.epoch === cycle.worker.epoch
            && previous.workerVersion === receipt.workerVersion && previous.boardVersion === boardVersion
            && Protocol.sameSafetyCheckpoint(previous.checkpoint, checkpoint)) return previous.id;
        const identity = { id: randomUUID(), kind, checkpoint, epoch: cycle.worker.epoch,
            workerVersion: receipt.workerVersion, boardVersion };
        cycle.edgeIdentities.set(checkpoint.characterId, identity);
        return identity.id;
    }

    appendEdge(cycle, edge) {
        // Count each own full projection once while the review loop can yield.
        // An oversized entry is deferred intact, never replaced by context{}.
        const size = Protocol.byteLength([edge]) - 2;
        if (!Number.isFinite(size) || cycle.baseBytes + size > PAGE_BYTES) { this.metrics.deferred++; return; }
        cycle.edges.push(edge);
    }

    request(cycle, kind, rows, worker, accepted) {
        cycle.worker = worker;
        cycle.waiting = true;
        // Governor admission covers the bounded local work and send, not time
        // waiting for another thread. The next pulse handles the response.
        let requested;
        try {
            // Posting is synchronous within this admitted slice, immediately
            // after the final native read. Only the receipt wait is asynchronous.
            requested = this.current(cycle) && this.workerCurrent(worker)
                ? this.cold.request(kind, rows, worker) : { ok: false, results: [] };
        } catch (error) { requested = Promise.reject(error); }
        Promise.resolve(requested).then(reply => {
            if (!this.current(cycle)) return;
            if (!this.workerCurrent(worker) || !reply?.ok) {
                cycle.phase = 'probe';
                cycle.retryAt = this.now() + this.retryMs;
                return;
            }
            accepted(reply);
        }).catch(error => {
            if (!this.current(cycle)) return;
            cycle.phase = 'probe';
            cycle.retryAt = this.now() + this.retryMs;
            this.metrics.errors++;
            this.onError(error);
        }).finally(() => {
            if (this.current(cycle)) cycle.waiting = false;
        });
    }

    finishPage(cycle) {
        if (!this.current(cycle)) return;
        cycle.cursor = { ...cycle.page.cursor };
        if (cycle.page.done) {
            this.metrics.completedCycles++;
            this.nextAt = cycle.startedAt + INTERVAL_MS;
            this.cycle = null;
        } else {
            cycle.phase = 'read';
            cycle.page = null;
            cycle.results = null;
            cycle.edges = null;
            cycle.edgeIdentities.clear();
        }
    }

    snapshot() {
        return { running: this.running, nextAt: this.nextAt,
            cursor: this.cycle ? { ...this.cycle.cursor } : null,
            phase: this.cycle?.phase || null, waiting: this.cycle?.waiting || false, ...this.metrics };
    }
}

module.exports = { LifecycleSafetySweep, INTERVAL_MS };
