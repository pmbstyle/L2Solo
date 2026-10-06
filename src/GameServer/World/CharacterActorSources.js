'use strict';

const { isMainThread, workerData } = require('worker_threads');
const nativeEpoch = String(workerData?.workerEpoch || 'cold-worker');
const actorStores = new WeakMap();
let nativeAttempted = false;

// Shared passive backing for isolated stores and the authentic native Worker.
const CharacterLocationIndex = require('./CharacterLocationIndex');
const TableMirror = require('../Bot/Population/TableMirror');
const { MAX_BATCH, MAX_MESSAGE_BYTES } = require('../Bot/Population/ColdSimulationProtocol');
const COPY = Symbol('actor-copy-membership');
const ROW_FIELDS = ['id', 'worldGeneration', 'sourceGeneration', 'publication', 'order', 'axes'];
const VALUE_TAGS = new Set(['number', 'string', 'boolean']);
const EMPTY_TAGS = new Set(['null', 'undefined', 'nonfinite', 'unsupported']);

function objectFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('invalid_passive_actor_object');
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('invalid_passive_actor_object');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
        throw new TypeError('invalid_passive_actor_fields');
    }
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid_passive_actor_field');
    }
    return value;
}

function positive(value) { return Number.isSafeInteger(value) && value > 0; }

function axis(tag) {
    const type = Object.getOwnPropertyDescriptor(tag ?? {}, 'tag');
    if (!type || !Object.hasOwn(type, 'value') || typeof type.value !== 'string') {
        throw new TypeError('invalid_passive_actor_axis');
    }
    if (VALUE_TAGS.has(type.value)) {
        objectFields(tag, ['tag', 'value']);
        const value = tag.value;
        if (type.value === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
            throw new TypeError('invalid_passive_actor_number');
        }
        if (type.value === 'string' && (typeof value !== 'string'
            || Buffer.byteLength(value, 'utf8') > MAX_MESSAGE_BYTES)) {
            throw new TypeError('invalid_passive_actor_string');
        }
        if (type.value === 'boolean' && typeof value !== 'boolean') {
            throw new TypeError('invalid_passive_actor_boolean');
        }
        return Number(value);
    }
    if (!EMPTY_TAGS.has(type.value)) throw new TypeError('invalid_passive_actor_axis');
    objectFields(tag, ['tag']);
    return type.value === 'null' ? 0 : null;
}

function rowPoint(row) {
    const x = axis(row.axes.x), y = axis(row.axes.y);
    return x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)
        ? { locX: x, locY: y } : null;
}

function validateRow(id, row, worldGeneration) {
    objectFields(row, ROW_FIELDS);
    if (!positive(id) || row.id !== id || !positive(row.worldGeneration)
        || row.worldGeneration !== worldGeneration || !positive(row.sourceGeneration)
        || !positive(row.publication) || row.sourceGeneration > row.publication || !positive(row.order)) {
        throw new TypeError('invalid_passive_actor_row');
    }
    objectFields(row.axes, ['x', 'y', 'z']);
    axis(row.axes.x); axis(row.axes.y); axis(row.axes.z);
    return rowPoint(row);
}

function ownerBinding(owner, descriptor) {
    if (typeof TableMirror.actorStoreOwner !== 'function') {
        throw new TypeError('actor_store_owner_unavailable');
    }
    const binding = TableMirror.actorStoreOwner(owner);
    if (!binding || binding.name !== 'actors' || binding.descriptor !== descriptor
        || binding.mirror.tables.get('actors') !== descriptor) {
        throw new TypeError('invalid_actor_store_owner');
    }
    return binding;
}

