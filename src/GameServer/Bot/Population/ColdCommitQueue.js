const DiagnosticConfig = require('./PopulationConfig');
const FailureLog = require('../../../FailureLog');
const Protocol = require('./ColdSimulationProtocol');
const InventorySummary = require('./InventorySummary');
const { MAX_BATCH: MAX_MEMORY_EVENTS } = require('../../Social/InteractionMemoryPolicy');

// The queue used to poll every 25 ms. It now sleeps until an entry is due, but
// wakes only on that same 25 ms grid, so entries that fall due between two
// ticks are still taken together in one batch (the commit batching is kept).
const TICK_MS = 25;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, ratio = 0.95) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function pushSample(samples, durationMs) {
    samples.push(Math.max(0, Number(durationMs) || 0));
    if (samples.length > 256) samples.shift();
}

// An early calculation keeps its social episode's original clock. Invalid
// event clocks still reach SQL validation instead of parking work forever.
function memoryReadyAt(proposal) {
    const events = proposal.result?.memoryEvents;
    if (!Array.isArray(events)) return 0;
    let at = 0;
    for (const event of events) {
        if (!Number.isSafeInteger(event?.at) || event.at < 0) return 0;
        at = Math.max(at, event.at);
    }
    return at;
}

const groupReadyAt = group => group.reduce((at, entry) => Math.max(at, entry.memoryReadyAt), 0);

function stampEventWait(group) {
    const queuedAt = group.reduce((at, entry) => Math.max(at, entry.queuedAt), 0);
    const eventWaitMs = Math.max(0, groupReadyAt(group) - queuedAt);
    for (const entry of group) entry.eventWaitMs = eventWaitMs;
}

class ColdCommitQueue {
    constructor(options = {}) {
        if (typeof options.prepare !== 'function') throw new Error('prepare callback is required');
        if (typeof options.commit !== 'function') throw new Error('commit callback is required');
        this.prepare = options.prepare;
        this.commit = options.commit;
        this.afterCommit = options.afterCommit || (async () => {});
        this.onResults = options.onResults || (() => {});
        this.onPause = options.onPause || (() => {});
        this.onResume = options.onResume || (() => {});
        // The governor's lease for a full-window commit (null: not now) and its charge.
        this.admitWindowFlush = options.admitWindowFlush || (() => null);
        this.completeWindowFlush = options.completeWindowFlush || (() => {});
        this.capacityPressure = false;
        this.now = options.now || Date.now;
        this.targetMs = Math.max(100, Number(options.targetMs) || 2000);
        this.hardMs = Math.max(this.targetMs, Number(options.hardMs) || 5000);
        this.p1TargetMs = Math.max(10, Number(options.p1TargetMs) || 100);
        this.overdueMs = Math.max(100, Number(options.overdueMs) || 500);
        this.maxRows = Math.max(1, Math.min(32, Number(options.maxRows) || 32));
        this.maxEntries = Math.max(4, Number(options.maxEntries) || 1024);
        this.maxBytes = Math.max(256 * 1024, Number(options.maxBytes) || 4 * 1024 * 1024);
        this.highWater = Math.max(1, Math.floor(this.maxEntries * 0.75));
        this.lowWater = Math.max(0, Math.floor(this.maxEntries * 0.5));
        this.p0 = [];
        this.p1 = [];
        this.p2 = new Map();
        this.bytes = 0;
        this.timer = null;
        this.timerFireAt = 0;
        this.gridOrigin = 0;
        this.started = false;
        this.flushing = false;
        this.stopping = false;
        this.paused = false;
        this.p1Credit = 0;
        this.samples = { commit: [], queue: [] };
        // partyAck: from the flush's results to a held party leader's ack.
        this.stageSamples = { prepare: [], commitCall: [], afterCommit: [], ackBuild: [], partyAck: [] };
        // afterCommit split by the caller's step names: one sum per step per flush.
        this.stepSamples = {};
        this.flushReasons = {};
        this.lastBatchReason = null;
        // Counted always (cheap): an afterCommit that throws (economy review, training, events) does
        // not fail the commit, and its error was kept only on the result.
        this.failures = { afterCommitErrors: 0, lastAfterCommitError: null };
        this.counters = {
            enqueued: 0,
            coalesced: 0,
            committed: 0,
            stale: 0,
            rejected: 0,
            retries: 0,
            busy: 0,
            errors: 0,
            flushes: 0,
            pauses: 0,
            resumes: 0,
            highWaterHits: 0,
            windowFlushes: 0,
            windowDenied: 0,
            timerArms: 0,
            timerFires: 0,
            timerIdle: 0,
            groupIndexes: 0
        };
    }

