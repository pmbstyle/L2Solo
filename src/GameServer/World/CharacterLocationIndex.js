'use strict';

const { SPOT_CELL_SIZE } = require('./WorldConstants');
const KINDS = new Set(['all', 'hot', 'cold', 'player']);
const VIEWS = new Set(['actor', 'state']);

function validateView(view) {
    if (!VIEWS.has(view)) throw new RangeError('invalid_character_source_view');
}

function cellMembers() {
    return { all: new Set(), hot: new Set(), cold: new Set(), player: new Set() };
}

function pointOf(loc) {
    const point = typeof loc === 'function' ? loc() : loc;
    if (!point || !Number.isFinite(point.locX) || !Number.isFinite(point.locY)
        || !Number.isFinite(point.locZ)) throw new RangeError('invalid_character_location');
    return point;
}

function cellCoordinate(value, size) {
    const cell = Math.floor(value / size);
    if (!Number.isSafeInteger(cell)) throw new RangeError('invalid_character_cell');
    return cell;
}

function memberships(record) {
    if (record.phase !== 'hot' && record.phase !== 'cold') throw new RangeError('invalid_character_phase');
    if (record.spotId != null && (typeof record.spotId !== 'string' || !record.spotId)) {
        throw new RangeError('invalid_character_spot');
    }
    return { phase: record.phase, realPlayer: record.realPlayer === true, spotId: record.spotId ?? null };
}

// One runtime index for characters, including future cold/spot adapters. Only
// membership is cached: exact queries read the original live location reference.
// Actor and state producers retain independent source slots for the same ID.
class CharacterLocationIndex {
    constructor({ cellSize = SPOT_CELL_SIZE, legacyStateCache = false } = {}) {
        if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('invalid_character_cell_size');
        if (typeof legacyStateCache !== 'boolean') throw new TypeError('invalid_character_state_mode');
        Object.defineProperty(this, 'cellSize', { value: cellSize, enumerable: true });
        Object.defineProperty(this, 'legacyStateCache', { value: legacyStateCache });
        this.records = new Map();
        this.cells = new Map();
        this.spots = new Map();
    }

    put(record) {
        return this.setSource(record?.id, 'actor', record);
    }

    setSource(id, view, record, { indexed = true } = {}) {
        validateView(view);
        if (typeof indexed !== 'boolean') throw new TypeError('invalid_character_source_mode');
        const legacy = view === 'state' && this.legacyStateCache;
        const sameId = record?.id === id || (legacy && Number.isNaN(id) && Number.isNaN(record?.id));
        if ((!legacy && (!Number.isSafeInteger(id) || id <= 0)) || !sameId
            || !record?.source || (typeof record.source !== 'object' && typeof record.source !== 'function')) {
            throw new RangeError('invalid_character_source');
        }
        const point = indexed ? pointOf(record.loc) : null;
        const key = indexed ? this.cellKey(point, view) : null;
        const tags = memberships(record);
        let row = this.records.get(id);
        let entry = row?.[view];
        if (entry && entry.source !== record.source) {
            this.removeSource(id, view, entry.source);
            row = this.records.get(id);
            entry = null;
        }
        if (!row) {
            row = { id, actor: null, state: null };
            this.records.set(id, row);
        }
        if (!entry) {
            entry = { id, view, source: record.source, record, indexed: false,
                key: null, phase: null, realPlayer: false, spotId: null };
            row[view] = entry;
        }
        entry.record = record;
        this.refresh(entry, key, tags, point, indexed);
        return record;
    }

    update(id, source) {
        return this.updateSource(id, 'actor', source);
    }

    updateSource(id, view, source, { indexed } = {}) {
        validateView(view);
        const entry = this.records.get(id)?.[view];
        if (!entry || entry.source !== source) return false;
        const nextIndexed = indexed === undefined ? entry.indexed : indexed;
        if (typeof nextIndexed !== 'boolean') throw new TypeError('invalid_character_source_mode');
        const point = nextIndexed ? pointOf(entry.record.loc) : null;
        const key = nextIndexed ? this.cellKey(point, view) : null;
        this.refresh(entry, key, memberships(entry.record), point, nextIndexed);
        return true;
    }

    remove(id, source) {
        return this.removeSource(id, 'actor', source);
    }

    removeSource(id, view, source) {
        validateView(view);
        const row = this.records.get(id);
        const entry = row?.[view];
        if (!entry || entry.source !== source) return false;
        this.detachCell(entry);
        this.detachSpot(entry);
        row[view] = null;
        if (!row.actor && !row.state) this.records.delete(id);
        return true;
    }

    get(id) {
        return this.getSource(id, 'actor');
    }

    getSource(id, view) {
        validateView(view);
        return this.records.get(id)?.[view]?.record ?? null;
    }

    near(loc, radius, { kind = 'all' } = {}) {
        return this.nearSources(loc, radius, { view: 'actor', kind });
    }

