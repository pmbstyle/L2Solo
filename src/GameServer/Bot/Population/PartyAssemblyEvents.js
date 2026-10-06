'use strict';

const SAFETY_INTERVAL_MS = 30 * 60000;

// An input index holds original published states. Combat/coordinate updates
// refresh the reference without restarting an unchanged assembly decision.
class PartyAssemblyEvents {
    constructor({ registry, life, parties, classify, run, expire, now = Date.now,
        retryMs = 30000, onRepair = () => {}, onError = () => {} }) {
        Object.assign(this, { registry, life, parties, classify, run, expire, now,
            retryMs, onRepair, onError });
        this.records = new Map();
        this.groups = new Map();
        this.dirty = new Set();
        this.deadlines = new Set();
        this.running = false;
        this.active = false;
        this.generation = 0;
        this.safetyKey = {};
        this.helpKey = {};
        this.metrics = { events: 0, attempts: 0, safetyInspected: 0, repaired: 0 };
    }

    arm(key, at, callback) {
        this.deadlines.add(key);
        return this.registry.armDeadline(key, Math.ceil(at), timestamp => {
            this.deadlines.delete(key);
            if (this.active) callback(timestamp);
        });
    }

    cancel(key) { this.deadlines.delete(key); this.registry.cancelDeadline(key); }

    start() {
        if (this.active) return false;
        this.active = true; this.generation++;
        this.unsubscribeLife = this.life.subscribePublications(packet => this.observe(packet), { replay: true });
        this.unsubscribeParty = this.parties.subscribeChanges((party, previous) => {
            if (party.memberIds?.join(':') === previous?.memberIds?.join(':') && party.status === previous?.status) return;
            for (const id of new Set([...(party.memberIds || []), ...(previous?.memberIds || [])])) {
                this.observe({ characterId: id, state: this.life.cachedState(id) });
            }
            // Freed capacity wakes already indexed waiting groups.
            if (previous && party.status === 'dissolved') {
                for (const group of this.groups.values()) this.enqueue(group);
            }
        });
        this.unsubscribeTick = this.registry.subscribeTicks(timestamp => this.pulse(timestamp));
        this.scheduleSafety(this.now());
        return true;
    }

    stop() {
        this.active = false; this.generation++;
        this.unsubscribeLife?.(); this.unsubscribeParty?.(); this.unsubscribeTick?.();
        for (const key of this.deadlines) this.registry.cancelDeadline(key);
        this.deadlines.clear(); this.records.clear(); this.groups.clear(); this.dirty.clear();
        this.cycle = null; this.helpPending = false;
    }

    enqueue(group) {
        if (group && this.active) {
            this.cancel(group);
            group.remaining = group.members.size;
            this.dirty.add(group.key);
        }
    }

    observe(packet, repair = false) {
        if (!this.active) return false;
        if (packet.kind === 'reset') {
            for (const record of this.records.values()) this.cancel(record);
            for (const group of this.groups.values()) this.cancel(group);
            this.records.clear(); this.groups.clear(); this.dirty.clear();
            return false;
        }
        const id = Number(packet.characterId), state = this.life.cachedState(id);
        // A reentrant publication must never revive an old source.
        if (packet.state && packet.state !== state) return false;
        const input = state && this.classify(state, this.now());
        const previous = this.records.get(id);
        const changed = previous?.key !== input?.key || previous?.stamp !== input?.stamp;
        if (previous && (!input || changed)) {
            const group = this.groups.get(previous.key);
            group?.members.delete(id);
            if (group) { group.revision++; this.enqueue(group); }
            this.cancel(previous);
            this.records.delete(id);
        }
        if (!input) {
            if (previous && repair) { this.metrics.repaired++; this.onRepair(); }
            return !!previous;
        }
        const record = changed || !previous ? { id, key: input.key, stamp: input.stamp, state } : previous;
        record.state = state;
        if (!this.groups.has(input.key)) this.groups.set(input.key, { key: input.key, members: new Map(), revision: 0, handled: 0 });
        const group = this.groups.get(input.key);
        group.members.set(id, record);
        this.records.set(id, record);
        if (changed || !previous) {
            group.revision++; this.enqueue(group); this.metrics.events++;
            if (repair) { this.metrics.repaired++; this.onRepair(); }
        }
        const dueAt = Number(input.dueAt || 0);
        if (record.dueAt !== dueAt) {
            this.cancel(record); record.dueAt = dueAt;
            if (dueAt > 0) {
                const expired = () => {
                    if (this.records.get(id) !== record) return;
                    Promise.resolve(this.expire?.(id)).then(result => {
                        if (!this.active || this.records.get(id) !== record) return;
                        if (result?.deferred) this.arm(record, this.now() + this.retryMs, expired);
                        else { record.dueAt = 0; this.observe({ characterId: id, state: this.life.cachedState(id) }); this.enqueue(group); }
                    }).catch(error => {
                        this.onError(error);
                        if (this.active && this.records.get(id) === record) this.arm(record, this.now() + this.retryMs, expired);
                    });
                };
                this.arm(record, Math.max(dueAt, this.now()), expired);
            }
        }
        if (repair && group.handled < group.revision && !this.dirty.has(group.key)
            && !this.deadlines.has(group) && !this.running) {
            this.enqueue(group); this.metrics.repaired++; this.onRepair();
        }
        return changed || !previous;
    }

