'use strict';

const EMPTY_ROWS = new Map();

// Optional actors only. A private owner is table metadata, never actor facts.
const ACTOR_ATTACHMENTS = new WeakMap();
const ACTOR_OWNERS = new WeakMap();

function actorStoreOwner(owner) {
    const metadata = ACTOR_OWNERS.get(owner);
    return metadata?.active && ACTOR_ATTACHMENTS.get(metadata.binding.mirror) === metadata
        && metadata.binding.mirror.tables.get('actors') === metadata.binding.descriptor
        ? metadata.binding : null;
}

function sameActorCopy(a, b) {
    return !!a && !!b && a.attachmentId === b.attachmentId && a.copyId === b.copyId
        && a.worldGeneration === b.worldGeneration;
}

function actorScalarReport(report, limit) {
    if (report instanceof Promise) Promise.prototype.then.call(report, () => null, () => null);
    if (!report || typeof report !== 'object' || !Number.isSafeInteger(report.inspected)
        || report.inspected < 0 || report.inspected > limit || typeof report.done !== 'boolean') {
        throw new TypeError('invalid_actor_store_cleanup_report');
    }
    return report;
}

function actorStoreBoolean(value) {
    if (value instanceof Promise) Promise.prototype.then.call(value, () => null, () => null);
    if (typeof value !== 'boolean') throw new TypeError('invalid_actor_store_result');
    return value;
}

function actorHeader(piece) {
    if (!piece || typeof piece !== 'object' || !Array.isArray(piece.rows) || !Array.isArray(piece.removed)
        || piece.rows.length + piece.removed.length > 64 || typeof piece.full !== 'boolean'
        || (piece.last !== 0 && piece.last !== 1) || !Number.isSafeInteger(piece.to) || piece.to < 0
        || (piece.from !== null && (!Number.isSafeInteger(piece.from) || piece.from < 0))) {
        throw new TypeError('invalid_actor_table_piece');
    }
    const chain = {};
    for (const name of ['attachmentId', 'copyId', 'transferId', 'worldGeneration']) {
        if (!Number.isSafeInteger(piece[name]) || piece[name] <= 0) throw new TypeError('invalid_actor_table_chain');
        chain[name] = piece[name];
    }
    if (!Number.isSafeInteger(piece.pageIndex) || piece.pageIndex < 0) throw new TypeError('invalid_actor_table_chain');
    chain.pageIndex = piece.pageIndex;
    for (const pair of piece.rows) {
        if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || pair[0] <= 0) {
            throw new TypeError('invalid_actor_table_row');
        }
    }
    return Object.freeze(chain);
}

function applyOrdinaryPieces(pieces = []) {
        const resync = [];
        for (const piece of pieces) {
            const name = String(piece.name);
            const listener = this.listeners.get(name);
            let table = this.tables.get(name);
            if (piece.full) {
                table = { version: piece.to, rows: new Map(), waiting: false, loading: piece.last === 0 };
                this.tables.set(name, table);
                listener?.reset();
            } else if (!table || table.waiting || table.version !== piece.from
                || (table.loading && piece.from !== piece.to)) {
                // A change on a table not held, or on a full copy that never
                // finished, is a gap too.
                if (!table) {
                    table = { version: null, rows: new Map(), waiting: false, loading: false };
                    this.tables.set(name, table);
                }
                if (!table.waiting) resync.push(name);
                table.waiting = true;
                continue;
            }
            for (const [key, row] of piece.rows || []) {
                table.rows.set(key, row);
                listener?.put(key, row);
            }
            for (const key of piece.removed || []) {
                table.rows.delete(key);
                listener?.remove(key);
            }
            table.version = piece.to;
            if (piece.last === 1) table.loading = false;
        }
        return resync;
    }



// A worker's copy of the tables the main thread sends through
// ColdTableChannel. Each table has a version; a change applies only on top
// of the version it was made from. A missing version (a gap) is not patched:
// the mirror drops later changes of that table and asks the main thread for
// the whole table once (table_resync). A full copy cut across pages is
// loading until its final piece (`last: 1`): until then the table reads as
// empty, never as a part taken for the whole. A listener (watch) follows one
// table's rows as they change. Shared by the cold worker and the clan
// planning worker.
class TableMirror {
    constructor() {
        this.tables = new Map();
        this.listeners = new Map();
    }

    // listener: { reset(), put(key, row), remove(key) }, called as pieces apply.
    watch(name, listener) {
        this.listeners.set(String(name), listener);
    }