    nearSources(loc, radius, { view = 'actor', kind = 'all', accept = null, allowUnsafeCellBounds = false } = {}) {
        validateView(view);
        if (!KINDS.has(kind)) throw new RangeError('invalid_character_query_kind');
        if (accept !== null && typeof accept !== 'function') throw new TypeError('invalid_character_query_filter');
        if (typeof allowUnsafeCellBounds !== 'boolean') throw new TypeError('invalid_character_query_bounds_mode');
        if (allowUnsafeCellBounds && (!this.legacyStateCache || view !== 'state' || kind !== 'cold')) {
            throw new RangeError('invalid_character_query_bounds_mode');
        }
        if (!Number.isFinite(radius) || radius < 0) throw new RangeError('invalid_character_radius');
        const point = pointOf(loc);
        const minX = Math.floor((point.locX - radius) / this.cellSize);
        const maxX = Math.floor((point.locX + radius) / this.cellSize);
        const minY = Math.floor((point.locY - radius) / this.cellSize);
        const maxY = Math.floor((point.locY + radius) / this.cellSize);
        const safeBounds = [minX, maxX, minY, maxY].every(Number.isSafeInteger);
        if (!safeBounds && !allowUnsafeCellBounds) throw new RangeError('invalid_character_cell');
        const radiusSquared = radius * radius;
        const records = [];
        const append = (cell) => {
            for (const entry of cell?.[view]?.[kind] ?? []) {
                if (accept && !accept(entry.record)) continue;
                const current = pointOf(entry.record.loc);
                const dx = current.locX - point.locX;
                const dy = current.locY - point.locY;
                if (dx * dx + dy * dy <= radiusSquared) records.push(entry.record);
            }
        };
        if (safeBounds && (maxX - minX + 1) * (maxY - minY + 1) <= 10000) {
            for (let x = minX; x <= maxX; x += 1) {
                for (let y = minY; y <= maxY; y += 1) append(this.cells.get(`${x}_${y}`));
            }
        } else {
            const cells = [];
            for (const cell of this.cells.values()) {
                if (!cell[view]?.[kind]?.size) continue;
                if (safeBounds && (cell.x < minX || cell.x > maxX || cell.y < minY || cell.y > maxY)) continue;
                cells.push(cell);
            }
            // Match coordinate traversal for safe ranges. Legacy unsafe Cache
            // queries keep their exact distance/id ordering in their adapter.
            if (safeBounds) cells.sort((left, right) => left.x - right.x || left.y - right.y);
            for (const cell of cells) append(cell);
        }
        return records;
    }

    inSpot(spotId) {
        return this.inSpotSources(spotId, { view: 'actor' });
    }

    inSpotSources(spotId, { view = 'actor' } = {}) {
        validateView(view);
        return Array.from(this.spots.get(spotId)?.[view] ?? [], (entry) => entry.record);
    }

    clear() {
        this.records.clear();
        this.cells.clear();
        this.spots.clear();
    }

    clearSourceView(view) {
        validateView(view);
        for (const row of this.records.values()) {
            const entry = row[view];
            if (entry) this.removeSource(row.id, view, entry.source);
        }
    }

    cellKey(point, view = 'actor') {
        if (view === 'state' && this.legacyStateCache) {
            return `${Math.floor(point.locX / this.cellSize)}_${Math.floor(point.locY / this.cellSize)}`;
        }
        return `${cellCoordinate(point.locX, this.cellSize)}_${cellCoordinate(point.locY, this.cellSize)}`;
    }

    refresh(entry, key, tags, point, indexed) {
        if (!indexed) {
            this.detachCell(entry);
            this.detachSpot(entry);
            entry.key = null;
            entry.phase = tags.phase;
            entry.realPlayer = tags.realPlayer;
            entry.spotId = null;
            entry.indexed = false;
            return;
        }
        entry.indexed = true;
        if (entry.key !== key) {
            this.detachCell(entry);
            entry.key = key;
            entry.phase = tags.phase;
            entry.realPlayer = tags.realPlayer;
            const cell = this.cells.get(key) ?? {
                x: Math.floor(point.locX / this.cellSize), y: Math.floor(point.locY / this.cellSize)
            };
            const members = cell[entry.view] ?? cellMembers();
            cell[entry.view] = members;
            this.cells.set(key, cell);
            members.all.add(entry);
            members[entry.phase].add(entry);
            if (entry.realPlayer) members.player.add(entry);
        } else {
            const members = this.cells.get(key)[entry.view];
            if (entry.phase !== tags.phase) {
                members[entry.phase].delete(entry);
                members[tags.phase].add(entry);
                entry.phase = tags.phase;
            }
            if (entry.realPlayer !== tags.realPlayer) {
                if (tags.realPlayer) members.player.add(entry);
                else members.player.delete(entry);
                entry.realPlayer = tags.realPlayer;
            }
        }
        if (entry.spotId !== tags.spotId) {
            this.detachSpot(entry);
            entry.spotId = tags.spotId;
            if (entry.spotId !== null) {
                const spot = this.spots.get(entry.spotId) ?? {};
                const members = spot[entry.view] ?? new Set();
                spot[entry.view] = members;
                members.add(entry);
                this.spots.set(entry.spotId, spot);
            }
        }
    }

    detachCell(entry) {
        const cell = this.cells.get(entry.key);
        const members = cell?.[entry.view];
        if (!members) return;
        members.all.delete(entry);
        members[entry.phase].delete(entry);
        if (entry.realPlayer) members.player.delete(entry);
        if (!members.all.size) delete cell[entry.view];
        if (!cell.actor && !cell.state) this.cells.delete(entry.key);
    }

    detachSpot(entry) {
        const spot = this.spots.get(entry.spotId);
        const members = spot?.[entry.view];
        if (!members) return;
        members.delete(entry);
        if (!members.size) delete spot[entry.view];
        if (!spot.actor && !spot.state) this.spots.delete(entry.spotId);
    }
}

module.exports = CharacterLocationIndex;
