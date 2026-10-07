'use strict';

const MAX_PAGE_ROWS = 128;
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
        rows.forEach((row, index) => {
            if (row && typeof row === 'object' && !this.ordinals.has(row)) this.ordinals.set(row, index);
        });
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
            const ordinal = row && typeof row === 'object' ? this.ordinals.get(row) : undefined;
            // ID equality is insufficient: per-clan raid decorations and
            // authored/custom replacements must retain their complete row.
            return ordinal === undefined ? [0, row] : [1, ordinal];
        });
        return { ...rest, spotCatalogGeneration: this.generation, spotOrder };
    }
}

class SpotCatalogReader {
    constructor() {
        this.generation = 0;
        this.rows = [];
        this.pending = null;
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
        }
    }

    restore(payload) {
        const { spotCatalogGeneration, spotOrder, ...rest } = payload;
        if (spotCatalogGeneration !== this.generation || !this.generation) throw new Error('stale clan spot generation');
        if (!Array.isArray(spotOrder) || spotOrder.length > MAX_CATALOG_ROWS) throw new Error('invalid clan spot order');
        const spots = spotOrder.map(entry => {
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
