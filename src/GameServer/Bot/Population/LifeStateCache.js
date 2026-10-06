'use strict';
const { SpotOccupancyIndex, stateKey } = require('./SpotOccupancyIndex');
const ShopPlaces = require('../Economy/ShopPlaces');
const CharacterLocationIndex = require('../../World/CharacterLocationIndex');
const cacheOwners = new WeakMap();

function* stateValues(records) {
    for (const record of records) yield record.source;
}

function* stateEntries(records) {
    for (const [id, record] of records) yield [id, record.source];
}

function stateLocation(state) {
    return { locX: Number(state.loc?.locX || 0), locY: Number(state.loc?.locY || 0), locZ: 0 };
}

function spatialState(state) {
    if (!state || state.phase !== 'cold' || state.activity === 'pk_hunting') return false;
    const loc = stateLocation(state);
    return Number.isFinite(loc.locX) && Number.isFinite(loc.locY);
}

class LifeStateCache extends Map {
    constructor({ locationIndex = new CharacterLocationIndex({ legacyStateCache: true }) } = {}) {
        super();
        if (!(locationIndex instanceof CharacterLocationIndex) || locationIndex.legacyStateCache !== true) {
            throw new TypeError('invalid_life_location_index');
        }
        if (cacheOwners.has(locationIndex)) throw new TypeError('life_location_index_already_owned');
        cacheOwners.set(locationIndex, this);
        Object.defineProperty(this, 'locationIndex', { value: locationIndex, enumerable: true });
        this.revision = 0;
        // Newest updatedAt first; equal times keep Map order (first insertion),
        // as a stable sort of values() would. Kept in place on every write:
        // a commit moves one entry instead of re-sorting the whole population.
        this.ordered = [];
        this.orderEntries = new Map();
        this.nextSequence = 0;
        this.occupancy = new SpotOccupancyIndex();
        // Walkers (honest travel, ColdTrip): cold bots running the last part of
        // a trip to a spot, by id -> travel.run { from, to, startAt, endAt }.
        // Kept on every write like the cells; read only by walkersNear.
        this.walkers = new Map();
    }

    get(id) {
        return this.locationIndex.getSource(id, 'state')?.source;
    }

    has(id) {
        return this.locationIndex.getSource(id, 'state') !== null;
    }

    get size() {
        return this.locationIndex.sourceSize('state');
    }

    keys() {
        return this.locationIndex.sourceKeys('state');
    }

    values() {
        return stateValues(this.locationIndex.sourceValues('state'));
    }

    entries() {
        return stateEntries(this.locationIndex.sourceEntries('state'));
    }

    [Symbol.iterator]() {
        return this.entries();
    }

    forEach(callback, thisArg) {
        if (typeof callback !== 'function') throw new TypeError('invalid_cache_callback');
        for (const [id, record] of this.locationIndex.sourceEntries('state')) {
            Reflect.apply(callback, thisArg, [record.source, id, this]);
        }
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

    removeLocation(id) {
        const record = this.locationIndex.getSource(id, 'state');
        return record ? this.locationIndex.removeSource(id, 'state', record.source) : false;
    }

    set(id, state) {
        const sequence = this.orderEntries.get(id)?.sequence ?? this.nextSequence++;
        this.removeOrder(id);
        const previous = this.get(id);
        if (previous && stateKey(previous) !== stateKey(state)) this.occupancy.remove(stateKey(previous));
        const objectSource = state !== null && (typeof state === 'object' || typeof state === 'function');
        const indexed = objectSource && spatialState(state);
        const current = this.locationIndex.getSource(id, 'state');
        if (current && Object.is(current.source, state)) {
            this.locationIndex.updateSource(id, 'state', state, { indexed });
        } else {
            this.locationIndex.setSource(id, 'state', { id, source: state,
                // Geometry tag only; authoritative phase stays on the source.
                get phase() { return objectSource && state.phase === 'cold' ? 'cold' : 'hot'; },
                loc: () => stateLocation(state) }, { indexed });
        }
        this.insertOrder(id, state, sequence);
        this.occupancy.update(state);
        ShopPlaces.syncState(id, state);
        const run = state.phase === 'cold' && state.activity === 'traveling' ? state.stats?.travel?.run : null;
        if (run) this.walkers.set(id, run);
        else this.walkers.delete(id);
        this.revision++;
        return this;
    }

    delete(id) {
        const record = this.locationIndex.getSource(id, 'state');
        const removed = this.removeLocation(id);
        this.walkers.delete(id);
        this.removeOrder(id);
        if (record) this.occupancy.remove(stateKey(record.source));
        ShopPlaces.release(ShopPlaces.stateOwner(id));
        if (removed) this.revision++;
        return removed;
    }

    clear() {
        this.locationIndex.clearSourceView('state'); this.walkers.clear();
        this.ordered = []; this.orderEntries.clear(); this.occupancy.clear();
        ShopPlaces.releaseStates();
        this.revision++;
    }

    recent(limit) {
        return this.ordered.slice(0, limit).map((entry) => entry.state);
    }

    beyondRecent(limit) {
        return this.ordered.slice(limit).map((entry) => entry.state);
    }

    // Walkers whose place on their run at `timestamp` (the straight-line
    // estimate between its ends) is within `radius` of `loc`. One pass over the
    // walkers, nothing stored: positions exist only while this asks.
    walkersNear(loc, radius, timestamp) {
        const x = Number(loc.locX), y = Number(loc.locY);
        const found = [];
        for (const [id, run] of this.walkers) {
            if (timestamp < run.startAt || timestamp > run.endAt) continue;
            const progress = (timestamp - run.startAt) / Math.max(1, run.endAt - run.startAt);
            const px = run.from.locX + (run.to.locX - run.from.locX) * progress;
            const py = run.from.locY + (run.to.locY - run.from.locY) * progress;
            if ((px - x) ** 2 + (py - y) ** 2 <= radius ** 2) found.push(this.get(id));
        }
        return found;
    }

    near(loc, radius, limit) {
        const x = Number(loc.locX), y = Number(loc.locY);
        if (![x, y, radius].every(Number.isFinite) || radius <= 0) return [];
        const records = this.locationIndex.nearSources({ locX: x, locY: y, locZ: 0 }, radius, {
            view: 'state', kind: 'cold', allowUnsafeCellBounds: true,
            accept: record => this.get(record.id) === record.source && spatialState(record.source)
        });
        const found = [];
        for (const record of records) {
            const state = record.source;
            const distanceSquared = (Number(state.loc?.locX || 0) - x) ** 2 + (Number(state.loc?.locY || 0) - y) ** 2;
            if (distanceSquared <= radius ** 2) found.push({ state, distanceSquared });
        }
        return found.sort((a, b) => a.distanceSquared - b.distanceSquared || a.state.characterId - b.state.characterId)
            .slice(0, limit).map(value => value.state);
    }
}

module.exports = LifeStateCache;
