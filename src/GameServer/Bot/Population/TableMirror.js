'use strict';

const EMPTY_ROWS = new Map();

// Optional actors only. A private owner is table metadata, never actor facts.
const ACTOR_ATTACHMENTS = new WeakMap();
const ACTOR_OWNERS = new WeakMap();

// Common read prerequisite: ONLY private metadata/association can grant reads.
const ACTOR_READS = new WeakMap();
const NATIVE_ACTOR_MIRRORS = new WeakMap();

function actorViewUnknown() {
    const error = new TypeError('character_actor_view_unknown');
    Object.defineProperty(error, 'code', { value: 'CHARACTER_ACTOR_VIEW_UNKNOWN', enumerable: true });
    return error;
}

function initializeNativeActorMirror(mirror, options) {
    if (!options || (typeof options !== 'object' && typeof options !== 'function')) return;
    const field = Object.getOwnPropertyDescriptor(options, 'actorProjectorRole');
    if (!field) return;
    if (!Object.hasOwn(field, 'value')) throw new TypeError('invalid_native_actor_mirror_consent');
    const role = field.value;
    const Runtime = require('../../World/CharacterLocationRuntime');
    const { isMainThread, workerData } = require('worker_threads');
    const index = Runtime.index;
    const epoch = String(workerData?.workerEpoch || 'cold-worker');
    if (isMainThread || !Runtime.isWorkerProjectorRole(role, index)) {
        throw new TypeError('invalid_native_actor_mirror_consent');
    }
    const consent = Object.freeze({ mirror, index, role, epoch });
    const native = { consent, active: true, complete: true };
    NATIVE_ACTOR_MIRRORS.set(mirror, native);
    try {
        // Completed private branding precedes LAST synchronous registration.
        // Runtime independently authenticates it and keeps registration sticky.
        Runtime.registerNativeActorMirror(mirror);
    } catch (error) {
        native.active = false;
        native.complete = false;
        throw error;
    }
}

function nativeActorMirrorOwner(mirror) {
    const native = NATIVE_ACTOR_MIRRORS.get(mirror);
    if (!native?.active || !native.complete) return null;
    const Runtime = require('../../World/CharacterLocationRuntime');
    const { isMainThread, workerData } = require('worker_threads');
    const consent = native.consent;
    return !isMainThread && consent.mirror === mirror && consent.index === Runtime.index
        && consent.epoch === String(workerData?.workerEpoch || 'cold-worker')
        && Runtime.isWorkerProjectorRole(consent.role, consent.index) ? consent : null;
}

function retireNativeActorMirror(mirror) {
    const native = NATIVE_ACTOR_MIRRORS.get(mirror);
    if (native) native.active = false;
}

function invalidateActorReads(metadata) {
    metadata.occurrence = Object.freeze({});
}

function registeredActorBacking(owner, backing) {
    const Sources = require('../../World/CharacterActorSources');
    return typeof Sources.actorStoreMatches === 'function' && Sources.actorStoreMatches(owner, backing) === true;
}

function associatedActorIndex(metadata) {
    const Sources = require('../../World/CharacterActorSources');
    if (!registeredActorBacking(metadata.owner, metadata.backing)) return null;
    const index = typeof Sources.actorStoreIndex === 'function' ? Sources.actorStoreIndex(metadata.owner) : null;
    if (!index) return null;
    if (metadata.native) {
        const consent = nativeActorMirrorOwner(metadata.binding.mirror);
        const Runtime = require('../../World/CharacterLocationRuntime');
        if (consent !== metadata.native.consent || index !== consent?.index
            || Runtime.nativeActorMirror() !== metadata.binding.mirror) return null;
    }
    return index;
}

function actorReadState(owner) {
    const binding = actorStoreOwner(owner);
    const metadata = ACTOR_OWNERS.get(owner);
    const state = metadata?.state;
    if (!binding || !metadata.installed || metadata.applying !== 0 || state.version === null
        || state.waiting || state.loading || !state.cleanupComplete) return null;
    const index = associatedActorIndex(metadata);
    return index ? { metadata, state, index } : null;
}

function actorStoreRead(owner) {
    const current = actorReadState(owner);
    if (!current) throw actorViewUnknown();
    const receipt = Object.freeze({});
    ACTOR_READS.set(receipt, { owner, metadata: current.metadata, occurrence: current.metadata.occurrence,
        chain: current.state.chain, index: current.index });
    return receipt;
}

function actorStoreReadCurrent(owner, receipt) {
    const read = ACTOR_READS.get(receipt);
    if (!read || read.owner !== owner) return false;
    const current = actorReadState(owner);
    return !!current && current.metadata === read.metadata && current.index === read.index
        && current.metadata.occurrence === read.occurrence && current.state.chain === read.chain;
}

function requireActorReadCurrent(metadata, receipt) {
    if (!actorStoreReadCurrent(metadata.owner, receipt)) throw actorViewUnknown();
}

