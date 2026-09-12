const Policy = require('./InteractionMemoryPolicy');

// Combat callbacks enqueue immutable episodes; SQL runs after the callback.
// Capacity is bounded and a failed write keeps its original key for retry.
class InteractionEventQueue {
    constructor(memory, { onCommit = () => {}, onError = () => {}, now = Date.now } = {}) {
        this.memory = memory;
        this.onCommit = onCommit;
        this.onError = onError;
        this.now = now;
        this.pending = new Map();
        this.running = null;
        this.timer = null;
        this.stopping = false;
        this.drainDeadline = Infinity;
        this.counters = { committed: 0, busy: 0, expired: 0, errors: 0 };
    }

    enqueue(input) {
        if (this.stopping) return false;
        const event = Policy.event(input);
        if (this.pending.has(event.key)) return true;
        if (this.pending.size >= 1024) { this.counters.busy++; return false; }
        this.pending.set(event.key, event);
        this.schedule(0);
        return true;
    }

    schedule(delay) {
        if (this.stopping || this.timer || this.running || !this.pending.size) return;
        this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
        this.timer.unref?.();
    }

    flush() {
        if (this.running) return this.running;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.running = this.flushPage().finally(() => {
            this.running = null;
            this.schedule(1000);
        });
        return this.running;
    }

    async flushPage() {
        for (const event of [...this.pending.values()].slice(0, Policy.MAX_BATCH)) {
            // A drain can start while this page is already awaiting SQLite.
            // Finish that write, but do not start another after its deadline.
            if (this.now() >= this.drainDeadline) break;
            if (event.at < this.now() - Policy.ACCEPT_WINDOW_MS) {
                this.pending.delete(event.key);
                this.counters.expired++;
                continue;
            }
            try {
                const result = await this.memory.recordBatch([event]);
                if (!result.ok) {
                    if (result.reason === 'expired_event') {
                        this.pending.delete(event.key);
                        this.counters.expired++;
                    }
                    continue;
                }
                this.pending.delete(event.key);
                this.counters.committed++;
                this.onCommit(event.sourceId);
            } catch (error) {
                this.counters.errors++;
                this.onError(error);
                // Rotate failed episodes so one unavailable owner cannot starve others.
                if (this.pending.delete(event.key)) this.pending.set(event.key, event);
            }
        }
    }

    snapshot() { return { ...this.counters, pending: this.pending.size }; }

    async drain(timeoutMs = 3000) {
        this.stopping = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.drainDeadline = Math.min(this.drainDeadline, this.now() + timeoutMs);
        if (this.running) await this.running;
        while (this.pending.size && this.now() < this.drainDeadline) {
            await this.flush();
            const remainingMs = this.drainDeadline - this.now();
            if (this.pending.size && remainingMs > 0) {
                await new Promise(resolve => setTimeout(resolve, Math.min(25, remainingMs)));
            }
        }
        return { drained: this.pending.size === 0, ...this.snapshot() };
    }
}

module.exports = InteractionEventQueue;