function makeStore(index, owner, descriptor, binding, readers = index) {
    if (actorStores.has(owner)) throw new TypeError('actor_store_already_registered');
    if (ownerBinding(owner, descriptor) !== binding) throw new TypeError('changed_actor_store_owner');
    let disposed = false;
    let copy = null;
    let sweep = null;
    const active = () => {
        if (disposed || ownerBinding(owner, descriptor) !== binding) throw new TypeError('stale_actor_store_owner');
    };
    const chainOf = (chain) => {
        active();
        if (!chain || chain !== descriptor.chain || !positive(chain.attachmentId)
            || !positive(chain.copyId) || !positive(chain.transferId)
            || !Number.isSafeInteger(chain.pageIndex) || chain.pageIndex < 0
            || !positive(chain.worldGeneration)) throw new TypeError('stale_actor_store_chain');
        return chain;
    };
    const sameCopy = (chain) => !!copy && chain.attachmentId === copy.attachmentId
        && chain.copyId === copy.copyId && chain.worldGeneration === copy.worldGeneration;
    const currentChain = (chain) => {
        chainOf(chain);
        if (!sameCopy(chain)) throw new TypeError('stale_actor_store_copy');
    };
    const recordOf = (id) => {
        const record = readers.getSource(id, 'actor');
        if (record && record[COPY]?.owner !== owner) throw new TypeError('foreign_actor_store_source');
        return record;
    };
    const records = () => {
        active();
        const original = readers.sourceEntries('actor');
        return {
            next() {
                active();
                const item = original.next();
                active();
                if (!item.done && item.value[1][COPY]?.owner !== owner) {
                    throw new TypeError('foreign_actor_store_source');
                }
                return item;
            },
            [Symbol.iterator]() { return this; }
        };
    };
    const entries = () => {
        const original = records();
        return {
            next() {
                const item = original.next();
                return item.done ? item : { done: false, value: [item.value[0], item.value[1].source] };
            },
            [Symbol.iterator]() { return this; }
        };
    };
    const store = {
        beginCopy(chain) {
            chainOf(chain);
            if (sameCopy(chain)) throw new TypeError('duplicate_actor_store_copy');
            // O(1), before any current-copy rows. No reset/clear/enable-all scan.
            const remaining = readers.sourceSize('actor');
            const iterator = readers.sourceEntries('actor');
            copy = Object.freeze({ attachmentId: chain.attachmentId, copyId: chain.copyId,
                worldGeneration: chain.worldGeneration });
            sweep = { copy, remaining, iterator };
            return { inspected: 0, done: remaining === 0 };
        },
        put(id, row, chain) {
            currentChain(chain);
            const point = validateRow(id, row, copy.worldGeneration);
            const before = recordOf(id);
            if (before && (before.source.worldGeneration > row.worldGeneration
                || (before.source.worldGeneration === row.worldGeneration
                    && (before.source.publication > row.publication
                        || before.source.sourceGeneration > row.sourceGeneration)))) {
                throw new TypeError('stale_actor_store_publication');
            }
            currentChain(chain);
            if (readers.getSource(id, 'actor') !== before) throw new TypeError('changed_actor_store_source');
            let record = before?.source === row ? before : null;
            if (!record) {
                record = { id, source: row, phase: 'hot', realPlayer: false,
                    loc: () => { throw new TypeError('passive_actor_generic_unindexed'); } };
                Object.defineProperty(record, COPY, { value: { owner, copy } });
                Object.freeze(record);
            }
            index.setSource(id, 'actor', record, { indexed: false });
            record[COPY].copy = copy;
            // The provider reads ORIGINAL received data, retaining no point facts.
            index.updateFacet(id, 'actor', record, 'raw_xy', point
                ? { enabled: true, loc: () => rowPoint(row) } : { enabled: false });
            return true;
        },
        remove(id, absence, chain) {
            currentChain(chain);
            objectFields(absence, ['id', 'worldGeneration', 'throughPublication']);
            if (!positive(id) || absence.id !== id || absence.worldGeneration !== copy.worldGeneration
                || !positive(absence.throughPublication)) throw new TypeError('invalid_actor_store_absence');
            const record = recordOf(id);
            if (!record || record.source.worldGeneration > absence.worldGeneration
                || (record.source.worldGeneration === absence.worldGeneration
                    && record.source.publication > absence.throughPublication)) return false;
            currentChain(chain);
            if (readers.getSource(id, 'actor') !== record) throw new TypeError('changed_actor_store_source');
            return index.removeSource(id, 'actor', record.source);
        },
        cleanup(limit) {
            active();
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
                throw new RangeError('invalid_actor_store_cleanup_limit');
            }
            const job = sweep;
            if (!job) return { inspected: 0, done: true };
            currentChain(descriptor.chain);
            if (job.copy !== copy) throw new TypeError('stale_actor_store_cleanup');
            let inspected = 0;
            while (job.remaining > 0 && inspected < limit) {
                const item = job.iterator.next();
                if (item.done) { job.remaining = 0; break; }
                job.remaining--; inspected++;
                const [id, record] = item.value;
                active();
                if (job !== sweep || job.copy !== copy) throw new TypeError('stale_actor_store_cleanup');
                const current = readers.getSource(id, 'actor');
                if (current !== record) continue;
                if (record[COPY]?.owner !== owner) throw new TypeError('foreign_actor_store_source');
                if (record[COPY].copy !== copy) index.removeSource(id, 'actor', record.source);
            }
            active();
            currentChain(descriptor.chain);
            if (job !== sweep || job.copy !== copy) throw new TypeError('stale_actor_store_cleanup');
            const done = job.remaining === 0;
            if (done) sweep = null;
            // Mirror alone applies this scalar to its SAME descriptor.
            return { inspected, done };
        },
        get(id) { active(); return recordOf(id)?.source; },
        has(id) { active(); return !!recordOf(id); },
        get size() { active(); return readers.sourceSize('actor'); },
        entries,
        keys() {
            const original = entries();
            return { next() { const item = original.next(); return item.done ? item : { done: false, value: item.value[0] }; },
                [Symbol.iterator]() { return this; } };
        },
        values() {
            const original = entries();
            return { next() { const item = original.next(); return item.done ? item : { done: false, value: item.value[1] }; },
                [Symbol.iterator]() { return this; } };
        },
        records,
        [Symbol.iterator]: entries,
        dispose() { if (disposed) return; disposed = true; sweep = null; }
    };
    const backing = Object.freeze(store);
    if (ownerBinding(owner, descriptor) !== binding) throw new TypeError('changed_actor_store_owner');
    actorStores.set(owner, { index, binding, store: backing, nativeGuard: null,
        // This is private factory state, never a caller-supplied readiness claim.
        current: () => !disposed && ownerBinding(owner, descriptor) === binding });
    return backing;
}

