'use strict';

// Ignored source draft. Native attachment/read authorization is unavailable.
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

function makeStore(index, owner, descriptor, binding) {
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
        const record = index.getSource(id, 'actor');
        if (record && record[COPY]?.owner !== owner) throw new TypeError('foreign_actor_store_source');
        return record;
    };
    const records = () => {
        active();
        const original = index.sourceEntries('actor');
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
            const remaining = index.sourceSize('actor');
            const iterator = index.sourceEntries('actor');
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
            if (index.getSource(id, 'actor') !== before) throw new TypeError('changed_actor_store_source');
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
            if (index.getSource(id, 'actor') !== record) throw new TypeError('changed_actor_store_source');
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
                const current = index.getSource(id, 'actor');
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
        get size() { active(); return index.sourceSize('actor'); },
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
    return Object.freeze(store);
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

function native() {
    if (arguments.length !== 0) throw new TypeError('invalid_actor_store_native_arguments');
    // No Runtime/World import or synthetic owner/role while prerequisites are absent.
    throw new TypeError('actor_store_native_attachment_unavailable');
}

module.exports = Object.freeze({ standalone, native });
