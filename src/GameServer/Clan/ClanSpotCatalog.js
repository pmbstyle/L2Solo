'use strict';

const { isDeepStrictEqual } = require('node:util');
const MAX_PAGE_ROWS = 128;
// Restored decorations held per catalogue row (ClanSpotCatalog reader).
const MAX_DECORATIONS_PER_ROW = 4;
const MAX_CATALOG_ROWS = 32768;

function validateGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid clan spot generation');
}

class SpotCatalogWriter {
    constructor(generation, rows) {
        validateGeneration(generation);
        if (!Array.isArray(rows) || rows.length > MAX_CATALOG_ROWS) throw new Error('invalid clan spot catalog');
        this.generation = generation;
        this.rows = rows;
        this.ordinals = new WeakMap();
        this.byId = new Map();
        rows.forEach((row, index) => {
            if (row && typeof row === 'object' && !this.ordinals.has(row)) this.ordinals.set(row, index);
            if (row && typeof row === 'object' && row.id !== undefined && !this.byId.has(row.id)) this.byId.set(row.id, index);
        });
    }

    // A row built from a catalogue row of its id (a raid projection, a clan's
    // roster size and estimate on it): the fields it adds or changes and the
    // ones it drops. Null when it cannot be rebuilt as { ...base, ...diff } in
    // the same key order.
    decoration(row, ordinal) {
        const base = this.rows[ordinal];
        if (!base || typeof base !== 'object' || Object.getPrototypeOf(row) !== Object.prototype) return null;
        const keys = Object.keys(row), deleted = [], diff = {};
        let index = 0;
        for (const key of Object.keys(base)) {
            if (!Object.hasOwn(row, key)) deleted.push(key);
            else if (keys[index++] !== key) return null;
        }
        for (const key of keys) if (!Object.hasOwn(base, key) || row[key] !== base[key]) diff[key] = row[key];
        return [2, ordinal, diff, deleted];
    }

    *pages() {
        if (!this.rows.length) {
            yield { generation: this.generation, offset: 0, total: 0, rows: [], done: true };
            return;
        }
        for (let offset = 0; offset < this.rows.length; offset += MAX_PAGE_ROWS) {
            yield { generation: this.generation, offset, total: this.rows.length,
                rows: this.rows.slice(offset, offset + MAX_PAGE_ROWS),
                done: offset + MAX_PAGE_ROWS >= this.rows.length };
        }
    }

    pack(payload) {
        const { spots, ...rest } = payload;
        if (spots !== undefined && !Array.isArray(spots)) throw new Error('invalid clan planning spots');
        const spotOrder = (spots || []).map(row => {
            if (!row || typeof row !== 'object') return [0, row];
            const ordinal = this.ordinals.get(row);
            if (ordinal !== undefined) return [1, ordinal];
            // ID equality is insufficient: per-clan raid decorations and
            // authored/custom replacements cross as their own fields.
            const base = this.byId.get(row.id);
            return (base !== undefined && this.decoration(row, base)) || [0, row];
        });
        return { ...rest, spotCatalogGeneration: this.generation, spotOrder };
    }
}

class SpotCatalogReader {
    constructor() {
        this.generation = 0;
        this.rows = [];
        this.pending = null;
        // Restored decorations per row ordinal: a decoration sent again (each
        // plan message of a job repeats the clan's raid rows) is the same row
        // object, so the source index built over it is kept (SourceCatalog).
        this.decorations = new Map();
    }

    decorated(ordinal, diff, deleted) {
        const held = this.decorations.get(ordinal) || [];
        const found = held.find(entry => isDeepStrictEqual(entry.diff, diff) && isDeepStrictEqual(entry.deleted, deleted));
        if (found) return found.row;
        const row = { ...this.rows[ordinal], ...diff };
        for (const key of deleted) delete row[key];
        held.push({ diff, deleted, row });
        if (held.length > MAX_DECORATIONS_PER_ROW) held.shift();
        this.decorations.set(ordinal, held);
        return row;
    }

    apply({ generation, offset, total, rows, done }) {
        validateGeneration(generation);
        if (!Number.isSafeInteger(total) || total < 0 || total > MAX_CATALOG_ROWS
            || !Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(rows)
            || rows.length > MAX_PAGE_ROWS || (rows.length === 0 && total > 0) || offset + rows.length > total
            || typeof done !== 'boolean' || done !== (offset + rows.length === total)) {
            throw new Error('invalid clan spot page');
        }
        if (generation <= this.generation) throw new Error('stale clan spot page');
        if (offset === 0) {
            if (this.pending && generation <= this.pending.generation) throw new Error('stale clan spot page');
            this.pending = { generation, total, rows: [] };
        }
        const pending = this.pending;
        if (!pending || pending.generation !== generation || pending.total !== total
            || pending.rows.length !== offset) throw new Error('incomplete clan spot catalog');
        pending.rows.push(...rows);
        if (done) {
            this.rows = pending.rows;
            this.generation = generation;
            this.pending = null;
            this.decorations = new Map();
        }
    }

    restore(payload) {
        const { spotCatalogGeneration, spotOrder, ...rest } = payload;
        if (spotCatalogGeneration !== this.generation || !this.generation) throw new Error('stale clan spot generation');
        if (!Array.isArray(spotOrder) || spotOrder.length > MAX_CATALOG_ROWS) throw new Error('invalid clan spot order');
        const spots = spotOrder.map(entry => {
            if (Array.isArray(entry) && entry[0] === 2 && entry.length === 4) {
                const [, ordinal, diff, deleted] = entry;
                if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= this.rows.length
                    || !diff || typeof diff !== 'object' || !Array.isArray(deleted)) throw new Error('missing clan spot reference');
                return this.decorated(ordinal, diff, deleted);
            }
            if (!Array.isArray(entry) || entry.length !== 2) throw new Error('invalid clan spot reference');
            if (entry[0] === 0) return entry[1];
            if (entry[0] !== 1 || !Number.isSafeInteger(entry[1]) || entry[1] < 0 || entry[1] >= this.rows.length) {
                throw new Error('missing clan spot reference');
            }
            return this.rows[entry[1]];
        });
        return { ...rest, spots };
    }
}

module.exports = { MAX_PAGE_ROWS, MAX_CATALOG_ROWS, SpotCatalogWriter, SpotCatalogReader };