    // Set by the coordinator when the worker reports that every one of its step
    // slots waits on main (or a party waits for slots): no row can join the
    // queued ones before an ack frees a slot, so waiting for a fuller batch buys
    // nothing. The ready rows commit at the next tick, admitted by the governor;
    // a refused admission leaves them to their own age (overdueMs). Held until
    // the queue is empty.
    get capacityBlocked() { return this.capacityPressure; }

    set capacityBlocked(value) {
        this.capacityPressure = value;
        if (value) this.arm();
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.gridOrigin = this.now();
        this.arm();
    }

    // Visit only the bounded queued proposals. Held groups neither hide ready
    // neighbours nor make the timer keep waking for an already reached age.
    scheduleState() {
        const groups = this.groupIndex(), seen = new Set();
        const lanes = Object.fromEntries(['P0', 'P1', 'P2'].map(priority => [priority,
            { readyAt: Infinity, dueAt: Infinity }]));
        const ages = [['P0', 1, 0], ['P1', 2, this.p1TargetMs], ['P2', 4, this.targetMs]];
        let overdueAt = Infinity;
        for (const lane of [this.p0, this.p1, this.p2]) for (const entry of lane.values()) {
            const id = entry.atomicGroup?.id;
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            const group = id ? groups.get(id) : [entry];
            let readyAt = 0, queuedAt = Infinity, priorities = 0;
            for (const member of group) {
                readyAt = Math.max(readyAt, member.memoryReadyAt);
                queuedAt = Math.min(queuedAt, member.queuedAt);
                priorities |= member.priority === 'P0' ? 1 : member.priority === 'P1' ? 2 : 4;
            }
            for (const [priority, bit, ageMs] of ages) {
                if (!(priorities & bit)) continue;
                const timing = lanes[priority];
                timing.readyAt = Math.min(timing.readyAt, readyAt);
                timing.dueAt = Math.min(timing.dueAt, Math.max(readyAt, queuedAt + ageMs));
            }
            if (priorities & 4) overdueAt = Math.min(overdueAt, Math.max(readyAt, queuedAt + this.overdueMs));
        }
        return { groups, lanes, overdueAt, readyAt: Math.min(lanes.P0.readyAt, lanes.P1.readyAt, lanes.P2.readyAt) };
    }

    nextDueAt(force = false) {
        const { lanes, overdueAt, readyAt } = this.scheduleState();
        if (force) return readyAt;
        return Math.min(lanes.P0.dueAt, lanes.P1.dueAt, lanes.P2.dueAt, overdueAt,
            this.capacityPressure ? readyAt : Infinity);
    }

    // Sleeps until the next due entry. Called wherever the due set can change:
    // an enqueue, the end of a flush, a capacity flag, start. A running flush
    // re-arms itself when it ends, so a wake-up during it is not needed.
    arm() {
        if (!this.started || this.stopping || this.flushing || !this.size()) return;
        const now = this.now();
        const dueAt = this.nextDueAt();
        let fireAt = this.gridOrigin + Math.ceil((Math.max(dueAt, now) - this.gridOrigin) / TICK_MS) * TICK_MS;
        if (fireAt <= now) fireAt += TICK_MS;
        if (this.timer && this.timerFireAt <= fireAt) return;
        clearTimeout(this.timer);
        this.timerFireAt = fireAt;
        this.timer = setTimeout(() => this.onTimer(), Math.min(2147483647, Math.max(1, fireAt - now)));
        this.timer.unref?.();
        DiagnosticConfig.developerDiagnostics && (this.counters.timerArms += 1);
    }

    async onTimer() {
        this.timer = null;
        this.timerFireAt = 0;
        DiagnosticConfig.developerDiagnostics && (this.counters.timerFires += 1);
        try {
            const flushed = await this.flushDue();
            if (!flushed) DiagnosticConfig.developerDiagnostics && (this.counters.timerIdle += 1);
        } finally {
            this.arm();
        }
    }

