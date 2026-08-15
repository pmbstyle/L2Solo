class ColdSnapshotQueue {
    constructor(options = {}) {
        this.now = options.now || (() => Date.now());
        this.pageSize = Math.max(32, Math.min(64, Number(options.pageSize) || 48));
        this.playerPageSize = Math.max(32, Math.min(this.pageSize, Number(options.playerPageSize) || 32));
        this.maxDeferralMs = Math.max(1000, Number(options.maxDeferralMs) || 5000);
        this.lagThrottleMs = Math.max(1, Number(options.lagThrottleMs) || 40);
        this.lagAbortMs = Math.max(this.lagThrottleMs, Number(options.lagAbortMs) || 120);
        this.sequence = 0;
        this.dirty = new Map();
        this.critical = new Map();
        this.counters = {
            marked: 0,
            coalesced: 0,
            deferred: 0,
            critical: 0,
            delivered: 0
        };
    }

    mark(state, options = {}) {
        const characterId = Number(state?.characterId || 0);
        if (!characterId) return { ok: false, reason: 'invalid_character' };

        const timestamp = this.now();
        const previous = this.dirty.get(characterId);
        const critical = options.critical === true || previous?.critical === true;
        const entry = {
            characterId,
            state,
            critical,
            reason: String(options.reason || previous?.reason || 'state_changed'),
            queuedAt: previous?.queuedAt || timestamp,
            version: ++this.sequence
        };
        this.dirty.set(characterId, entry);
        if (critical) this.critical.set(characterId, entry);
        this.counters.marked += 1;
        if (previous) this.counters.coalesced += 1;
        if (critical) this.counters.critical += 1;
        return { ok: true, entry, coalesced: !!previous };
    }

    size() {
        return this.dirty.size;
    }

    oldestAgeMs() {
        if (!this.dirty.size) return 0;
        const oldest = Math.min(...Array.from(this.dirty.values()).map((entry) => Number(entry.queuedAt || this.now())));
        return Math.max(0, this.now() - oldest);
    }

    takeCritical(limit = this.pageSize) {
        const entries = Array.from(this.critical.values())
            .sort((a, b) => a.queuedAt - b.queuedAt || a.characterId - b.characterId)
            .slice(0, Math.max(1, Math.min(64, Number(limit) || this.pageSize)));
        entries.forEach((entry) => {
            if (this.critical.get(entry.characterId)?.version === entry.version) {
                this.critical.delete(entry.characterId);
            }
        });
        return entries;
    }

    takeNormal(pressure = {}) {
        if (!this.dirty.size) return { entries: [], deferred: false, pageSize: this.pageSize };

        const lagMs = Math.max(0, Number(pressure.lagMs) || 0);
        const player = pressure.player === true;
        const forced = this.oldestAgeMs() >= this.maxDeferralMs;
        if (lagMs >= this.lagAbortMs && !forced) {
            this.counters.deferred += 1;
            return { entries: [], deferred: true, pageSize: this.playerPageSize };
        }

        const limit = player || lagMs >= this.lagThrottleMs ? this.playerPageSize : this.pageSize;
        const entries = Array.from(this.dirty.values())
            .filter((entry) => !entry.critical || !this.critical.has(entry.characterId))
            .sort((a, b) => a.queuedAt - b.queuedAt || a.characterId - b.characterId)
            .slice(0, limit);
        return { entries, deferred: false, pageSize: limit };
    }

    complete(entry, delivered = true) {
        if (!entry || !entry.characterId) return false;
        const current = this.dirty.get(entry.characterId);
        if (current?.version !== entry.version) return false;
        this.dirty.delete(entry.characterId);
        this.critical.delete(entry.characterId);
        if (delivered) this.counters.delivered += 1;
        return true;
    }

    restoreCritical(entry) {
        if (!entry || !entry.characterId) return false;
        const current = this.dirty.get(entry.characterId);
        if (current?.version !== entry.version) return false;
        this.critical.set(entry.characterId, entry);
        return true;
    }

    snapshot() {
        return {
            dirty: this.dirty.size,
            critical: this.critical.size,
            oldestMs: this.oldestAgeMs(),
            pageSize: this.pageSize,
            playerPageSize: this.playerPageSize,
            maxDeferralMs: this.maxDeferralMs,
            lagThrottleMs: this.lagThrottleMs,
            lagAbortMs: this.lagAbortMs,
            ...this.counters
        };
    }
}

module.exports = { ColdSnapshotQueue };
