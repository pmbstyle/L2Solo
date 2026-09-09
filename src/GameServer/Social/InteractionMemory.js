const Policy = require('./InteractionMemoryPolicy');
const EMPTY_VIEW = Policy.view(null);

// Main process owns persistence. Worker instances only accept versioned snapshots
// and evaluate: they cannot overwrite durable memory with their stale life state.
class InteractionMemory {
    constructor(repository = null) {
        this.repository = repository;
        this.snapshots = new Map();
        this.views = new Map();
        this.loading = new Map();
        this.pendingBatches = 0;
    }

    accept(snapshot) {
        Policy.validate(snapshot);
        const current = this.snapshots.get(snapshot.ownerId);
        if (current && current.revision >= snapshot.revision) return false;
        // Replay records stay in SQLite; decisions and IPC need only relations.
        const copy = JSON.parse(JSON.stringify({ version: snapshot.version, ownerId: snapshot.ownerId,
            revision: snapshot.revision, replayFloor: snapshot.replayFloor, readOnly: true,
            relations: snapshot.relations, recent: [] }));
        this.snapshots.set(copy.ownerId, copy);
        this.views.set(copy.ownerId, Policy.view(copy));
        return true;
    }

    async load(ownerId) {
        Policy.id(ownerId);
        if (!this.repository) throw new Error('interaction memory: worker cannot load SQL');
        if (!this.loading.has(ownerId)) {
            const pending = this.repository.load(ownerId).then(snapshot => {
                this.accept(snapshot);
                return this.snapshot(ownerId);
            }).finally(() => this.loading.delete(ownerId));
            this.loading.set(ownerId, pending);
        }
        return this.loading.get(ownerId);
    }

    async recordBatch(events) {
        if (!this.repository) throw new Error('interaction memory: worker must propose events');
        if (this.pendingBatches >= 8) return { ok: false, reason: 'memory_busy', snapshots: [] };
        this.pendingBatches++;
        try {
            const result = await this.repository.recordBatch(events);
            if (result.ok) result.snapshots.forEach(snapshot => this.accept(snapshot));
            return result.ok ? { ...result, snapshots: result.snapshots.map(snapshot => this.snapshot(snapshot.ownerId)) } : result;
        } finally {
            this.pendingBatches--;
        }
    }

    // Preparing a worker proposal has no side effects. The encounter coordinator
    // must couple these events to acceptance of its authoritative outcome.
    propose(events) {
        if (!Array.isArray(events) || !events.length || events.length > Policy.MAX_BATCH) {
            throw new Error('interaction memory: invalid batch');
        }
        return events.map(Policy.event);
    }

    snapshot(ownerId) {
        const snapshot = this.snapshots.get(ownerId);
        return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
    }

    assess(source, target, context = {}, now = Date.now()) {
        return Policy.assess(this.views.get(source.id) || EMPTY_VIEW, source, target, context, now);
    }

    forget(ownerId) {
        this.snapshots.delete(ownerId);
        this.views.delete(ownerId);
    }
}

module.exports = InteractionMemory;