    size() {
        return this.p0.length + this.p1.length + this.p2.size;
    }

    // The worker measures each proposal while sizing its batch and sends that
    // size along; only a proposal without one is serialised here.
    proposalBytes(proposal, measured = null) {
        const known = Number(measured);
        return Number.isSafeInteger(known) && known > 0 ? known : Protocol.byteLength(proposal);
    }

    enqueue(proposal, measuredBytes = null) {
        if (this.stopping) return { ok: false, reason: 'queue_stopping' };
        if (!proposal || !proposal.characterId || !Number.isSafeInteger(proposal.revision) || proposal.revision < 0) {
            return { ok: false, reason: 'invalid_proposal' };
        }
        const bytes = this.proposalBytes(proposal, measuredBytes);
        if (!Number.isFinite(bytes) || bytes > Protocol.MAX_MESSAGE_BYTES) return { ok: false, reason: 'proposal_too_large' };
        const priority = ['P0', 'P1', 'P2'].includes(proposal.priority) ? proposal.priority : 'P2';
        const queued = { ...proposal, priority, bytes, queuedAt: this.now(), memoryReadyAt: memoryReadyAt(proposal) };

        if (priority === 'P2') {
            const previous = this.p2.get(Number(proposal.characterId));
            if (previous) {
                if (previous.revision !== proposal.revision) {
                    return { ok: false, reason: 'coalesce_boundary' };
                }
                this.bytes -= previous.bytes;
                queued.queuedAt = previous.queuedAt;
                // One commit for both steps: its bag fields name what either moved.
                const { bagChanged, changedItemIds, removedItemIds } = InventorySummary.mergeBagChange(previous, proposal);
                Object.assign(queued, { bagChanged, changedItemIds, removedItemIds });
                DiagnosticConfig.developerDiagnostics && (this.counters.coalesced += 1);
            }
            this.p2.set(Number(proposal.characterId), queued);
        } else {
            const lane = priority === 'P0' ? this.p0 : this.p1;
            lane.push(queued);
        }
        this.bytes += bytes;
        DiagnosticConfig.developerDiagnostics && (this.counters.enqueued += 1);

        if (this.size() >= this.maxEntries || this.bytes >= this.maxBytes) {
            DiagnosticConfig.developerDiagnostics && (this.counters.highWaterHits += 1);
            this.pause();
        } else if (this.size() >= this.highWater) {
            this.pause();
        }

        if (priority === 'P0') setImmediate(() => this.flushDue(true));
        this.arm();
        return { ok: true, priority, size: this.size(), bytes: this.bytes };
    }

    pause() {
        if (this.paused) return;
        this.paused = true;
        DiagnosticConfig.developerDiagnostics && (this.counters.pauses += 1);
        this.onPause();
    }

    maybeResume() {
        if (!this.paused || this.size() > this.lowWater || this.bytes > this.maxBytes / 2) return;
        this.paused = false;
        DiagnosticConfig.developerDiagnostics && (this.counters.resumes += 1);
        this.onResume();
    }

    // The lanes keep queuedAt order: arrays are pushed in time order, and a
    // coalesced P2 entry keeps both its Map position and its first queuedAt.
    oldest(lane) {
        if (lane instanceof Map) {
            const first = lane.values().next();
            return first.done ? this.now() : Number(first.value.queuedAt || this.now());
        }
        return lane.length ? Number(lane[0].queuedAt || this.now()) : this.now();
    }

    // Share an atomic group's readiness across priorities and handoff paths.
    // This index exists only for the bounded queue's current selection pass.
    groupIndex() {
        const groups = new Map();
        for (const lane of [this.p0, this.p1, this.p2]) for (const entry of lane.values()) {
            const groupId = entry.atomicGroup?.id;
            if (!groupId) continue;
            const group = groups.get(groupId);
            if (group) group.push(entry);
            else groups.set(groupId, [entry]);
        }
        DiagnosticConfig.developerDiagnostics && (this.counters.groupIndexes += 1);
        return groups;
    }

    *laneGroups(lane, groups) {
        const seen = new Set();
        for (const entry of lane.values()) {
            const id = entry.atomicGroup?.id;
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            yield id ? groups.get(id) : [entry];
        }
    }