function standalone() {
    if (arguments.length !== 0) throw new TypeError('invalid_actor_store_standalone_arguments');
    const index = new CharacterLocationIndex();
    let attached = false;
    const createStore = (owner, descriptor) => {
        const binding = ownerBinding(owner, descriptor);
        if (attached) throw new TypeError('actor_store_already_attached');
        attached = true;
        let store;
        try {
            store = makeStore(index, owner, descriptor, binding);
            if (ownerBinding(owner, descriptor) !== binding) throw new TypeError('changed_actor_store_owner');
            return store;
        } catch (error) {
            store?.dispose();
            throw error;
        }
    };
    return Object.freeze({ index, createStore });
}

// Only a genuine factory registration resolves; no supplied shape or callback.
function actorStoreIndex(owner) {
    const association = actorStores.get(owner);
    if (!association) return null;
    try {
        if (!association.current()) return null;
        association.nativeGuard?.();
        if (!association.current()) return null;
        return association.index;
    } catch {
        return null;
    }
}

// Grant reads only to the exact privately registered backing, never a shape.
function actorStoreMatches(owner, backing) {
    const association = actorStores.get(owner);
    return !!association && association.store === backing
        && actorStoreIndex(owner) === association.index;
}

function native() {
    if (arguments.length !== 0) throw new TypeError('invalid_actor_store_native_arguments');
    if (isMainThread) throw new TypeError('actor_store_native_attachment_unavailable');
    if (nativeAttempted) throw new TypeError('actor_store_native_already_acquired');
    // A failed native acquisition is sticky; no supplied role or retry/reset API.
    nativeAttempted = true;
    const Runtime = require('./CharacterLocationRuntime');
    if (typeof Runtime.actorProducerReads !== 'function'
        || typeof Runtime.nativeActorMirror !== 'function'
        || typeof Runtime.attachActorReadOwner !== 'function'
        || typeof TableMirror.nativeActorMirrorOwner !== 'function'
        || typeof TableMirror.actorStoreOwner !== 'function') {
        throw new TypeError('actor_store_native_attachment_unavailable');
    }
    const index = Runtime.index;
    const role = Runtime.workerProjectorRole();
    if (!(index instanceof CharacterLocationIndex) || index.legacyStateCache !== true
        || !Runtime.isWorkerProjectorRole(role, index)) {
        throw new TypeError('invalid_worker_actor_store_role');
    }
    const mirror = Runtime.nativeActorMirror();
    const consent = TableMirror.nativeActorMirrorOwner(mirror);
    if (!mirror || !consent || consent.mirror !== mirror || consent.index !== index
        || consent.role !== role || consent.epoch !== nativeEpoch) {
        throw new TypeError('invalid_worker_actor_store_mirror');
    }
    const port = Runtime.actorProducerReads();
    if (!port || typeof port.getSource !== 'function' || typeof port.sourceSize !== 'function'
        || typeof port.sourceEntries !== 'function') {
        throw new TypeError('invalid_worker_actor_producer_reads');
    }
    const scope = { live: true, attachment: null };
    const current = () => {
        if (!scope.live || Runtime.index !== index || Runtime.workerProjectorRole() !== role
            || !Runtime.isWorkerProjectorRole(role, index)
            || Runtime.nativeActorMirror() !== mirror
            || TableMirror.nativeActorMirrorOwner(mirror) !== consent
            || Runtime.actorProducerReads() !== port) {
            throw new TypeError('stale_worker_actor_store_source');
        }
    };
    const createStore = (owner, descriptor) => {
        current();
        const binding = ownerBinding(owner, descriptor);
        if (binding.mirror !== mirror) throw new TypeError('invalid_worker_actor_store_mirror');
        if (scope.attachment || actorStores.has(owner)) {
            throw new TypeError('actor_store_already_attached');
        }
        const association = { index, live: true, check: null, stage: 'allocating' };
        scope.attachment = association;
        const active = () => {
            current();
            if (!association.live || scope.attachment !== association
                || ownerBinding(owner, descriptor) !== binding) {
                throw new TypeError('stale_actor_store_owner');
            }
        };
        association.check = active;
        const step = (original) => Object.freeze({
            next() {
                active();
                const result = original.next();
                active();
                return result;
            },
            [Symbol.iterator]() { return this; }
        });
        const read = (name, args) => {
            active();
            const result = Reflect.apply(port[name], port, args);
            active();
            return result;
        };
        const readers = Object.freeze({
            getSource(id, view) { return read('getSource', [id, view]); },
            sourceSize(view) { return read('sourceSize', [view]); },
            sourceEntries(view) { return step(read('sourceEntries', [view])); }
        });
        let store;
        const retire = () => {
            association.live = false;
            association.stage = 'retired';
            scope.live = false;
        };
        try {
            store = makeStore(index, owner, descriptor, binding, readers);
            active();
            const call = (name, args) => {
                active();
                const result = Reflect.apply(store[name], store, args);
                active();
                return result;
            };
            const backing = Object.freeze({
                beginCopy(...args) { return call('beginCopy', args); },
                put(...args) { return call('put', args); },
                remove(...args) { return call('remove', args); },
                cleanup(...args) { return call('cleanup', args); },
                get(...args) { return call('get', args); },
                has(...args) { return call('has', args); },
                get size() {
                    active();
                    const result = store.size;
                    active();
                    return result;
                },
                keys() { return step(call('keys', [])); },
                values() { return step(call('values', [])); },
                entries() { return step(call('entries', [])); },
                records() { return step(call('records', [])); },
                [Symbol.iterator]() { return this.entries(); },
                dispose() {
                    if (!association.live) return;
                    retire();
                    store.dispose();
                }
            });
            // Authentic pending identity is available for Runtime's O(1) install;
            // neither this registration nor install advertises a whole actor cut.
            association.stage = 'installing';
            const registration = actorStores.get(owner);
            if (!registration || registration.index !== index || registration.binding !== binding
                || registration.store !== store) throw new TypeError('invalid_native_actor_store_registration');
            registration.store = backing;
            registration.nativeGuard = active;
            Runtime.attachActorReadOwner(owner);
            active();
            association.stage = 'installed';
            return backing;
        } catch (error) {
            retire();
            // Preserve the original installation failure, including falsy values.
            // An unreturned allocation is cleaned here; no row rollback is claimed.
            try { store?.dispose(); } catch { /* original failure remains authoritative */ }
            throw error;
        }
    };
    current();
    return Object.freeze({ index, createStore });
}

module.exports = Object.freeze({ standalone, native, actorStoreIndex, actorStoreMatches });
