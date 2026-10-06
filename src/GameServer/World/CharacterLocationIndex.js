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
    constructor({ cellSize = SPOT_CELL_SIZE } = {}) {
        if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('invalid_character_cell_size');
        Object.defineProperty(this, 'cellSize', { value: cellSize, enumerable: true });
        this.records = new Map();
        this.cells = new Map();
        this.spots = new Map();
    }

    put(record) {
        return this.setSource(record?.id, 'actor', record);
    }

    setSource(id, view, record) {
        validateView(view);
        if (!Number.isSafeInteger(id) || id <= 0 || record?.id !== id
            || !record.source || (typeof record.source !== 'object' && typeof record.source !== 'function')) {
            throw new RangeError('invalid_character_source');
        }
        const point = pointOf(record.loc);
        const key = this.cellKey(point);
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
            entry = { id, view, source: record.source, record, key: null, phase: null, realPlayer: false, spotId: null };
            row[view] = entry;
        }
        entry.record = record;
        this.refresh(entry, key, tags);
        return record;
    }

    update(id, source) {
        return this.updateSource(id, 'actor', source);
    }

    updateSource(id, view, source) {
        validateView(view);
        const entry = this.records.get(id)?.[view];
        if (!entry || entry.source !== source) return false;
        const point = pointOf(entry.record.loc);
        this.refresh(entry, this.cellKey(point), memberships(entry.record));
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

    nearSources(loc, radius, { view = 'actor', kind = 'all' } = {}) {
        validateView(view);
        if (!KINDS.has(kind)) throw new RangeError('invalid_character_query_kind');
        if (!Number.isFinite(radius) || radius < 0) throw new RangeError('invalid_character_radius');
        const point = pointOf(loc);
        const minX = cellCoordinate(point.locX - radius, this.cellSize);
        const maxX = cellCoordinate(point.locX + radius, this.cellSize);
        const minY = cellCoordinate(point.locY - radius, this.cellSize);
        const maxY = cellCoordinate(point.locY + radius, this.cellSize);
        const radiusSquared = radius * radius;
        const records = [];
        for (let x = minX; x <= maxX; x += 1) {
            for (let y = minY; y <= maxY; y += 1) {
                const candidates = this.cells.get(`${x}_${y}`)?.[view]?.[kind];
                if (!candidates) continue;
                for (const entry of candidates) {
                    const current = pointOf(entry.record.loc);
                    const dx = current.locX - point.locX;
                    const dy = current.locY - point.locY;
                    if (dx * dx + dy * dy <= radiusSquared) {
                        records.push(entry.record);
                    }
                }
            }
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

    cellKey(point) {
        return `${cellCoordinate(point.locX, this.cellSize)}_${cellCoordinate(point.locY, this.cellSize)}`;
    }

    refresh(entry, key, tags) {
        if (entry.key !== key) {
            this.detachCell(entry);
            entry.key = key;
            entry.phase = tags.phase;
            entry.realPlayer = tags.realPlayer;
            const cell = this.cells.get(key) ?? {};
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