    removeBatch(batch) {
        const selected = new Set(batch);
        for (const lane of [this.p0, this.p1]) {
            let kept = 0;
            for (const entry of lane) if (!selected.has(entry)) lane[kept++] = entry;
            lane.length = kept;
        }
        for (const entry of batch) {
            if (this.p2.get(Number(entry.characterId)) === entry) this.p2.delete(Number(entry.characterId));
        }
    }

    // Takes the batch out of the lane itself: an array lane (P0, P1) or the P2
    // Map keyed by characterId, both read in queuedAt order without a copy.
    takeLaneBatch(lane, limit, groups = this.groupIndex()) {
        const selected = [];
        let memoryEvents = 0;
        const timestamp = this.now();
        for (const group of this.laneGroups(lane, groups)) {
            if (groupReadyAt(group) > timestamp) continue;
            if (selected.length && selected.length + group.length > limit) break;
            if (!selected.length && group.length > limit) break;
            const groupMemoryEvents = group.reduce((count, candidate) =>
                count + (candidate.result?.memoryEvents?.length || 0), 0);
            if (selected.length && memoryEvents + groupMemoryEvents > MAX_MEMORY_EVENTS) break;
            stampEventWait(group);
            group.forEach((candidate) => {
                selected.push(candidate);
            });
            memoryEvents += groupMemoryEvents;
            // An oversized group cannot be split. Submit it alone so database
            // validation rejects it without blocking or rejecting its neighbours.
            if (memoryEvents >= MAX_MEMORY_EVENTS) break;
            if (selected.length >= limit) break;
        }
        if (!selected.length) return [];
        this.removeBatch(selected);
        return selected;
    }

    takeBatch(force = false, rowLimit = this.maxRows) {
        const timestamp = this.now();
        const { groups, lanes, overdueAt } = this.scheduleState();
        this.lastBatchReason = null;
        if (lanes.P0.readyAt <= timestamp) {
            this.lastBatchReason = force ? 'forced' : 'p0';
            return this.takeLaneBatch(this.p0, Math.min(16, rowLimit), groups);
        }
        const p2Overdue = overdueAt <= timestamp;
        const p1Ready = (force ? lanes.P1.readyAt : lanes.P1.dueAt) <= timestamp;
        const p2Ready = (force ? lanes.P2.readyAt : lanes.P2.dueAt) <= timestamp;
        if (p2Overdue || (p2Ready && (this.p1Credit >= 4 || !p1Ready))) {
            this.lastBatchReason = force ? 'forced' : p2Overdue ? 'p2_overdue' : 'p2_target';
            const batch = this.takeLaneBatch(this.p2, rowLimit, groups);
            this.p1Credit = 0;
            return batch;
        }
        if (p1Ready) {
            this.lastBatchReason = force ? 'forced' : 'p1';
            this.p1Credit += 1;
            return this.takeLaneBatch(this.p1, Math.min(16, rowLimit), groups);
        }
        if (p2Ready) {
            this.lastBatchReason = force ? 'forced' : 'p2_target';
            const batch = this.takeLaneBatch(this.p2, rowLimit, groups);
            this.p1Credit = 0;
            return batch;
        }
        return [];
    }

    async retryBusy(work) {
        const waits = [10, 25, 50, 100, 200];
        let attempt = 0;
        for (;;) {
            try {
                return await work();
            } catch (error) {
                if (!/SQLITE_BUSY|database is locked/i.test(error?.message || '') || attempt >= waits.length) throw error;
                DiagnosticConfig.developerDiagnostics && (this.counters.busy += 1);
                DiagnosticConfig.developerDiagnostics && (this.counters.retries += 1);
                await delay(waits[attempt] + Math.floor(Math.random() * 10));
                attempt += 1;
            }
        }
    }

    async flushDue(force = false) {
        if (this.flushing) return false;
        let batch = this.takeBatch(force);
        let windowLease = null;
        if (!batch.length && this.capacityPressure && this.size() && this.nextDueAt(true) <= this.now()) {
            windowLease = this.admitWindowFlush();
            if (windowLease) {
                batch = this.takeBatch(true);
                if (batch.length) this.lastBatchReason = 'window';
            } else {
                DiagnosticConfig.developerDiagnostics && (this.counters.windowDenied += 1);
                this.capacityPressure = false;
            }
        }
        if (!batch.length) {
            if (windowLease) this.completeWindowFlush(windowLease, 0);
            this.arm();
            return false;
        }
        DiagnosticConfig.developerDiagnostics && windowLease && (this.counters.windowFlushes += 1);
        await this.flushBatch(batch, windowLease);
        if (this.size() && (force || this.p0.length) && this.nextDueAt(true) <= this.now())
            setImmediate(() => this.flushDue(force));
        return true;
    }

