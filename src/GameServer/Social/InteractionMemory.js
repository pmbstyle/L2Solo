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
        this.clanSocial = null;
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
        await this.loading.get(ownerId);
        return this.snapshot(ownerId);
    }

    async ensureMany(ownerIds) {
        if (!this.repository) throw new Error('interaction memory: worker cannot load SQL');
        const ids = [...new Set(ownerIds.map(Policy.id))];
        for (let offset = 0; offset < ids.length; offset += Policy.MAX_BATCH) {
            const page = ids.slice(offset, offset + Policy.MAX_BATCH);
            const waiting = page.map(id => this.loading.get(id)).filter(Boolean);
            const missing = page.filter(id => !this.views.has(id) && !this.loading.has(id));
            if (missing.length) {
                const pending = this.repository.loadMany(missing).then(snapshots => {
                    snapshots.forEach(snapshot => this.accept(snapshot));
                }).finally(() => {
                    for (const id of missing) if (this.loading.get(id) === pending) this.loading.delete(id);
                });
                for (const id of missing) this.loading.set(id, pending);
                waiting.push(pending);
            }
            await Promise.all(waiting);
            if (offset + Policy.MAX_BATCH < ids.length) await new Promise(resolve => setImmediate(resolve));
        }
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
        if (this.clanSocial) {
            source = this.clanSocial.identity(source);
            target = this.clanSocial.identity(target);
        }
        const result = Policy.assess(this.views.get(source.id) || EMPTY_VIEW, source, target, context, now);
        result.sourceClanId = Number(source.clanId || 0);
        result.targetClanId = Number(target.clanId || 0);
        if (this.clanSocial) {
            result.clanSocial = this.clanSocial.assess(source, target, result.personal, now, result.clan);
            result.effective = result.clanSocial.effective;
        }
        return result;
    }

    inspect(ownerId, now = Date.now()) {
        const snapshot = this.snapshots.get(ownerId);
        const view = this.views.get(ownerId);
        return { ready: !!snapshot, revision: snapshot?.revision || 0,
            relations: (snapshot?.relations || []).map(row => ({ kind: row.kind, targetId: row.targetId,
                at: row.at, ageMs: Math.max(0, now - row.at), ...view.relation(row.kind, row.targetId, now) })) };
    }

    forget(ownerId) {
        this.snapshots.delete(ownerId);
        this.views.delete(ownerId);
    }
}

module.exports = InteractionMemory;
