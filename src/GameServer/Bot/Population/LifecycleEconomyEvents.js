'use strict';

const SAFETY_MS = 30 * 60000;

class LifecycleEconomyEvents {
    constructor({ registry, life, board, input, boardKey, work, onRepair = () => {}, onError = () => {}, now = Date.now }) {
        Object.assign(this, { registry, life, board, input, boardKey, work, onRepair, onError, now });
        this.records = new Map(); this.items = new Map(); this.quotes = new Map(); this.dirty = new Map();
        this.boardPending = new Map();
        this.active = false; this.running = false; this.generation = 0; this.boardEpoch = 0; this.safetyKey = {};
        this.metrics = { events: 0, runs: 0, boardInspected: 0, safetyInspected: 0, repaired: 0 };
    }

    start() {
        if (this.active) return;
        this.active = true; this.generation++;
        this.boardReady = this.board.isBoardReady?.() !== false;
        this.unsubscribeLife = this.life.subscribePublications(packet => this.observe(packet), { replay: true });
        this.unsubscribeBoard = this.board.subscribeBoardChanges(change => {
            if (change.reset) { this.boardReady = false; this.boardEpoch++; this.boardRecovery = null; return; }
            if (change.ready === false) return;
            if (change.ready === true) this.boardReady = true;
            if (change.ready === true && !change.selfIds) {
                this.boardRecovery = { iterator: this.items.keys(), remaining: this.items.size };
            }
            for (const itemId of change.selfIds || []) {
                const key = this.boardKey(itemId), previous = this.quotes.get(itemId);
                this.quotes.set(itemId, key);
                if (key === previous) continue;
                const owners = this.items.get(itemId);
                if (!owners) continue;
                // The caller supplies demand keys for sellers and production.
                // Supply uses the separate five-funded-buyer index.
                this.boardPending.set(itemId, { iterator: owners.values(), remaining: owners.size, seen: new Set() });
            }
        });
        this.unsubscribeTick = this.registry.subscribeTicks(timestamp => this.pulse(timestamp));
        this.scheduleSafety(this.now());
    }

    stop() {
        this.active = false; this.generation++;
        this.unsubscribeLife?.(); this.unsubscribeBoard?.(); this.unsubscribeTick?.();
        this.registry.cancelDeadline(this.safetyKey);
        for (const record of this.records.values()) this.registry.cancelDeadline(record);
        this.records.clear(); this.items.clear(); this.quotes.clear(); this.boardPending.clear(); this.dirty.clear(); this.safety = null;
        this.boardRecovery = null;
    }

    remove(record) {
        if (!record) return;
        this.registry.cancelDeadline(record); this.dirty.delete(record.id); this.records.delete(record.id);
        for (const id of record.items) {
            const owners = this.items.get(id); owners?.delete(record.id);
            if (!owners?.size) { this.items.delete(id); this.quotes.delete(id); }
        }
    }

    enqueue(record) {
        if (!record || !this.active) return;
        record.handled = false;
        if (record.eligible) this.dirty.set(record.id, record);
    }

    setWatchItems(id, ids) {
        const record = this.records.get(Number(id));
        if (!record || !this.active) return;
        record.extraItems = new Set(ids.filter(value => Number.isSafeInteger(value) && value > 0));
        const desired = new Set([...record.baseItems, ...record.extraItems]);
        for (const itemId of record.items) if (!desired.has(itemId)) {
            const owners = this.items.get(itemId); owners?.delete(record.id);
            if (!owners?.size) { this.items.delete(itemId); this.quotes.delete(itemId); }
        }
        for (const itemId of desired) if (!record.items.has(itemId)) {
            if (!this.items.has(itemId)) { this.items.set(itemId, new Set()); this.quotes.set(itemId, this.boardKey(itemId)); }
            this.items.get(itemId).add(record.id);
        }
        record.items = desired;
    }

