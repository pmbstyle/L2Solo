'use strict';

const { SPOT_CELL_SIZE } = require('./WorldConstants');
const KINDS = new Set(['all', 'hot', 'cold', 'player']);
const VIEWS = new Set(['actor', 'state']);

const RAW_XY_SIZE = 6000;
const RAW_XY_LIMIT = 2 ** 65;
const neighborBits = new DataView(new ArrayBuffer(8));

function adjacentNumber(value, direction) {
    if (value === 0) return direction * Number.MIN_VALUE;
    if (value === Infinity) return direction > 0 ? value : Number.MAX_VALUE;
    if (value === -Infinity) return direction < 0 ? value : -Number.MAX_VALUE;
    neighborBits.setFloat64(0, value);
    const bits = neighborBits.getBigUint64(0);
    neighborBits.setBigUint64(0, bits + ((value > 0) === (direction > 0) ? 1n : -1n));
    return neighborBits.getFloat64(0);
}

const RAW_XY_OUTWARD_RADIUS = adjacentNumber(RAW_XY_SIZE, 1);

function rawAxisKeys(value) {
    if (Math.abs(value) > RAW_XY_LIMIT) return [Math.floor(value / RAW_XY_SIZE)];
    const low = Math.floor(adjacentNumber(value - RAW_XY_OUTWARD_RADIUS, -1) / RAW_XY_SIZE);
    const high = Math.floor(adjacentNumber(value + RAW_XY_OUTWARD_RADIUS, 1) / RAW_XY_SIZE);
    const count = high - low + 1;
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || count < 1 || count > 9) {
        throw new RangeError('invalid_character_facet_bounds');
    }
    return Array.from({ length: count }, (_, offset) => low + offset);
}

function rawPointOf(loc, current = null) {
    const point = typeof loc === 'function' ? loc() : loc;
    if (current && !current()) return null;
    if (!point) return null;
    const locX = point.locX;
    if (current && !current()) return null;
    const locY = point.locY;
    if (current && !current()) return null;
    return Number.isFinite(locX) && Number.isFinite(locY) ? { locX, locY } : null;
}

function validateRawFacet(view, facet, cellSize) {
    if (view !== 'actor' || facet !== 'raw_xy' || cellSize !== RAW_XY_SIZE) {
        throw new RangeError('invalid_character_facet');
    }
}

function validateGroupQuery(view, family) {
    if (view !== 'actor' || family !== 'pvp_party') throw new RangeError('invalid_character_group');
}