    async flushBatch(batch, windowLease = null, settleDeferred = false) {
        this.flushing = true;
        const reason = this.lastBatchReason || 'unknown';
        if (DiagnosticConfig.developerDiagnostics) this.flushReasons[reason] = Number(this.flushReasons[reason] || 0) + 1;
        batch.forEach((entry) => { this.bytes = Math.max(0, this.bytes - entry.bytes); });
        const startedAt = this.now();
        let results = [];
        let handoffError = null;
        let afterCommitMs = 0;
        // The afterCommit callback adds each step's time here (entry.stepMs).
        const stepMs = DiagnosticConfig.developerDiagnostics ? {} : null;
        try {
            const prepared = [];
            for (const proposal of batch) {
                try {
                    const nextState = await this.prepare(proposal);
                    if (!nextState) {
                        results.push({ ok: false, characterId: proposal.characterId, reason: 'prepare_rejected', proposal });
                        continue;
                    }
                    prepared.push({ proposal, revision: proposal.revision, nextState, options: proposal.options || {},
                        atomicGroup: proposal.atomicGroup || null, ...(stepMs ? { stepMs } : {}) });
                } catch (error) {
                    handoffError ||= error;
                    results.push({ ok: false, characterId: proposal.characterId, reason: error?.message || 'prepare_error', proposal });
                }
            }
            DiagnosticConfig.developerDiagnostics && this.recordStage('prepare', this.now() - startedAt);
            if (prepared.length) {
                const commitStartedAt = DiagnosticConfig.developerDiagnostics ? this.now() : 0;
                let committed;
                try {
                    committed = await this.retryBusy(() => this.commit(prepared));
                } finally {
                    // Includes database queueing and busy retries, not just SQL execution.
                    DiagnosticConfig.developerDiagnostics && this.recordStage('commitCall', this.now() - commitStartedAt);
                }
                const byId = new Map(prepared.map((entry) => [Number(entry.nextState.characterId), entry]));
                for (const result of committed || []) {
                    const entry = byId.get(Number(result.characterId));
                    if (result.ok) {
                        const afterStartedAt = DiagnosticConfig.developerDiagnostics ? this.now() : 0;
                        try {
                            await this.afterCommit(entry, result);
                        } catch (error) {
                            // Persistence already succeeded. A failed journal or
                            // world notification must never become a rejected ACK.
                            FailureLog.note('cold.after_commit', error);
                            DiagnosticConfig.developerDiagnostics && (this.counters.errors += 1);
                            result.afterCommitError = error?.message || 'after_commit_error';
                            this.failures.afterCommitErrors += 1;
                            this.failures.lastAfterCommitError = { reason: result.afterCommitError, at: Date.now() };
                        } finally {
                            if (DiagnosticConfig.developerDiagnostics) afterCommitMs += this.now() - afterStartedAt;
                        }
                        DiagnosticConfig.developerDiagnostics && (this.counters.committed += 1);
                    } else if (Protocol.staleRefusal(result)) {
                        DiagnosticConfig.developerDiagnostics && (this.counters.stale += 1);
                    } else {
                        DiagnosticConfig.developerDiagnostics && (this.counters.rejected += 1);
                    }
                    // `deferred`: party work afterCommit left for after the flush; onResults
                    // starts it and holds that ack until it settles.
                    results.push({ ...result, proposal: entry?.proposal, nextState: entry?.nextState, deferred: entry?.deferred });
                }
            }
            DiagnosticConfig.developerDiagnostics && (this.counters.flushes += 1);
        } catch (error) {
            handoffError ||= error;
            DiagnosticConfig.developerDiagnostics && (this.counters.errors += 1);
            results.push(...batch.map((proposal) => ({
                ok: false,
                characterId: proposal.characterId,
                reason: error?.message || 'commit_error',
                proposal
            })));
        } finally {
            DiagnosticConfig.developerDiagnostics && this.recordStage('afterCommit', afterCommitMs);
            if (stepMs) for (const [step, ms] of Object.entries(stepMs)) this.recordStep(step, ms);
            if (windowLease) this.completeWindowFlush(windowLease, this.now() - startedAt);
            if (!this.size()) this.capacityBlocked = false;
            if (DiagnosticConfig.developerDiagnostics) {
            this.samples.commit.push(this.now() - startedAt);
            if (this.samples.commit.length > 256) this.samples.commit.shift();
            this.samples.queue.push(...batch.map((entry) => startedAt - entry.queuedAt));
            if (this.samples.queue.length > 512) this.samples.queue.splice(0, this.samples.queue.length - 512);
            }
            this.flushing = false;
            this.maybeResume();
            this.arm();
        }
        // A fence hands the bot over only after the entire group's party work.
        if (settleDeferred) for (const result of results) {
            await result.deferred?.();
            delete result.deferred;
        }
        results = results.map(result => ({ ...result, eventWaitMs: result.proposal?.eventWaitMs || 0 }));
        this.onResults(results);
        if (settleDeferred && handoffError) throw handoffError;
        return results;
    }