    wakeHelp() { if (this.active) this.helpPending = true; }

    wakeGroups() { for (const group of this.groups.values()) this.enqueue(group); }

    scheduleSafety(timestamp) {
        this.arm(this.safetyKey, timestamp + SAFETY_INTERVAL_MS, startedAt => {
            this.cycle = { cursor: { afterId: 0 }, startedAt, generation: this.generation,
                membership: this.records.values(), remaining: this.records.size, nativeDone: false };
        });
    }

    async safetyStep() {
        const cycle = this.cycle;
        if (!cycle || this.safetyRunning) return;
        this.safetyRunning = true;
        try {
            if (cycle.nativeDone) {
                for (let inspected = 0; inspected < 64 && cycle.remaining > 0; inspected++) {
                    const next = cycle.membership.next(); cycle.remaining--;
                    if (next.done) { cycle.remaining = 0; break; }
                    const record = next.value; this.metrics.safetyInspected++;
                    if (this.records.get(record.id) === record && !this.life.cachedState(record.id)) {
                        this.observe({ characterId: record.id }, true);
                    }
                }
                if (!cycle.remaining) { this.cycle = null; this.scheduleSafety(Math.max(this.now(), cycle.startedAt)); }
                return;
            }
            const page = await this.life.safetyPage({ ...cycle.cursor, limit: 64 });
            if (!this.active || this.cycle !== cycle || this.generation !== cycle.generation) return;
            for (const row of page.rows) {
                this.metrics.safetyInspected++;
                this.observe({ characterId: row.characterId, state: this.life.cachedState(row.characterId) }, true);
            }
            cycle.cursor = page.cursor;
            if (page.done) {
                cycle.nativeDone = true;
                if (!cycle.remaining) { this.cycle = null; this.scheduleSafety(Math.max(this.now(), cycle.startedAt)); }
            }
        } catch (error) { this.onError(error); }
        finally { this.safetyRunning = false; }
    }

    pulse(timestamp = this.now()) {
        if (!this.active) return;
        if (this.cycle) this.safetyStep();
        if (this.running || !this.helpPending && !this.dirty.size) return;
        const key = this.helpPending ? null : this.dirty.values().next().value;
        const group = key === null ? null : this.groups.get(key);
        this.helpPending = false; this.dirty.delete(key);
        if (key !== null && (!group || !group.members.size)) { this.groups.delete(key); return; }
        const candidates = [];
        if (group) {
            // Rotate a bounded page, including invalid/busy inspections.
            const count = Math.min(64, group.members.size, group.remaining ?? group.members.size), iterator = group.members.entries();
            for (let inspected = 0; inspected < count; inspected++) {
                const [id, record] = iterator.next().value;
                group.members.delete(id); group.members.set(id, record);
                if (this.life.cachedState(id) === record.state) candidates.push(record.state);
            }
            group.remaining = Math.max(0, Number(group.remaining || count) - count);
        }
        const generation = this.generation, revision = group?.revision;
        this.running = true; this.metrics.attempts++;
        Promise.resolve().then(() => this.active && generation === this.generation
            ? this.run(candidates, timestamp, key === null) : null).then(result => {
            if (!this.active || generation !== this.generation) return;
            if (result?.deferred || result?.continuation) {
                const retryKey = group || this.helpKey;
                this.arm(retryKey, Math.max(timestamp + this.retryMs, Number(result.retryAt || 0)), () => {
                    if (group) this.enqueue(group); else this.wakeHelp();
                });
            } else if (group?.remaining > 0) this.dirty.add(group.key);
            else if (group) group.handled = revision;
            if (group?.revision !== revision) this.enqueue(group);
        }).catch(error => {
            if (this.active && generation === this.generation) {
                this.onError(error);
                this.arm(group || this.helpKey, this.now() + this.retryMs, () => group ? this.enqueue(group) : this.wakeHelp());
            }
        }).finally(() => { this.running = false; });
    }
}

module.exports = { PartyAssemblyEvents, SAFETY_INTERVAL_MS };
