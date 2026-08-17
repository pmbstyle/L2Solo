const Protocol = require('./ColdSimulationProtocol');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, ratio = 0.95) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
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
        this.flushing = false;
        this.stopping = false;
        this.paused = false;
        this.p1Credit = 0;
        this.samples = { claim: [], commit: [], queue: [] };
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
            highWaterHits: 0
        };
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.flushDue(), 25);
        this.timer.unref?.();
    }

    size() {
        return this.p0.length + this.p1.length + this.p2.size;
    }

    proposalBytes(proposal) {
        return Protocol.byteLength(proposal);
    }

    enqueue(proposal) {
        if (this.stopping) return { ok: false, reason: 'queue_stopping' };
        if (!proposal || !proposal.characterId || !proposal.token) return { ok: false, reason: 'invalid_proposal' };
        const bytes = this.proposalBytes(proposal);
        if (!Number.isFinite(bytes) || bytes > Protocol.MAX_MESSAGE_BYTES) return { ok: false, reason: 'proposal_too_large' };
        const priority = ['P0', 'P1', 'P2'].includes(proposal.priority) ? proposal.priority : 'P2';
        const queued = { ...proposal, priority, bytes, queuedAt: this.now() };

        if (priority === 'P2') {
            const previous = this.p2.get(Number(proposal.characterId));
            if (previous) {
                if (String(previous.token?.leaseId) !== String(proposal.token?.leaseId)
                    || Number(previous.token?.revision) !== Number(proposal.token?.revision)) {
                    return { ok: false, reason: 'coalesce_boundary' };
                }
                this.bytes -= previous.bytes;
                queued.queuedAt = previous.queuedAt;
                this.counters.coalesced += 1;
            }
            this.p2.set(Number(proposal.characterId), queued);
        } else {
            const lane = priority === 'P0' ? this.p0 : this.p1;
            lane.push(queued);
        }
        this.bytes += bytes;
        this.counters.enqueued += 1;

        if (this.size() >= this.maxEntries || this.bytes >= this.maxBytes) {
            this.counters.highWaterHits += 1;
            this.pause();
        } else if (this.size() >= this.highWater) {
            this.pause();
        }

        if (priority === 'P0') setImmediate(() => this.flushDue(true));
        return { ok: true, priority, size: this.size(), bytes: this.bytes };
    }

    pause() {
        if (this.paused) return;
        this.paused = true;
        this.counters.pauses += 1;
        this.onPause();
    }

    maybeResume() {
        if (!this.paused || this.size() > this.lowWater || this.bytes > this.maxBytes / 2) return;
        this.paused = false;
        this.counters.resumes += 1;
        this.onResume();
    }

    oldest(lane) {
        if (lane instanceof Map) {
            return [...lane.values()].reduce((oldest, entry) => Math.min(oldest, entry.queuedAt), this.now());
        }
        return lane.length ? Number(lane[0].queuedAt || this.now()) : this.now();
    }

    takeLaneBatch(lane, limit) {
        const selected = [];
        const selectedEntries = new Set();
        for (const entry of lane) {
            if (selectedEntries.has(entry)) continue;
            const groupId = entry.atomicGroup?.id;
            const group = groupId
                ? lane.filter((candidate) => candidate.atomicGroup?.id === groupId)
                : [entry];
            if (selected.length && selected.length + group.length > limit) break;
            if (!selected.length && group.length > limit) break;
            group.forEach((candidate) => {
                selected.push(candidate);
                selectedEntries.add(candidate);
            });
            if (selected.length >= limit) break;
        }
        if (!selected.length) return [];
        const selectedSet = new Set(selected);
        for (let index = lane.length - 1; index >= 0; index--) {
            if (selectedSet.has(lane[index])) lane.splice(index, 1);
        }
        return selected;
    }

    takeBatch(force = false) {
        const timestamp = this.now();
        if (this.p0.length) return this.takeLaneBatch(this.p0, Math.min(16, this.maxRows));
        const p2Overdue = this.p2.size > 0 && timestamp - this.oldest(this.p2) >= this.overdueMs;
        const p1Ready = this.p1.length > 0 && (force || timestamp - this.oldest(this.p1) >= this.p1TargetMs);
        const p2Ready = this.p2.size > 0 && (force || timestamp - this.oldest(this.p2) >= this.targetMs);
        if (p2Overdue || (p2Ready && (this.p1Credit >= 4 || !p1Ready))) {
            const batch = [...this.p2.values()]
                .sort((a, b) => a.queuedAt - b.queuedAt)
                .slice(0, this.maxRows);
            batch.forEach((entry) => this.p2.delete(Number(entry.characterId)));
            this.p1Credit = 0;
            return batch;
        }
        if (p1Ready) {
            this.p1Credit += 1;
            return this.takeLaneBatch(this.p1, Math.min(16, this.maxRows));
        }
        if (p2Ready) {
            const batch = [...this.p2.values()]
                .sort((a, b) => a.queuedAt - b.queuedAt)
                .slice(0, this.maxRows);
            batch.forEach((entry) => this.p2.delete(Number(entry.characterId)));
            this.p1Credit = 0;
            return batch;
        }
        return [];
    }

    async retryBusy(work) {
        const waits = [10, 25, 50, 100, 200];
        let attempt = 0;
        while (true) {
            try {
                return await work();
            } catch (error) {
                if (!/SQLITE_BUSY|database is locked/i.test(error?.message || '') || attempt >= waits.length) throw error;
                this.counters.busy += 1;
                this.counters.retries += 1;
                await delay(waits[attempt] + Math.floor(Math.random() * 10));
                attempt += 1;
            }
        }
    }

    async flushDue(force = false) {
        if (this.flushing) return false;
        const batch = this.takeBatch(force);
        if (!batch.length) return false;
        this.flushing = true;
        batch.forEach((entry) => { this.bytes = Math.max(0, this.bytes - entry.bytes); });
        const startedAt = this.now();
        let results = [];
        try {
            const prepared = [];
            for (const proposal of batch) {
                try {
                    const nextState = await this.prepare(proposal);
                    if (!nextState) {
                        results.push({ ok: false, characterId: proposal.characterId, reason: 'prepare_rejected', proposal });
                        continue;
                    }
                    prepared.push({ proposal, token: proposal.token, nextState, options: proposal.options || {} });
                } catch (error) {
                    results.push({ ok: false, characterId: proposal.characterId, reason: error?.message || 'prepare_error', proposal });
                }
            }
            if (prepared.length) {
                const committed = await this.retryBusy(() => this.commit(prepared));
                const byId = new Map(prepared.map((entry) => [Number(entry.nextState.characterId), entry]));
                for (const result of committed || []) {
                    const entry = byId.get(Number(result.characterId));
                    if (result.ok) {
                        await this.afterCommit(entry, result);
                        this.counters.committed += 1;
                    } else if (String(result.reason || '').includes('stale') || ['lease_changed', 'owner_changed'].includes(result.reason)) {
                        this.counters.stale += 1;
                    } else {
                        this.counters.rejected += 1;
                    }
                    results.push({ ...result, proposal: entry?.proposal, nextState: entry?.nextState });
                }
            }
            this.counters.flushes += 1;
        } catch (error) {
            this.counters.errors += 1;
            results.push(...batch.map((proposal) => ({
                ok: false,
                characterId: proposal.characterId,
                reason: error?.message || 'commit_error',
                proposal
            })));
        } finally {
            this.samples.commit.push(this.now() - startedAt);
            if (this.samples.commit.length > 256) this.samples.commit.shift();
            this.samples.queue.push(...batch.map((entry) => startedAt - entry.queuedAt));
            if (this.samples.queue.length > 512) this.samples.queue.splice(0, this.samples.queue.length - 512);
            this.flushing = false;
            this.maybeResume();
        }
        this.onResults(results);
        if (this.size() && (force || this.p0.length)) setImmediate(() => this.flushDue(force));
        return true;
    }

    async flushCharacter(characterId) {
        const id = Number(characterId);
        while (this.flushing) await delay(5);
        let proposal = this.p2.get(id);
        if (!proposal) {
            let index = this.p0.findIndex((entry) => Number(entry.characterId) === id);
            if (index >= 0) proposal = this.p0.splice(index, 1)[0];
            if (!proposal) {
                index = this.p1.findIndex((entry) => Number(entry.characterId) === id);
                if (index >= 0) proposal = this.p1.splice(index, 1)[0];
            }
        }
        if (!proposal) return null;
        this.p2.delete(id);
        this.bytes = Math.max(0, this.bytes - proposal.bytes);
        const nextState = await this.prepare(proposal);
        if (!nextState) return { ok: false, characterId: id, reason: 'prepare_rejected' };
        const results = await this.retryBusy(() => this.commit([{
            proposal,
            token: proposal.token,
            nextState,
            options: proposal.options || {}
        }]));
        const result = results?.[0] || { ok: false, characterId: id, reason: 'missing_commit_result' };
        if (result.ok) await this.afterCommit({ proposal, token: proposal.token, nextState }, result);
        this.onResults([{ ...result, proposal, nextState }]);
        return { ...result, proposal, nextState };
    }

    async drain(timeoutMs = 10000) {
        this.stopping = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        const deadline = this.now() + Math.max(100, Number(timeoutMs) || 10000);
        while ((this.size() || this.flushing) && this.now() < deadline) {
            if (!this.flushing) await this.flushDue(true);
            else await delay(10);
        }
        return { drained: this.size() === 0 && !this.flushing, ...this.snapshot() };
    }

    snapshot() {
        const now = this.now();
        const queued = [...this.p0, ...this.p1, ...this.p2.values()];
        const oldestAt = queued.reduce((oldest, entry) => Math.min(oldest, Number(entry.queuedAt || now)), now);
        return {
            ...this.counters,
            depth: this.size(),
            bytes: this.bytes,
            p0: this.p0.length,
            p1: this.p1.length,
            p2: this.p2.size,
            oldestMs: queued.length ? Math.max(0, now - oldestAt) : 0,
            paused: this.paused,
            flushing: this.flushing,
            commitP95Ms: percentile(this.samples.commit),
            queueP95Ms: percentile(this.samples.queue)
        };
    }
}

module.exports = { ColdCommitQueue };