    async flushCharacter(characterId) {
        const id = Number(characterId);
        for (;;) {
            while (this.flushing) await delay(5);
            const proposal = this.p2.get(id)
                || this.p0.find(entry => Number(entry.characterId) === id)
                || this.p1.find(entry => Number(entry.characterId) === id);
            if (!proposal) return null;
            const group = proposal.atomicGroup?.id ? this.groupIndex().get(proposal.atomicGroup.id) : [proposal];
            const waitMs = groupReadyAt(group) - this.now();
            if (waitMs > 0) {
                await delay(Math.min(waitMs, 2147483647));
                continue;
            }
            stampEventWait(group);
            this.removeBatch(group);
            this.lastBatchReason = 'forced';
            const results = await this.flushBatch(group, null, true);
            return results.find(result => Number(result.characterId) === id) || null;
        }
    }

    async drain(timeoutMs = 10000) {
        this.stopping = true;
        clearTimeout(this.timer);
        this.timer = null;
        const deadline = this.now() + Math.max(100, Number(timeoutMs) || 10000);
        while ((this.size() || this.flushing) && this.now() < deadline) {
            if (!this.flushing) {
                if (!await this.flushDue(true) && this.size())
                    await delay(Math.max(1, Math.min(deadline - this.now(), this.nextDueAt(true) - this.now())));
            } else await delay(10);
        }
        return { drained: this.size() === 0 && !this.flushing, ...this.snapshot() };
    }

    recordStep(step, durationMs) {
        if (DiagnosticConfig.developerDiagnostics) pushSample(this.stepSamples[step] ||= [], durationMs);
    }

    recordStage(stage, durationMs) {
        if (!DiagnosticConfig.developerDiagnostics) return;
        const samples = this.stageSamples[stage];
        if (samples) pushSample(samples, durationMs);
    }

    snapshot() {
        const now = this.now();
        // Each lane is in queuedAt order: its head is its oldest entry.
        const oldestAt = Math.min(this.oldest(this.p0), this.oldest(this.p1), this.oldest(this.p2));
        return {
            ...(DiagnosticConfig.developerDiagnostics ? this.counters : { diagnosticsEnabled: false }),
            depth: this.size(),
            bytes: this.bytes,
            p0: this.p0.length,
            p1: this.p1.length,
            p2: this.p2.size,
            oldestMs: this.size() ? Math.max(0, now - oldestAt) : 0,
            paused: this.paused,
            flushing: this.flushing,
            failures: { ...this.failures },
            ...(DiagnosticConfig.developerDiagnostics ? {
            flushReasons: { ...this.flushReasons },
            stages: Object.fromEntries(Object.entries(this.stageSamples).map(([stage, samples]) => [stage, {
                count: samples.length, p95Ms: percentile(samples)
            }])),
            afterCommitSteps: Object.fromEntries(Object.entries(this.stepSamples)
                .map(([step, samples]) => [step, Math.round(percentile(samples))])),
            commitP95Ms: percentile(this.samples.commit),
            queueP95Ms: percentile(this.samples.queue)
            } : {})
        };
    }
}

module.exports = { ColdCommitQueue };
