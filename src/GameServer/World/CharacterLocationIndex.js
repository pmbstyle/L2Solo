'use strict';

const { SPOT_CELL_SIZE } = require('./WorldConstants');
const KINDS = new Set(['all', 'hot', 'cold', 'player']);

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
class CharacterLocationIndex {
    constructor({ cellSize = SPOT_CELL_SIZE } = {}) {
        if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('invalid_character_cell_size');
        Object.defineProperty(this, 'cellSize', { value: cellSize, enumerable: true });
        this.records = new Map();
        this.cells = new Map();
        this.spots = new Map();
    }

    put(record) {
        if (!Number.isSafeInteger(record?.id) || record.id <= 0
            || !record.source || (typeof record.source !== 'object' && typeof record.source !== 'function')) {
            throw new RangeError('invalid_character_source');
        }
        const point = pointOf(record.loc);
        const key = this.cellKey(point);
        const tags = memberships(record);
        let entry = this.records.get(record.id);
        if (entry && entry.source !== record.source) {
            this.remove(record.id, entry.source);
            entry = null;
        }
        if (!entry) {
            entry = { id: record.id, source: record.source, record, key: null, phase: null, realPlayer: false, spotId: null };
            this.records.set(record.id, entry);
        }
        entry.record = record;
        this.refresh(entry, key, tags);
        return record;
    }

    update(id, source) {
        const entry = this.records.get(id);
        if (!entry || entry.source !== source) return false;
        const point = pointOf(entry.record.loc);
        this.refresh(entry, this.cellKey(point), memberships(entry.record));
        return true;
    }

    remove(id, source) {
        const entry = this.records.get(id);
        if (!entry || entry.source !== source) return false;
        this.detachCell(entry);
        this.detachSpot(entry);
        this.records.delete(id);
        return true;
    }

    get(id) {
        return this.records.get(id)?.record ?? null;
    }

    near(loc, radius, { kind = 'all' } = {}) {
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
                const candidates = this.cells.get(`${x}_${y}`)?.[kind];
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
        return Array.from(this.spots.get(spotId) ?? [], (entry) => entry.record);
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
            const cell = this.cells.get(key) ?? { all: new Set(), hot: new Set(), cold: new Set(), player: new Set() };
            this.cells.set(key, cell);
            cell.all.add(entry);
            cell[entry.phase].add(entry);
            if (entry.realPlayer) cell.player.add(entry);
        } else {
            const cell = this.cells.get(key);
            if (entry.phase !== tags.phase) {
                cell[entry.phase].delete(entry);
                cell[tags.phase].add(entry);
                entry.phase = tags.phase;
            }
            if (entry.realPlayer !== tags.realPlayer) {
                if (tags.realPlayer) cell.player.add(entry);
                else cell.player.delete(entry);
                entry.realPlayer = tags.realPlayer;
            }
        }
        if (entry.spotId !== tags.spotId) {
            this.detachSpot(entry);
            entry.spotId = tags.spotId;
            if (entry.spotId !== null) {
                const spot = this.spots.get(entry.spotId) ?? new Set();
                spot.add(entry);
                this.spots.set(entry.spotId, spot);
            }
        }
    }

    detachCell(entry) {
        const cell = this.cells.get(entry.key);
        if (!cell) return;
        cell.all.delete(entry);
        cell[entry.phase].delete(entry);
        if (entry.realPlayer) cell.player.delete(entry);
        if (!cell.all.size) this.cells.delete(entry.key);
    }

    detachSpot(entry) {
        const spot = this.spots.get(entry.spotId);
        if (!spot) return;
        spot.delete(entry);
        if (!spot.size) this.spots.delete(entry.spotId);
    }
}

module.exports = CharacterLocationIndex;