function sameKey(left, right) {
    return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

function validateView(view) {
    if (!VIEWS.has(view)) throw new RangeError('invalid_character_source_view');
}

function validSource(source, rawPrimitive) {
    return source !== null && source !== undefined
        && (rawPrimitive || typeof source === 'object' || typeof source === 'function');
}

function sameSource(left, right, legacyState) {
    return left === right || (legacyState && Number.isNaN(left) && Number.isNaN(right));
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

function* sourceRecords(entries) {
    for (const entry of entries) yield entry.record;
}

function* sourceRecordEntries(entries) {
    for (const [id, entry] of entries) yield [id, entry.record];
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
        // Order metadata points at the same canonical entries as records.
        // Each producer view keeps its own native Map insertion order.
        this.sourceViews = { actor: new Map(), state: new Map() };
        this.cells = new Map();
        this.spots = new Map();
        this.groups = new Map();
    }

    put(record) {
        return this.setSource(record?.id, 'actor', record);
    }

    setSource(id, view, record, { indexed = true } = {}) {
        validateView(view);
        if (typeof indexed !== 'boolean') throw new TypeError('invalid_character_source_mode');
        const legacy = view === 'state' && this.legacyStateCache;
        const sameId = record?.id === id || (legacy && Number.isNaN(id) && Number.isNaN(record?.id));
        if ((!legacy && (!Number.isSafeInteger(id) || id <= 0)) || !sameId) {
            throw new RangeError('invalid_character_source');
        }
        const source = record?.source;
        if (!validSource(source, legacy && !indexed)) {
            throw new RangeError('invalid_character_source');
        }
        const point = indexed ? pointOf(record.loc) : null;
        const key = indexed ? this.cellKey(point, view) : null;
        const tags = memberships(record);
        let row = this.records.get(id);
        let entry = row?.[view];
        if (entry && !sameSource(entry.source, source, legacy)) {
            this.detachRawXY(entry);
            this.detachCell(entry);
            this.detachSpot(entry);
            this.detachGroups(entry);
            entry.key = null;
            entry.spotId = null;
            entry.indexed = false;
        }
        if (!row) {
            row = { id, actor: null, state: null };
            this.records.set(id, row);
        }
        if (!entry) {
            entry = { id, view, source, record, indexed: false,
                key: null, phase: null, realPlayer: false, spotId: null };
            row[view] = entry;
            this.sourceViews[view].set(id, entry);
        }
        entry.source = source;
        entry.record = record;
        this.refresh(entry, key, tags, point, indexed);
        return record;
    }

    update(id, source) {
        return this.updateSource(id, 'actor', source);
    }

    updateSource(id, view, source, { indexed } = {}) {
        validateView(view);
        const legacy = view === 'state' && this.legacyStateCache;
        const entry = this.records.get(id)?.[view];
        if (!entry || !sameSource(entry.source, source, legacy)) return false;
        const nextIndexed = indexed === undefined ? entry.indexed : indexed;
        if (typeof nextIndexed !== 'boolean') throw new TypeError('invalid_character_source_mode');
        if (!validSource(entry.source, legacy && !nextIndexed)) throw new RangeError('invalid_character_source');
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
        if (!entry || !sameSource(entry.source, source, view === 'state' && this.legacyStateCache)) return false;
        this.detachRawXY(entry);
        this.detachCell(entry);
        this.detachSpot(entry);
        this.detachGroups(entry);
        this.sourceViews[view].delete(id);
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

    sourceSize(view) {
        validateView(view);
        return this.sourceViews[view].size;
    }

    sourceKeys(view) {
        validateView(view);
        return this.sourceViews[view].keys();
    }

    sourceValues(view) {
        validateView(view);
        return sourceRecords(this.sourceViews[view].values());
    }

    sourceEntries(view) {
        validateView(view);
        return sourceRecordEntries(this.sourceViews[view].entries());
    }

    updateFacet(id, view, expectedRecord, facet, payload) {
        validateRawFacet(view, facet, this.cellSize);
        if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('invalid_character_source');
        const entry = this.records.get(id)?.[view];
        if (!entry || entry.record !== expectedRecord) return false;
        const previous = entry.rawXY;
        const current = () => this.records.get(id)?.[view] === entry
            && entry.record === expectedRecord && entry.rawXY === previous;
        const enabled = payload?.enabled;
        if (!current()) return false;
        if (typeof enabled !== 'boolean') throw new TypeError('invalid_character_facet_mode');
        if (!enabled) {
            this.detachRawXY(entry);
            return true;
        }
        const loc = payload.loc;
        if (!current()) return false;
        const point = rawPointOf(loc, current);
        if (!current()) return false;
        if (!point) throw new RangeError('invalid_character_facet_location');
        const key = `${Math.floor(point.locX / RAW_XY_SIZE)}_${Math.floor(point.locY / RAW_XY_SIZE)}`;
        if (previous?.key !== key) this.detachRawXY(entry);
        const cell = this.cells.get(key) ?? {
            x: Math.floor(point.locX / RAW_XY_SIZE), y: Math.floor(point.locY / RAW_XY_SIZE)
        };
        const members = cell.rawXY ?? new Set();
        cell.rawXY = members;
        members.add(entry);
        this.cells.set(key, cell);
        entry.rawXY = { key, record: expectedRecord, loc };
        return true;
    }

    nearFacet(loc, radius, { view = 'actor', facet = 'raw_xy', accept = null } = {}) {
        validateRawFacet(view, facet, this.cellSize);
        if (accept !== null && typeof accept !== 'function') throw new TypeError('invalid_character_query_filter');
        if (!Number.isFinite(radius) || radius < 0 || radius > RAW_XY_SIZE) {
            throw new RangeError('invalid_character_facet_radius');
        }
        const point = rawPointOf(loc);
        if (!point) throw new RangeError('invalid_character_facet_location');
        const xs = rawAxisKeys(point.locX), ys = rawAxisKeys(point.locY);
        const radiusSquared = radius * radius;
        const found = [], seen = new Set();
        for (const x of xs) for (const y of ys) {
            for (const entry of this.cells.get(`${x}_${y}`)?.rawXY ?? []) {
                if (seen.has(entry)) continue;
                seen.add(entry);
                const record = entry.record, membership = entry.rawXY;
                const current = () => this.records.get(entry.id)?.actor === entry
                    && entry.record === record && entry.rawXY === membership && membership?.record === record;
                if (!current()) continue;
                if (accept && !accept(record)) continue;
                if (!current()) continue;
                const candidate = rawPointOf(membership.loc, current);
                if (!current() || !candidate) continue;
                const dx = candidate.locX - point.locX, dy = candidate.locY - point.locY;
                if (dx * dx + dy * dy <= radiusSquared) found.push(record);
            }
        }
        return found;
    }

    updateGroups(id, view, expectedRecord, family, keys, order) {
        validateGroupQuery(view, family);
        if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('invalid_character_source');
        const entry = this.records.get(id)?.[view];
        if (!entry || entry.record !== expectedRecord) return false;
        if (!Array.isArray(keys)) throw new RangeError('invalid_character_group_keys');
        const count = keys.length;
        if (!Number.isSafeInteger(count) || count < 0 || count > 2) throw new RangeError('invalid_character_group_keys');
        const nextKeys = [];
        for (let i = 0; i < count; i += 1) nextKeys.push(keys[i]);
        if (new Set(nextKeys).size !== count) throw new RangeError('invalid_character_group_keys');
        if (!Number.isSafeInteger(order) || order <= 0) throw new RangeError('invalid_character_group_order');
        if (this.records.get(id)?.[view] !== entry || entry.record !== expectedRecord) return false;
        const previous = entry.groupMembership;
        if (previous?.order === order && previous.keys.length === nextKeys.length
            && nextKeys.every(key => previous.keys.some(old => sameKey(old, key)))) return true;
        const next = { keys: nextKeys, order };
        this.detachGroups(entry);
        entry.groupMembership = next;
        for (const key of next.keys) {
            let bucket = this.groups.get(key);
            if (!bucket) {
                bucket = { entries: new Set(), last: null };
                this.groups.set(key, bucket);
            }
            if (!bucket.last || bucket.last.groupMembership.order <= order) {
                bucket.entries.add(entry);
                bucket.last = entry;
            } else {
                // Only the affected group is reordered, on producer delivery.
                const entries = [];
                let inserted = false;
                for (const member of bucket.entries) {
                    if (!inserted && member.groupMembership.order > order) {
                        entries.push(entry);
                        inserted = true;
                    }
                    entries.push(member);
                }
                if (!inserted) entries.push(entry);
                bucket.entries.clear();
                for (const member of entries) bucket.entries.add(member);
                bucket.last = entries[entries.length - 1];
            }
        }
        return true;
    }

    groupSources(key, { view = 'actor', family = 'pvp_party' } = {}) {
        validateGroupQuery(view, family);
        return sourceRecords(this.groups.get(key)?.entries ?? []);
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
        for (const entry of this.sourceViews.actor.values()) this.detachRawXY(entry);
        this.clearGroups();
        this.records.clear();
        this.sourceViews.actor.clear();
        this.sourceViews.state.clear();
        this.cells.clear();
        this.spots.clear();
    }

    clearSourceView(view) {
        validateView(view);
        if (view === 'actor') this.clearGroups();
        for (const entry of this.sourceViews[view].values()) this.removeSource(entry.id, view, entry.source);
        this.sourceViews[view].clear();
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
        if (!cell.actor && !cell.state && !cell.rawXY) this.cells.delete(entry.key);
    }

    detachSpot(entry) {
        const spot = this.spots.get(entry.spotId);
        const members = spot?.[entry.view];
        if (!members) return;
        members.delete(entry);
        if (!members.size) delete spot[entry.view];
        if (!spot.actor && !spot.state) this.spots.delete(entry.spotId);
    }

    detachRawXY(entry) {
        const membership = entry.rawXY;
        if (!membership) return;
        const cell = this.cells.get(membership.key), members = cell?.rawXY;
        if (members) {
            members.delete(entry);
            if (!members.size) delete cell.rawXY;
            if (!cell.actor && !cell.state && !cell.rawXY) this.cells.delete(membership.key);
        }
        entry.rawXY = null;
    }

    detachGroups(entry) {
        if (!entry.groupMembership) return;
        for (const key of entry.groupMembership.keys) {
            const bucket = this.groups.get(key);
            if (!bucket) continue;
            bucket.entries.delete(entry);
            if (!bucket.entries.size) this.groups.delete(key);
            else if (bucket.last === entry) {
                for (const member of bucket.entries) bucket.last = member;
            }
        }
        entry.groupMembership = null;
    }

    clearGroups() {
        for (const bucket of this.groups.values()) {
            bucket.entries.clear();
            bucket.last = null;
        }
        for (const entry of this.sourceViews.actor.values()) entry.groupMembership = null;
        this.groups.clear();
    }
}

module.exports = CharacterLocationIndex;