function actorBackingIterator(metadata, method, receipt) {
    const backing = metadata.backing;
    const original = Reflect.apply(backing[method], backing, []);
    requireActorReadCurrent(metadata, receipt);
    const iterator = {};
    for (const name of ['next', 'return', 'throw']) {
        if (typeof original[name] !== 'function') continue;
        const delegate = original[name];
        iterator[name] = function(...args) {
            requireActorReadCurrent(metadata, receipt);
            // A delegate exception stays original, including undefined/null/0.
            const result = Reflect.apply(delegate, original, args);
            requireActorReadCurrent(metadata, receipt);
            return result;
        };
    }
    if (typeof original[Symbol.iterator] === 'function') {
        iterator[Symbol.iterator] = function() { return this; };
    }
    return Object.freeze(iterator);
}

function actorRowsFacade(metadata) {
    const readValue = (method, args) => {
        const receipt = actorStoreRead(metadata.owner);
        const result = Reflect.apply(metadata.backing[method], metadata.backing, args);
        requireActorReadCurrent(metadata, receipt);
        return result;
    };
    const iterate = method => {
        const receipt = actorStoreRead(metadata.owner);
        return actorBackingIterator(metadata, method, receipt);
    };
    const facade = {
        get(id) { return readValue('get', [id]); },
        has(id) { return readValue('has', [id]); },
        get size() {
            const receipt = actorStoreRead(metadata.owner);
            const result = metadata.backing.size;
            requireActorReadCurrent(metadata, receipt);
            return result;
        },
        keys() { return iterate('keys'); },
        values() { return iterate('values'); },
        entries() { return iterate('entries'); },
        [Symbol.iterator]() { return iterate('entries'); },
        forEach(callback, thisArg) {
            if (typeof callback !== 'function') throw new TypeError('invalid_actor_rows_callback');
            const receipt = actorStoreRead(metadata.owner);
            const iterator = actorBackingIterator(metadata, 'entries', receipt);
            for (;;) {
                const next = iterator.next();
                if (next.done) break;
                Reflect.apply(callback, thisArg, [next.value[1], next.value[0], facade]);
                requireActorReadCurrent(metadata, receipt);
            }
            requireActorReadCurrent(metadata, receipt);
        }
    };
    return Object.freeze(facade);
}