    observe(packet, repair = false) {
        if (!this.active) return;
        if (packet.kind === 'reset') {
            for (const record of [...this.records.values()]) this.remove(record);
            return;
        }
        const id = Number(packet.characterId), state = this.life.cachedState(id);
        if (packet.state && packet.state !== state) return;
        const input = state && this.input(state);
        const old = this.records.get(id);
        if (!input) { this.remove(old); return; }
        const changed = !old || old.key !== input.key;
        const becameEligible = input.eligible && !old?.eligible;
        let record = old;
        if (changed) {
            this.remove(old);
            const baseItems = new Set(input.items || []), extraItems = old?.extraItems || new Set();
            record = { id, key: input.key, state, eligible: input.eligible, baseItems, extraItems,
                items: new Set([...baseItems, ...extraItems]) };
            this.records.set(id, record);
            for (const itemId of record.items) {
                if (!this.items.has(itemId)) { this.items.set(itemId, new Set()); this.quotes.set(itemId, this.boardKey(itemId)); }
                this.items.get(itemId).add(id);
            }
            this.metrics.events++;
        }
        record.state = state; record.eligible = input.eligible;
        const dueAt = Number(input.dueAt || 0);
        if (dueAt !== record.dueAt) {
            this.registry.cancelDeadline(record); record.dueAt = dueAt;
            if (dueAt > this.now()) this.registry.armDeadline(record, Math.ceil(dueAt), () => {
                if (this.records.get(id) !== record) return;
                record.dueAt = 0; this.enqueue(record);
            });
        }
        if (changed || becameEligible && !record.handled) this.enqueue(record);
        if (repair && record.eligible && (changed || !record.handled && !this.dirty.has(id) && !record.inFlight)) {
            this.enqueue(record); record.repairPending = true;
        }
    }

    scheduleSafety(timestamp) {
        this.registry.armDeadline(this.safetyKey, Math.ceil(timestamp + SAFETY_MS), () => {
            this.safety = { cursor: { afterId: 0 }, generation: this.generation };
        });
    }

    async safetyStep() {
        const cycle = this.safety;
        if (!cycle || this.safetyRunning) return;
        this.safetyRunning = true;
        try {
            const page = await this.life.safetyPage({ ...cycle.cursor, limit: 64 });
            if (!this.active || cycle !== this.safety || cycle.generation !== this.generation) return;
            for (const row of page.rows) {
                this.metrics.safetyInspected++;
                this.observe({ characterId: row.characterId, state: this.life.cachedState(row.characterId) }, true);
            }
            cycle.cursor = page.cursor;
            if (page.done) { this.safety = null; this.scheduleSafety(this.now()); }
        } catch (error) { this.onError(error); }
        finally { this.safetyRunning = false; }
    }

    pulse(timestamp = this.now()) {
        if (!this.active || !this.boardReady) return;
        // Keep accepted unfinished edges through board restoration. Quotes
        // may already carry that edge, so ready equality cannot recreate it.
        let boardBudget = this.boardReady ? 64 : 0;
        while (this.boardRecovery && boardBudget > 0 && this.boardRecovery.remaining > 0) {
            const next = this.boardRecovery.iterator.next(); boardBudget--; this.boardRecovery.remaining--;
            if (next.done) { this.boardRecovery = null; break; }
            const key = this.boardKey(next.value), previous = this.quotes.get(next.value);
            this.quotes.set(next.value, key);
            const owners = this.items.get(next.value);
            if (owners && key !== previous) this.boardPending.set(next.value,
                { iterator: owners.values(), remaining: owners.size, seen: new Set() });
        }
        if (this.boardRecovery?.remaining === 0) this.boardRecovery = null;
        for (const [itemId, pending] of this.boardPending) {
            while (boardBudget > 0 && pending.remaining > 0) {
                const next = pending.iterator.next(); boardBudget--;
                if (next.done) { pending.remaining = 0; break; }
                this.metrics.boardInspected++;
                if (pending.seen.has(next.value)) continue;
                pending.seen.add(next.value); pending.remaining--;
                this.enqueue(this.records.get(next.value));
            }
            if (!pending.remaining) this.boardPending.delete(itemId);
            if (!boardBudget) break;
        }
        if (this.safety) this.safetyStep();
        if (this.running || !this.dirty.size) return;
        const [id, record] = this.dirty.entries().next().value;
        this.dirty.delete(id);
        const state = this.life.cachedState(id);
        if (this.records.get(id) !== record || record.state !== state || !record.eligible) return;
        const generation = this.generation;
        this.running = true; record.inFlight = true; this.metrics.runs++;
        Promise.resolve().then(() => this.active && generation === this.generation ? this.work(state) : null)
            .then(result => {
                if (!this.active || generation !== this.generation || this.records.get(id) !== record) return;
                if (result?.deferred) this.registry.armDeadline(record, Math.ceil(Math.max(timestamp + 1000, result.retryAt || 0)), () => this.enqueue(record));
                else {
                    record.handled = true;
                    if (record.repairPending) { record.repairPending = false; this.metrics.repaired++; this.onRepair(); }
                    this.observe({ characterId: id, state: this.life.cachedState(id) });
                }
            }).catch(error => {
                this.onError(error);
                if (this.active && generation === this.generation && this.records.get(id) === record) {
                    this.registry.armDeadline(record, Math.ceil(timestamp + 5000), () => this.enqueue(record));
                }
            }).finally(() => { record.inFlight = false; this.running = false; });
    }
}

module.exports = { LifecycleEconomyEvents };