    // pieces: [{ name, from, to, full, last, rows: [[key, row]], removed: [key] }].
    // Returns the names of the tables to ask for in full.
    apply(pieces = []) {
        if (ACTOR_ATTACHMENTS.has(this)) return this.applyWithActorStore(pieces);
        const resync = [];
        for (const piece of pieces) {
            const name = String(piece.name);
            const listener = this.listeners.get(name);
            let table = this.tables.get(name);
            if (piece.full) {
                table = { version: piece.to, rows: new Map(), waiting: false, loading: piece.last === 0 };
                this.tables.set(name, table);
                listener?.reset();
            } else if (!table || table.waiting || table.version !== piece.from
                || (table.loading && piece.from !== piece.to)) {
                // A change on a table not held, or on a full copy that never
                // finished, is a gap too.
                if (!table) {
                    table = { version: null, rows: new Map(), waiting: false, loading: false };
                    this.tables.set(name, table);
                }
                if (!table.waiting) resync.push(name);
                table.waiting = true;
                continue;
            }
            for (const [key, row] of piece.rows || []) {
                table.rows.set(key, row);
                listener?.put(key, row);
            }
            for (const key of piece.removed || []) {
                table.rows.delete(key);
                listener?.remove(key);
            }
            table.version = piece.to;
            if (piece.last === 1) table.loading = false;
        }
        return resync;
    }

    // Attach once, before the first actor piece. Factory ownership is private;
    // standalone backing is a pure contract, not Native read authorization.
    attachStore(name, createStore) {
        if (name !== 'actors' || typeof createStore !== 'function'
            || ACTOR_ATTACHMENTS.has(this) || this.tables.has(name)) {
            throw new TypeError('invalid_actor_store_attachment');
        }
        const descriptor = { version: null, rows: EMPTY_ROWS, waiting: false, loading: true,
            applyInProgress: false, cleanupComplete: false, chain: null };
        const owner = Object.freeze({});
        const binding = Object.freeze({ mirror: this, name, descriptor });
        const metadata = { owner, binding, active: true, installed: false, applying: 0 };
        ACTOR_OWNERS.set(owner, metadata);
        ACTOR_ATTACHMENTS.set(this, metadata);
        this.tables.set(name, descriptor);
        let store;
        try {
            store = createStore(owner, descriptor);
            if (store instanceof Promise) Promise.prototype.then.call(store, () => null, () => null);
            if (!store || typeof store !== 'object'
                || !['beginCopy', 'put', 'remove', 'cleanup', 'get', 'entries', 'dispose']
                    .every(method => typeof store[method] === 'function')
                || actorStoreOwner(owner) !== binding) {
                throw new TypeError('invalid_actor_store');
            }
            descriptor.rows = store;
            metadata.installed = true;
            return owner;
        } catch (error) {
            metadata.active = false;
            if (this.tables.get(name) === descriptor) this.tables.delete(name);
            // A factory owns allocations it never returned. Only this exact
            // returned object can be disposed by the failed installation.
            try { if (store && typeof store.dispose === 'function') store.dispose(); }
            catch { /* Preserve original factory/installation failure. */ }
            throw error;
        }
    }

    detachStore(name) {
        const metadata = ACTOR_ATTACHMENTS.get(this);
        if (name !== 'actors' || !metadata?.active) return false;
        metadata.active = false;
        const descriptor = metadata.binding.descriptor;
        if (this.tables.get(name) === descriptor) this.tables.delete(name);
        if (metadata.installed) descriptor.rows.dispose();
        return true;
    }

    actorGap(table, resync) {
        if (!table.waiting) resync.push('actors');
        table.waiting = true;
    }

    // PENDING common-read prerequisite (not an authorization API here): mint
    // one private fresh read occurrence on EVERY actor-containing entry,
    // before prefix watchers; depth already keeps nested outer apply unknown.
    // Root owns exact read receipt/Index-port wiring and must approve it before
    // any Native attachment/advertised reader. chain alone does not fence ABA.
    applyWithActorStore(pieces) {
        const metadata = ACTOR_ATTACHMENTS.get(this);
        const table = metadata.binding.descriptor;
        if (!Array.isArray(pieces)) throw new TypeError('invalid_actor_table_pieces');
        // Native actor dispatch has ONE piece. This Array header prepass is
        // O(number of message pieces), not a promised universal 64-header cap.
        const containsActors = pieces.some(piece => String(piece.name) === 'actors');
        if (!containsActors) return applyOrdinaryPieces.call(this, pieces);
        const resync = [];
        metadata.applying++;
        table.applyInProgress = true;
        try {
            for (const piece of pieces) {
                if (String(piece.name) !== 'actors') {
                    resync.push(...applyOrdinaryPieces.call(this, [piece]));
                    continue;
                }
                if (!metadata.installed || actorStoreOwner(metadata.owner) !== metadata.binding) {
                    throw new TypeError('stale_actor_store_attachment');
                }
                this.applyActorPiece(piece, metadata, resync);
            }
            return resync;
        } catch (error) {
            // A prefix watcher can fail before the actor piece is reached.
            // Keep the whole actor-containing apply unknown, with SAME error.
            this.actorGap(table, resync);
            throw error;
        } finally {
            metadata.applying--;
            table.applyInProgress = metadata.applying !== 0;
        }
    }

