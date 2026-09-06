'use strict';
const CELL_SIZE = 6000;

class LifeStateCache extends Map {
    constructor() {
        super();
        this.cells = new Map();
        this.cellById = new Map();
        this.revision = 0;
        this.ordered = null;
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
        super.set(id, state);
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
        this.ordered = null;
        return this;
    }

    delete(id) {
        this.removeCell(id);
        const removed = super.delete(id);
        if (removed) { this.revision++; this.ordered = null; }
        return removed;
    }

    clear() {
        super.clear(); this.cells.clear(); this.cellById.clear();
        this.revision++; this.ordered = null;
    }

    recent(limit) {
        this.ordered ||= [...this.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
        return this.ordered.slice(0, limit);
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
