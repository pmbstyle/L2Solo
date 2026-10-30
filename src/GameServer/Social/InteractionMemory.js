const Policy = require('./InteractionMemoryPolicy');
const PackedRows = require('./PackedInteractionRows');
const EMPTY_VIEW = Policy.view(null);

// A row's social counts as a fresh object (the packed row lends its stored one).
function counts(row) {
    return row?.social ? { ...row.social } : {};
}

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
        this.fastLayers = new Map();
        this.playingHours = () => undefined;
        // Called with the owner id after each accepted snapshot (main's
        // runtime publishes it; a worker instance keeps none).
        this.onAccept = null;
    }

    accept(snapshot) {
        Policy.validate(snapshot);
        const current = this.snapshots.get(snapshot.ownerId);
        if (current && current.revision >= snapshot.revision) return false;
        if (snapshot.appliedEvents?.length) {
            if (!this.fastLayers.has(snapshot.ownerId)) this.fastLayers.set(snapshot.ownerId, new Map());
            const rows = this.fastLayers.get(snapshot.ownerId);
            for (const raw of snapshot.appliedEvents) {
                const event = Policy.event(raw), key = `${event.kind}:${event.targetId}`;
                rows.set(key, require('./RelationshipLayers').fast(rows.get(key), event));
            }
        }
        // Replay records stay in SQLite; decisions and IPC need only relations.
        // ARCH-NOTE: snapshots and views share one private numeric/reason store.
        // Public snapshots decode fresh plain rows; unusual reason shapes keep
        // the old JSON clone as a lossless fallback. No wire or SQL shape changes.
        // PERF: 54,046 native rows retained 14.54 MB including numeric backing,
        // versus 33.93 MB before, measured before help clocks and traits became
        // columns and the worker dropped social counts (not re-measured).
        // Main's copy (the one with the repository) exports snapshots exactly
        // as accepted; the worker's copy keeps no per-type social counts, so
        // only main's snapshots and socialCounts() carry them. Views carry no
        // social counts on either thread: every decision answers the same.
        const copy = new PackedRows(snapshot, { keepSocial: !!this.repository });
        if (snapshot.fast) this.fastLayers.set(copy.ownerId, new Map(snapshot.fast));
        this.snapshots.set(copy.ownerId, copy);
        this.views.set(copy.ownerId, Policy.view(copy, () => this.playingHours(copy.ownerId), this.fastLayers.get(copy.ownerId), copy));
        this.onAccept?.(copy.ownerId);
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
            if (result.ok) {
                this.acceptCommitted(result, events);
            }
            return result.ok ? { ...result, snapshots: result.snapshots.map(snapshot => this.snapshot(snapshot.ownerId)) } : result;
        } finally {
            this.pendingBatches--;
        }
    }

    acceptCommitted(result, events = []) {
        events.forEach((event, i) => {
            if (result.statuses?.[i] !== 'applied') return;
            if (!this.fastLayers.has(event.sourceId)) this.fastLayers.set(event.sourceId, new Map());
            const rows = this.fastLayers.get(event.sourceId), key = `${event.kind || 'character'}:${event.targetId}`;
            rows.set(key, require('./RelationshipLayers').fast(rows.get(key), event));
        });
        for (const snapshot of result.snapshots || result.memorySnapshots || []) {
            const rows = this.fastLayers.get(snapshot.ownerId);
            if (rows) {
                const kept = new Set(snapshot.relations.map(row => `${row.kind}:${row.targetId}`));
                for (const key of rows.keys()) if (!kept.has(key)) rows.delete(key);
            }
            this.accept(snapshot);
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
        if (!snapshot) return null;
        const copy = snapshot.plain();
        if (this.fastLayers.has(ownerId)) copy.fast = JSON.parse(JSON.stringify([...this.fastLayers.get(ownerId)]));
        return copy;
    }

    // The accepted snapshot's relation rows and revision, read-only (a row of
    // an unusual shape is the kept one), without the deep copy snapshot() makes.
    relationRows(ownerId) {
        const snapshot = this.snapshots.get(ownerId);
        return snapshot ? { revision: snapshot.revision, relations: snapshot.mapRows(row => row) } : null;
    }

    // The owner's per-type social event counts toward a character (a fresh
    // object). Main only: the worker's copy keeps none and answers {}.
    socialCounts(ownerId, targetId) {
        return counts(this.snapshots.get(ownerId)?.row('character', targetId));
    }

    // The accepted snapshot's revision, without the deep copy snapshot() makes.
    revision(ownerId) {
        return this.snapshots.get(ownerId)?.revision;
    }

    // Derived in the existing packing pass. Order is a native input: the
    // economy reads the first matching relation, including player rows.
    contentIdentity(ownerId) {
        return this.snapshots.get(ownerId)?.contentIdentity ?? null;
    }

    assess(source, target, context = {}, now = Date.now()) {
        if (this.clanSocial) {
            source = this.clanSocial.identity(source);
            target = this.clanSocial.identity(target);
        }
        const result = Policy.assess(this.views.get(source.id) || EMPTY_VIEW, source, target, context, now);
        result.sourceClanId = Number(source.clanId || 0);
        result.targetClanId = Number(target.clanId || 0);
        if (this.clanWars) {
            result.war = this.clanWars.between(result.sourceClanId, result.targetClanId);
            result.diplomaticEnemy = result.diplomaticEnemy || result.war.mutual;
        }
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
            relations: snapshot ? snapshot.mapRows(row => ({ kind: row.kind, targetId: row.targetId,
                at: row.at, ageMs: Math.max(0, now - row.at), ...view.relation(row.kind, row.targetId, now),
                ...(row.social ? { social: counts(row) } : {}) })) : [] };
    }

    forget(ownerId) {
        this.snapshots.delete(ownerId);
        this.views.delete(ownerId);
        this.fastLayers.delete(ownerId);
    }

    size() {
        return { snapshots: this.snapshots.size, views: this.views.size,
            fastLayers: this.fastLayers.size, loading: this.loading.size };
    }
}

module.exports = InteractionMemory;