function actorDescriptor(metadata) {
    const descriptor = {};
    for (const name of ['version', 'waiting', 'loading', 'cleanupComplete', 'chain']) {
        Object.defineProperty(descriptor, name, { enumerable: true, get: () => metadata.state[name] });
    }
    Object.defineProperties(descriptor, {
        rows: { enumerable: true, get: () => metadata.facade },
        applyInProgress: { enumerable: true, get: () => metadata.applying !== 0 },
        readOccurrence: { enumerable: true, get: () => metadata.occurrence }
    });
    return Object.freeze(descriptor);
}


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
    constructor(options) {
        this.tables = new Map();
        this.listeners = new Map();
        initializeNativeActorMirror(this, options);
    }

    // listener: { reset(), put(key, row), remove(key) }, called as pieces apply.
    watch(name, listener) {
        this.listeners.set(String(name), listener);
    }

    // pieces: [{ name, from, to, full, last, rows: [[key, row]], removed: [key] }].
    // Returns the names of the tables to ask for in full.
    apply(pieces = []) {
        if (ACTOR_ATTACHMENTS.has(this)) return this.applyWithActorStore(pieces);
        if (NATIVE_ACTOR_MIRRORS.has(this) && Array.isArray(pieces)
            && pieces.some(piece => String(piece?.name) === 'actors')) {
            // A native actor cut cannot fall through to a second ordinary Map.
            throw new TypeError('missing_native_actor_store');
        }
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
        const owner = Object.freeze({});
        const metadata = { owner, active: true, installed: false, applying: 0, backing: null,
            state: { version: null, waiting: false, loading: true, cleanupComplete: false, chain: null },
            native: NATIVE_ACTOR_MIRRORS.get(this) ?? null };
        invalidateActorReads(metadata);
        metadata.facade = actorRowsFacade(metadata);
        const descriptor = actorDescriptor(metadata);
        const binding = Object.freeze({ mirror: this, name, descriptor });
        metadata.binding = binding;
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
                || actorStoreOwner(owner) !== binding || !registeredActorBacking(owner, store)) {
                throw new TypeError('invalid_actor_store');
            }
            metadata.backing = store;
            metadata.installed = true;
            return owner;
        } catch (error) {
            metadata.active = false;
            invalidateActorReads(metadata);
            retireNativeActorMirror(this);
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
        invalidateActorReads(metadata);
        retireNativeActorMirror(this);
        const descriptor = metadata.binding.descriptor;
        if (this.tables.get(name) === descriptor) this.tables.delete(name);
        if (metadata.installed) metadata.backing.dispose();
        return true;
    }

    actorGap(metadata, resync) {
        if (!metadata.state.waiting) resync.push('actors');
        metadata.state.waiting = true;
        invalidateActorReads(metadata);
    }

    // Fresh occurrence is private even when diagnostics show the SAME chain.
    // Native Index/Runtime arm and private store port remain Root/A prerequisites.
    applyWithActorStore(pieces) {
        const metadata = ACTOR_ATTACHMENTS.get(this);
        if (!Array.isArray(pieces)) throw new TypeError('invalid_actor_table_pieces');
        // Native actor dispatch has ONE piece. This Array header prepass is
        // O(number of message pieces), not a promised universal 64-header cap.
        const containsActors = pieces.some(piece => String(piece?.name) === 'actors');
        if (!containsActors) return applyOrdinaryPieces.call(this, pieces);
        const resync = [];
        invalidateActorReads(metadata);
        metadata.applying++;
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
            this.actorGap(metadata, resync);
            throw error;
        } finally {
            metadata.applying--;
        }
    }

    applyActorPiece(piece, metadata, resync) {
        const table = metadata.state;
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
            if (!accepted) { this.actorGap(metadata, resync); return; }
            table.chain = chain;
            table.version = piece.to;
            table.loading = true;
            if (full) {
                table.waiting = false;
                table.cleanupComplete = false;
                const report = actorScalarReport(metadata.backing.beginCopy(chain), 0);
                if (actorStoreOwner(metadata.owner) !== metadata.binding || table.chain !== chain) {
                    throw new TypeError('changed_actor_store_copy');
                }
                table.cleanupComplete = report.done;
                this.listeners.get('actors')?.reset();
            }
            const current = () => actorStoreOwner(metadata.owner) === metadata.binding && table.chain === chain;
            if (!current()) throw new TypeError('changed_actor_store_chain');
            for (const [id, row] of piece.rows) {
                actorStoreBoolean(metadata.backing.put(id, row, chain));
                if (!current()) throw new TypeError('changed_actor_store_chain');
                this.listeners.get('actors')?.put(id, row);
                if (!current()) throw new TypeError('changed_actor_store_chain');
            }
            for (const absence of piece.removed) {
                actorStoreBoolean(metadata.backing.remove(absence.id, absence, chain));
                if (!current()) throw new TypeError('changed_actor_store_chain');
                this.listeners.get('actors')?.remove(absence.id);
                if (!current()) throw new TypeError('changed_actor_store_chain');
            }
            if (piece.last === 1) table.loading = false;
        } catch (error) {
            this.actorGap(metadata, resync);
            throw error;
        }
    }

    cleanupStore(name, limit) {
        const metadata = ACTOR_ATTACHMENTS.get(this);
        if (name !== 'actors' || !metadata?.installed || actorStoreOwner(metadata.owner) !== metadata.binding) {
            throw new TypeError('invalid_actor_store_attachment');
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError('invalid_actor_store_cleanup_limit');
        const table = metadata.state;
        if (table.waiting || table.loading || metadata.applying !== 0 || !table.chain) return { inspected: 0, done: false };
        const copy = table.chain;
        const report = actorScalarReport(metadata.backing.cleanup(limit), limit);
        if (actorStoreOwner(metadata.owner) !== metadata.binding || !sameActorCopy(table.chain, copy)
            || table.waiting || table.loading || metadata.applying !== 0) throw new TypeError('changed_actor_store_cleanup');
        table.cleanupComplete = report.done;
        return report;
    }

    // Whether a table is held whole (its full copy arrived and is current).
    ready(name) {
        const table = this.tables.get(String(name));
        if (String(name) === 'actors' && (ACTOR_ATTACHMENTS.has(this) || NATIVE_ACTOR_MIRRORS.has(this))) {
            const metadata = ACTOR_ATTACHMENTS.get(this);
            return !!metadata && !!actorReadState(metadata.owner);
        }
        return !!table && table.version !== null && !table.waiting && !table.loading;
    }

    // The rows of one table by key (empty until its first full copy, and
    // while a full copy is loading).
    rows(name) {
        const table = this.tables.get(String(name));
        if (String(name) === 'actors' && (ACTOR_ATTACHMENTS.has(this) || NATIVE_ACTOR_MIRRORS.has(this))) {
            const metadata = ACTOR_ATTACHMENTS.get(this);
            if (!metadata) throw actorViewUnknown();
            return metadata.facade;
        }
        return table && !table.loading ? table.rows : EMPTY_ROWS;
    }

    version(name) {
        return this.tables.get(String(name))?.version ?? null;
    }

    summary() {
        const result = {};
        for (const [name, table] of this.tables) {
            if (name === 'actors' && (ACTOR_ATTACHMENTS.has(this) || NATIVE_ACTOR_MIRRORS.has(this))) {
                const ready = this.ready(name);
                result[name] = { version: table.version, rows: ready ? table.rows.size : null, ready,
                    waiting: table.waiting, loading: table.loading, cleanupComplete: table.cleanupComplete };
                continue;
            }
            result[name] = { version: table.version, rows: table.rows.size, waiting: table.waiting, loading: table.loading };
        }
        return result;
    }
}

Object.defineProperties(TableMirror, {
    actorStoreOwner: { value: actorStoreOwner },
    actorStoreRead: { value: actorStoreRead },
    actorStoreReadCurrent: { value: actorStoreReadCurrent },
    nativeActorMirrorOwner: { value: nativeActorMirrorOwner }
});
module.exports = TableMirror;