    applyActorPiece(piece, metadata, resync) {
        const table = metadata.binding.descriptor;
        const previous = table.chain;
        try {
            const chain = actorHeader(piece);
            const head = chain.pageIndex === 0;
            const full = piece.full === true;
            let accepted;
            if (full) {
                accepted = head && piece.from === null && (table.version === null || piece.to >= table.version)
                    && (!previous || (chain.attachmentId >= previous.attachmentId
                        && chain.copyId > previous.copyId && chain.transferId > previous.transferId
                        && chain.worldGeneration >= previous.worldGeneration));
            } else if (head) {
                accepted = !!previous && !table.waiting && !table.loading && sameActorCopy(previous, chain)
                    && chain.transferId > previous.transferId && piece.from === table.version
                    && piece.to === piece.from + 1;
            } else {
                accepted = !!previous && !table.waiting && table.loading && sameActorCopy(previous, chain)
                    && chain.transferId === previous.transferId && chain.pageIndex === previous.pageIndex + 1
                    && piece.from === table.version && piece.to === table.version;
            }
            if (!accepted) { this.actorGap(table, resync); return; }
            table.chain = chain;
            table.version = piece.to;
            table.loading = true;
            if (full) {
                table.waiting = false;
                table.cleanupComplete = false;
                const report = actorScalarReport(table.rows.beginCopy(chain), 0);
                if (actorStoreOwner(metadata.owner) !== metadata.binding || table.chain !== chain) {
                    throw new TypeError('changed_actor_store_copy');
                }
                table.cleanupComplete = report.done;
                this.listeners.get('actors')?.reset();
            }
            const current = () => actorStoreOwner(metadata.owner) === metadata.binding && table.chain === chain;
            if (!current()) throw new TypeError('changed_actor_store_chain');
            for (const [id, row] of piece.rows) {
                actorStoreBoolean(table.rows.put(id, row, chain));
                if (!current()) throw new TypeError('changed_actor_store_chain');
                this.listeners.get('actors')?.put(id, row);
                if (!current()) throw new TypeError('changed_actor_store_chain');
            }
            for (const absence of piece.removed) {
                actorStoreBoolean(table.rows.remove(absence.id, absence, chain));
                if (!current()) throw new TypeError('changed_actor_store_chain');
                this.listeners.get('actors')?.remove(absence.id);
                if (!current()) throw new TypeError('changed_actor_store_chain');
            }
            if (piece.last === 1) table.loading = false;
        } catch (error) {
            this.actorGap(table, resync);
            throw error;
        }
    }

    cleanupStore(name, limit) {
        const metadata = ACTOR_ATTACHMENTS.get(this);
        if (name !== 'actors' || !metadata?.installed || actorStoreOwner(metadata.owner) !== metadata.binding) {
            throw new TypeError('invalid_actor_store_attachment');
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError('invalid_actor_store_cleanup_limit');
        const table = metadata.binding.descriptor;
        if (table.waiting || table.loading || table.applyInProgress || !table.chain) return { inspected: 0, done: false };
        const copy = table.chain;
        const report = actorScalarReport(table.rows.cleanup(limit), limit);
        if (actorStoreOwner(metadata.owner) !== metadata.binding || !sameActorCopy(table.chain, copy)
            || table.waiting || table.loading || table.applyInProgress) throw new TypeError('changed_actor_store_cleanup');
        table.cleanupComplete = report.done;
        return report;
    }

    // Whether a table is held whole (its full copy arrived and is current).
    ready(name) {
        const table = this.tables.get(String(name));
        if (String(name) === 'actors' && ACTOR_ATTACHMENTS.has(this)) {
            const metadata = ACTOR_ATTACHMENTS.get(this);
            return !!actorStoreOwner(metadata.owner) && metadata.installed
                && table.version !== null && !table.waiting && !table.loading
                && !table.applyInProgress && table.cleanupComplete;
        }
        return !!table && table.version !== null && !table.waiting && !table.loading;
    }

    // The rows of one table by key (empty until its first full copy, and
    // while a full copy is loading).
    rows(name) {
        const table = this.tables.get(String(name));
        if (String(name) === 'actors' && ACTOR_ATTACHMENTS.has(this)) return this.ready(name) ? table.rows : EMPTY_ROWS;
        return table && !table.loading ? table.rows : EMPTY_ROWS;
    }

    version(name) {
        return this.tables.get(String(name))?.version ?? null;
    }

    summary() {
        const result = {};
        for (const [name, table] of this.tables) {
            if (name === 'actors' && ACTOR_ATTACHMENTS.has(this)) {
                result[name] = { version: table.version, rows: this.ready(name) ? table.rows.size : 0,
                    waiting: table.waiting, loading: table.loading, cleanupComplete: table.cleanupComplete };
                continue;
            }
            result[name] = { version: table.version, rows: table.rows.size, waiting: table.waiting, loading: table.loading };
        }
        return result;
    }
}

Object.defineProperty(TableMirror, 'actorStoreOwner', { value: actorStoreOwner });
module.exports = TableMirror;
