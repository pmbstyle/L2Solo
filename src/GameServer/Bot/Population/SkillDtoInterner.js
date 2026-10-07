'use strict';

const { isProxy } = require('node:util').types;
const FIELDS = Object.freeze(['selfId', 'level', 'passive', 'spell', 'power', 'mp', 'hp', 'hitTime', 'reuse', 'buffTime',
    'itemId', 'itemCount', 'itemIdOT', 'itemCountOT', 'itemConsumeSteps', 'npcId', 'totalLifeTime',
    'timeLostIdle', 'timeLostActive', 'isCubic']);
const BOOLEAN = new Set(['passive', 'spell', 'isCubic']);

// Exact primitive DTOs only. One pool per cold Worker, <=4096 unique records;
// each admitted owner holds only Uint16 acquired slots, independent of its
// mutable skill-membership array. release/delete/fence/clear drop these slots
// synchronously. Fixed numeric storage is an 8192 B free-slot buffer, a
// 4097-slot record array and an 8 B hashing buffer; each owner acquires only
// two bytes per membership slot (plus ordinary headers). Unknown
// layouts, proxies, accessors and a full pool fall back.
class SkillDtoInterner {
    #owners = new Map();
    #records;
    #free;
    #freeCount;
    #acquiredSlots = 0;
    #stages = new WeakMap();

    constructor({ maxUnique = 4096, hashOverride = null } = {}) {
        if (!Number.isInteger(maxUnique) || maxUnique < 1 || maxUnique > 4096) throw new RangeError('unique limit must be 1..4096');
        this.maxUnique = maxUnique;
        this.buckets = new Map();
        this.bits = new DataView(new ArrayBuffer(8));
        this.hashOverride = hashOverride;
        this.unique = 0;
        this.fallback = 0;
        this.#records = new Array(maxUnique + 1).fill(null);
        this.#free = new Uint16Array(maxUnique);
        this.#freeCount = maxUnique;
        for (let i = 0; i < maxUnique; i++) this.#free[i] = i + 1;
    }

    eligible(row) {
        if (!row || typeof row !== 'object' || isProxy(row) || Object.getPrototypeOf(row) !== Object.prototype) return false;
        const keys = Reflect.ownKeys(row);
        if (keys.length !== FIELDS.length) return false;
        for (let i = 0; i < keys.length; i++) {
            if (keys[i] !== FIELDS[i]) return false;
            const descriptor = Object.getOwnPropertyDescriptor(row, keys[i]);
            if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
                || typeof descriptor.value !== (BOOLEAN.has(keys[i]) ? 'boolean' : 'number')) return false;
        }
        return true;
    }

    hash(row) {
        if (this.hashOverride) return this.hashOverride(row) >>> 0;
        let hash = 2166136261;
        for (const key of FIELDS) {
            if (BOOLEAN.has(key)) { hash = Math.imul(hash ^ (row[key] ? 1 : 0), 16777619); continue; }
            this.bits.setFloat64(0, row[key], true);
            for (let i = 0; i < 8; i++) hash = Math.imul(hash ^ this.bits.getUint8(i), 16777619);
        }
        return hash >>> 0;
    }

    same(a, b) {
        for (const key of FIELDS) {
            if (!Object.is(a[key], b[key])) return false;
            if (typeof a[key] === 'number' && Number.isNaN(a[key])) {
                this.bits.setFloat64(0, a[key], true);
                const low = this.bits.getUint32(0, true), high = this.bits.getUint32(4, true);
                this.bits.setFloat64(0, b[key], true);
                if (low !== this.bits.getUint32(0, true) || high !== this.bits.getUint32(4, true)) return false;
            }
        }
        return true;
    }

    #acquire(row) {
        if (!this.eligible(row)) { this.fallback++; return null; }
        const hash = this.hash(row), head = this.buckets.get(hash);
        for (let record = head; record; record = record.next) {
            if (this.same(row, record.dto)) { record.references++; return record; }
        }
        if (!this.#freeCount) { this.fallback++; return null; }
        // Copy before freezing: a refused publication can restore the exact
        // incoming references AND descriptors, without an irreversible freeze.
        const dto = Object.freeze({ ...row });
        const slot = this.#free[--this.#freeCount];
        const record = { dto, references: 1, next: head || null, slot, hash };
        this.#records[slot] = record;
        this.buckets.set(hash, record);
        this.unique++;
        return record;
    }

    #release(handles) {
        for (const slot of handles) {
            if (!slot) continue;
            const record = this.#records[slot];
            if (!record || record.references <= 0) throw new Error('skill ownership reference corruption');
            if (--record.references) continue;
            let prior = null;
            for (let found = this.buckets.get(record.hash); found; found = found.next) {
                if (found === record) {
                    if (prior) prior.next = record.next;
                    else if (record.next) this.buckets.set(record.hash, record.next);
                    else this.buckets.delete(record.hash);
                    break;
                }
                prior = found;
            }
            this.#records[slot] = null;
            this.#free[this.#freeCount++] = slot;
            this.unique--;
        }
    }

    prepare(id, array) {
        let originals = null;
        if (Array.isArray(array) && !isProxy(array) && Object.getPrototypeOf(array) === Array.prototype) {
            originals = new Array(array.length);
            for (let i = 0; i < array.length; i++) {
                const descriptor = Object.getOwnPropertyDescriptor(array, String(i));
                if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.writable) { originals = null; break; }
                originals[i] = descriptor.value;
            }
        }
        const token = {};
        if (!originals) {
            if (array !== null) this.fallback++;
            this.#stages.set(token, { id, array: null, originals: null, acquired: null });
            return token;
        }
        const acquired = new Uint16Array(originals.length);
        let assigned = 0;
        try {
            for (let i = 0; i < originals.length; i++) {
                const record = this.#acquire(originals[i]);
                acquired[i] = record?.slot || 0;
                array[i] = record?.dto || originals[i];
                assigned++;
            }
        } catch (error) {
            try { for (let i = 0; i < assigned; i++) array[i] = originals[i]; }
            finally { this.#release(acquired); }
            throw error;
        }
        this.#stages.set(token, { id, array, originals, acquired });
        return token;
    }

    commit(token) {
        const stage = this.#stages.get(token);
        if (!stage) throw new TypeError('invalid_skill_dto_stage');
        this.#stages.delete(token);
        this.remove(stage.id);
        if (stage.acquired) {
            this.#owners.set(stage.id, stage.acquired);
            this.#acquiredSlots += stage.acquired.length;
        }
    }

    rollback(token) {
        const stage = this.#stages.get(token);
        if (!stage) throw new TypeError('invalid_skill_dto_stage');
        this.#stages.delete(token);
        if (!stage.acquired) return;
        try { for (let i = 0; i < stage.originals.length; i++) stage.array[i] = stage.originals[i]; }
        finally { this.#release(stage.acquired); }
    }

    register(id, array) { const token = this.prepare(id, array); this.commit(token); return array; }
    remove(id) {
        const acquired = this.#owners.get(id);
        if (!acquired) return;
        this.#release(acquired);
        this.#acquiredSlots -= acquired.length;
        this.#owners.delete(id);
    }
    clear() { for (const id of this.#owners.keys()) this.remove(id); }
    size() {
        return { owners: this.#owners.size, unique: this.unique, buckets: this.buckets.size,
            fallback: this.fallback, acquiredSlots: this.#acquiredSlots, slotLimit: this.maxUnique };
    }
}

module.exports = { SkillDtoInterner, FIELDS };
