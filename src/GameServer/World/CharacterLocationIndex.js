'use strict';

const { SPOT_CELL_SIZE } = require('./WorldConstants');
const KINDS = new Set(['all', 'hot', 'cold', 'player']);
const VIEWS = new Set(['actor', 'state']);

// Only the early Worker allocation enters this gate. Facts remain canonical.
const ACTOR_READ_GATES = new WeakMap();
function actorUnknown() {
    const error = new TypeError('character_actor_view_unknown');
    error.code = 'CHARACTER_ACTOR_VIEW_UNKNOWN';
    return error;
}
function actorRead(index, view) {
    const gate = view === 'actor' && ACTOR_READ_GATES.get(index);
    if (!gate) return null;
    const owner = gate.owner;
    const Mirror = require('../Bot/Population/TableMirror');
    const Sources = require('./CharacterActorSources');
    if (!owner || Sources.actorStoreIndex(owner) !== index) throw actorUnknown();
    const receipt = Mirror.actorStoreRead(owner);
    const read = { check() {
        if (gate.owner !== owner || Sources.actorStoreIndex(owner) !== index
            || !Mirror.actorStoreReadCurrent(owner, receipt)) throw actorUnknown();
    } };
    read.check();
    return read;
}
function readResult(read, result) { read?.check(); return result; }
function readIterator(read, original) {
    if (!read) return original;
    const wrapped = { [Symbol.iterator]() { return this; } };
    for (const method of ['next', 'return', 'throw']) {
        if (typeof original[method] !== 'function') continue;
        wrapped[method] = (...args) => {
            read.check();
            const item = Reflect.apply(original[method], original, args);
            read.check();
            return item;
        };
    }
    read.check();
    return wrapped;
}
function createWorkerActorIndex() {
    const { isMainThread } = require('worker_threads');
    if (arguments.length !== 0 || isMainThread) throw new TypeError('invalid_worker_actor_allocation');
    const index = new CharacterLocationIndex({ legacyStateCache: true });
    const gate = { owner: null, consumed: false };
    ACTOR_READ_GATES.set(index, gate);
    const actorOnly = view => { if (view !== 'actor') throw new TypeError('invalid_actor_producer_view'); };
    const producerReads = Object.freeze({
        getSource(id, view) { actorOnly(view); return index.records.get(id)?.actor?.record ?? null; },
        sourceSize(view) { actorOnly(view); return index.sourceViews.actor.size; },
        sourceEntries(view) { actorOnly(view); return sourceRecordEntries(index.sourceViews.actor.entries()); }
    });
    const installOwner = owner => {
        if (gate.consumed) throw new TypeError('worker_actor_owner_already_installed');
        gate.consumed = true;
        const Sources = require('./CharacterActorSources');
        const Mirror = require('../Bot/Population/TableMirror');
        if (Sources.actorStoreIndex(owner) !== index || !Mirror.actorStoreOwner(owner)) {
            throw new TypeError('invalid_worker_actor_read_owner');
        }
        gate.owner = owner;
    };
    return Object.freeze({ index, producerReads, installOwner });
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

function queryAxis(point, name, read) {
    read?.check();
    const value = point[name];
    read?.check();
    return value;
}

function pointOf(loc, read = null) {
    read?.check();
    const point = typeof loc === 'function' ? loc() : loc;
    read?.check();
    if (!point || !Number.isFinite(queryAxis(point, 'locX', read)) || !Number.isFinite(queryAxis(point, 'locY', read))
        || !Number.isFinite(queryAxis(point, 'locZ', read))) throw new RangeError('invalid_character_location');
    return readResult(read, point);
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
        this.actorPresence = { human: new Set(), onlineHuman: new Set(), online: new Set(), targets: new Map() };
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
        if (view === 'actor' && entry && entry.record !== record) this.detachPresence(entry);
        if (entry && !sameSource(entry.source, source, legacy)) {
            this.detachPresence(entry);
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
        this.detachPresence(entry);
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
        const read = actorRead(this, view);
        return readResult(read, this.records.get(id)?.[view]?.record ?? null);
    }

    sourceSize(view) {
        validateView(view);
        const read = actorRead(this, view);
        return readResult(read, this.sourceViews[view].size);
    }

    sourceKeys(view) {
        validateView(view);
        const read = actorRead(this, view);
        return readIterator(read, this.sourceViews[view].keys());
    }

    sourceValues(view) {
        validateView(view);
        const read = actorRead(this, view);
        return readIterator(read, sourceRecords(this.sourceViews[view].values()));
    }

    sourceEntries(view) {
        validateView(view);
        const read = actorRead(this, view);
        return readIterator(read, sourceRecordEntries(this.sourceViews[view].entries()));
    }

    updateActorPresence(id, expectedRecord, { online, realPlayer, targetId }) {
        const entry = this.records.get(id)?.actor;
        if (!entry || entry.record !== expectedRecord) return false;
        if (typeof online !== 'boolean' || typeof realPlayer !== 'boolean'
            || !Number.isFinite(targetId) || targetId < 0) throw new TypeError('invalid_actor_presence');
        if (this.records.get(id)?.actor !== entry || entry.record !== expectedRecord) return false;
        const previous = entry.presence;
        if (previous && previous.online === online && previous.realPlayer === realPlayer && previous.targetId === targetId) {
            previous.record = expectedRecord;
            return true;
        }
        this.detachPresence(entry);
        entry.presence = { record: expectedRecord, online, realPlayer, targetId };
        if (online) this.actorPresence.online.add(entry);
        if (realPlayer) this.actorPresence.human.add(entry);
        if (online && realPlayer) {
            this.actorPresence.onlineHuman.add(entry);
            if (targetId) {
                const members = this.actorPresence.targets.get(targetId) ?? new Set();
                members.add(entry); this.actorPresence.targets.set(targetId, members);
            }
        }
        return true;
    }

    presenceSources({ kind = 'onlineHuman', targetId = null } = {}) {
        const read = actorRead(this, 'actor');
        if (!['human', 'onlineHuman', 'online'].includes(kind)
            || (targetId !== null && (!Number.isFinite(targetId) || targetId < 0))) {
            throw new TypeError('invalid_actor_presence_query');
        }
        const members = targetId === null ? this.actorPresence[kind] : this.actorPresence.targets.get(targetId) ?? [];
        const records = [];
        for (const entry of members) {
            if (entry.record !== entry.presence?.record || this.records.get(entry.id)?.actor !== entry) continue;
            records.push(entry.record);
        }
        records.sort((a, b) => (a.order ?? a.source.order ?? 0) - (b.order ?? b.source.order ?? 0));
        return readResult(read, records);
    }

    presenceSize(kind = 'onlineHuman') {
        const read = actorRead(this, 'actor');
        if (!['human', 'onlineHuman', 'online'].includes(kind)) throw new TypeError('invalid_actor_presence_query');
        return readResult(read, this.actorPresence[kind].size);
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
        const read = actorRead(this, view);
        return readIterator(read, sourceRecords(this.groups.get(key)?.entries ?? []));
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
        const read = actorRead(this, view);
        const point = pointOf(loc, read);
        const minX = Math.floor((queryAxis(point, 'locX', read) - radius) / this.cellSize);
        const maxX = Math.floor((queryAxis(point, 'locX', read) + radius) / this.cellSize);
        const minY = Math.floor((queryAxis(point, 'locY', read) - radius) / this.cellSize);
        const maxY = Math.floor((queryAxis(point, 'locY', read) + radius) / this.cellSize);
        const safeBounds = [minX, maxX, minY, maxY].every(Number.isSafeInteger);
        if (!safeBounds && !allowUnsafeCellBounds) throw new RangeError('invalid_character_cell');
        const radiusSquared = radius * radius;
        const records = [];
        const append = (cell) => {
            for (const entry of cell?.[view]?.[kind] ?? []) {
                if (accept) {
                    read?.check();
                    const accepted = accept(entry.record);
                    read?.check();
                    if (!accepted) continue;
                }
                const actor = view === 'actor' && !read && entry.record.actor;
                const current = actor ? null : pointOf(entry.record.loc, read);
                const dx = (actor ? Number(actor.fetchLocX?.() ?? 0) : queryAxis(current, 'locX', read)) - point.locX;
                const dy = (actor ? Number(actor.fetchLocY?.() ?? 0) : queryAxis(current, 'locY', read)) - point.locY;
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
        return readResult(read, records);
    }

    inSpot(spotId) {
        return this.inSpotSources(spotId, { view: 'actor' });
    }

    inSpotSources(spotId, { view = 'actor' } = {}) {
        validateView(view);
        const read = actorRead(this, view);
        return readResult(read, Array.from(this.spots.get(spotId)?.[view] ?? [], (entry) => entry.record));
    }

    clear() {
        for (const entry of this.sourceViews.actor.values()) this.detachPresence(entry);
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

    detachPresence(entry) {
        const previous = entry.presence;
        if (!previous) return;
        for (const kind of ['human', 'onlineHuman', 'online']) this.actorPresence[kind].delete(entry);
        const members = this.actorPresence.targets.get(previous.targetId);
        if (members) {
            members.delete(entry);
            if (!members.size) this.actorPresence.targets.delete(previous.targetId);
        }
        entry.presence = null;
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

Object.defineProperty(CharacterLocationIndex, 'createWorkerActorIndex', { value: createWorkerActorIndex });
module.exports = CharacterLocationIndex;
