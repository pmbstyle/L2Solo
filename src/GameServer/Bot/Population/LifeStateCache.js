'use strict';
const { SpotOccupancyIndex, stateKey } = require('./SpotOccupancyIndex');
// Bot location buckets: any size is correct. One visibility radius keeps a
// coldNear search of that radius within 3x3 cells.
const CELL_SIZE = require('../../World/WorldConstants').CLIENT_VISIBILITY_RADIUS;

class LifeStateCache extends Map {
    constructor() {
        super();
        this.cells = new Map();
        this.cellById = new Map();
        this.revision = 0;
        // Newest updatedAt first; equal times keep Map order (first insertion),
        // as a stable sort of values() would. Kept in place on every write:
        // a commit moves one entry instead of re-sorting the whole population.
        this.ordered = [];
        this.orderEntries = new Map();
        this.nextSequence = 0;
        this.occupancy = new SpotOccupancyIndex();
    }

    orderIndex(at, sequence) {
        let low = 0, high = this.ordered.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            const entry = this.ordered[middle];
            if (entry.at > at || (entry.at === at && entry.sequence < sequence)) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    removeOrder(id) {
        const entry = this.orderEntries.get(id);
        if (!entry) return;
        let index = this.orderIndex(entry.at, entry.sequence);
        if (this.ordered[index] !== entry) index = this.ordered.indexOf(entry);
        this.ordered.splice(index, 1);
        this.orderEntries.delete(id);
    }

    insertOrder(id, state, sequence) {
        const entry = { at: Number(state.updatedAt || 0), sequence, state };
        this.ordered.splice(this.orderIndex(entry.at, sequence), 0, entry);
        this.orderEntries.set(id, entry);
    }

    removeCell(id) {
        const key = this.cellById.get(id);
        if (key === undefined) return;
        const cell = this.cells.get(key);
        cell?.delete(id);
        if (!cell?.size) this.cells.delete(key);
        this.cellById.delete(id);
    }

    set(id, state) {
        this.removeCell(id);
        const sequence = this.orderEntries.get(id)?.sequence ?? this.nextSequence++;
        this.removeOrder(id);
        const previous = super.get(id);
        if (previous && stateKey(previous) !== stateKey(state)) this.occupancy.remove(stateKey(previous));
        super.set(id, state);
        this.insertOrder(id, state, sequence);
        this.occupancy.update(state);
        if (state.phase === 'cold' && state.activity !== 'pk_hunting') {
            const x = Number(state.loc?.locX || 0), y = Number(state.loc?.locY || 0);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                const key = `${Math.floor(x / CELL_SIZE)}:${Math.floor(y / CELL_SIZE)}`;
                if (!this.cells.has(key)) this.cells.set(key, new Set());
                this.cells.get(key).add(id);
                this.cellById.set(id, key);
            }
        }
        this.revision++;
        return this;
    }

    delete(id) {
        this.removeCell(id);
        this.removeOrder(id);
        if (super.has(id)) this.occupancy.remove(stateKey(super.get(id)));
        const removed = super.delete(id);
        if (removed) this.revision++;
        return removed;
    }

    clear() {
        super.clear(); this.cells.clear(); this.cellById.clear();
        this.ordered = []; this.orderEntries.clear(); this.occupancy.clear();
        this.revision++;
    }

    recent(limit) {
        return this.ordered.slice(0, limit).map((entry) => entry.state);
    }

    beyondRecent(limit) {
        return this.ordered.slice(limit).map((entry) => entry.state);
    }

    near(loc, radius, limit) {
        const x = Number(loc.locX), y = Number(loc.locY);
        if (![x, y, radius].every(Number.isFinite) || radius <= 0) return [];
        const minX = Math.floor((x - radius) / CELL_SIZE), maxX = Math.floor((x + radius) / CELL_SIZE);
        const minY = Math.floor((y - radius) / CELL_SIZE), maxY = Math.floor((y + radius) / CELL_SIZE);
        const ids = new Set();
        if ((maxX - minX + 1) * (maxY - minY + 1) > 10000) {
            for (const id of this.cellById.keys()) ids.add(id);
        } else {
            for (let cx = minX; cx <= maxX; cx++) for (let cy = minY; cy <= maxY; cy++) {
                for (const id of this.cells.get(`${cx}:${cy}`) || []) ids.add(id);
            }
        }
        const found = [];
        for (const id of ids) {
            const state = this.get(id);
            if (!state || state.phase !== 'cold' || state.activity === 'pk_hunting') continue;
            const distanceSquared = (Number(state.loc?.locX || 0) - x) ** 2 + (Number(state.loc?.locY || 0) - y) ** 2;
            if (distanceSquared <= radius ** 2) found.push({ state, distanceSquared });
        }
        return found.sort((a, b) => a.distanceSquared - b.distanceSquared || a.state.characterId - b.state.characterId)
            .slice(0, limit).map(value => value.state);
    }
}

module.exports = LifeStateCache;
