'use strict';

const CharacterLocationIndex = require('../../World/CharacterLocationIndex');
const providers = new WeakMap();

// Who stands on each spot and who is heading there, kept up to date at every
// state write. Read only at a spot: the room check at arrival, the kill share,
// the buff offer, and the status line's per-spot count. No place is held for a
// bot ahead of its arrival. Each spot has a crowd revision (spotVersion): a
// reader that holds a result over a spot's hunters keeps it while the
// revision it read stands.

function stateKey(state = {}) {
    return String(state.characterId || state.name || state.stats?.generatedIndex || '');
}

function occupiedSpotId(state = {}) {
    if (state.activity === 'traveling' && state.stats?.travel?.spotId) return state.stats.travel.spotId;
    if (['merchant', 'shopping', 'crafting', 'traveling'].includes(state.activity)) return null;
    return state.spotId || null;
}

function addMember(membersBySpot, spotId, key) {
    if (!spotId) return;
    if (!membersBySpot.has(spotId)) membersBySpot.set(spotId, new Set());
    membersBySpot.get(spotId).add(key);
}

function removeMember(membersBySpot, spotId, key) {
    const members = membersBySpot.get(spotId);
    if (!members) return;
    members.delete(key);
    if (!members.size) membersBySpot.delete(spotId);
}

class SpotOccupancyIndex {
    constructor({ locationIndex = null } = {}) {
        if (locationIndex !== null && (!(locationIndex instanceof CharacterLocationIndex)
            || locationIndex.legacyStateCache !== true)) throw new TypeError('invalid_occupancy_source_index');
        const index = locationIndex ?? new CharacterLocationIndex({ legacyStateCache: true });
        providers.set(this, { index, ownsSources: locationIndex === null });
        Object.defineProperty(this, 'locationIndex', { value: index, enumerable: true });
        this.places = new Map();
        this.physical = new Map();
        // spotId -> the change number of the last change of its bots (one
        // counter for the index, so a revision never comes back).
        this.revisions = new Map();
        this.changes = 0;
    }

    // A spot's bots changed (one joined or left; a bot staying on its spot
    // moves nothing).
    bump(spotId) {
        if (spotId) this.revisions.set(spotId, ++this.changes);
    }

    // The crowd revision of a spot: it moves when a bot is indexed on the
    // spot or leaves it, so every count over the spot's set (huntersOn, the
    // room filter) reads the same while it stands. Its room is catalog data
    // (SpotProfiles.spotRoom), versioned by the catalog. Not versioned: a
    // traveller's arrival on the spot it is indexed at (physicalCount's
    // standingOnly), read once at the arrival and never held. 0: no bot has
    // been indexed there.
    spotVersion(spotId) {
        return this.revisions.get(spotId) || 0;
    }

    update(state, options = {}) {
        const key = stateKey(state); // Keep null's inherited error before writes.
        const { index, ownsSources } = providers.get(this);
        if (ownsSources) {
            if (state === undefined) {
                this.remove(key);
                this.places.set(key, { record: null, spotId: null,
                    get state() { return undefined; } });
                return;
            }
            // Standalone planning owns raw records only, never a second grid.
            // Do not read phase/location that the planning policy never used.
            const record = { id: key, source: state, phase: 'hot' };
            index.setSource(key, 'state', record, { indexed: false });
            this.updateRecord(record);
            return;
        }
        const id = Object.prototype.hasOwnProperty.call(options, 'sourceId')
            ? options.sourceId : Number(state?.characterId || 0);
        const record = index.getSource(id, 'state');
        if (!record || !Object.is(record.source, state)) return false;
        return this.updateRecord(record);
    }

    updateRecord(record) {
        const { index } = providers.get(this);
        if (!record || index.getSource(record.id, 'state') !== record) return false;
        const state = record.source;
        const key = stateKey(state);
        const spotId = occupiedSpotId(state);
        const before = this.removePlace(key, false);
        this.places.set(key, { record, spotId,
            get state() { return record.source; } });
        addMember(this.physical, spotId, key);
        if (before?.spotId !== spotId) { this.bump(before?.spotId); this.bump(spotId); }
        return true;
    }

    removePlace(key, moved = true) {
        const place = this.places.get(key);
        if (!place) return;
        removeMember(this.physical, place.spotId, key);
        this.places.delete(key);
        if (moved) this.bump(place.spotId);
        return place;
    }

    remove(key) {
        const place = this.removePlace(key);
        const { index, ownsSources } = providers.get(this);
        if (ownsSources && place?.record && index.getSource(place.record.id, 'state') === place.record) {
            index.removeSource(place.record.id, 'state', place.record.source);
        }
    }

    removeRecord(record) {
        if (!record) return false;
        const key = stateKey(record.source);
        if (this.places.get(key)?.record !== record) return false;
        const current = providers.get(this).index.getSource(record.id, 'state');
        if (current !== null && current !== record) return false;
        this.remove(key);
        return true;
    }

    *members(spotId, kind) {
        if (kind !== 'physical') throw new TypeError('invalid_occupancy_membership');
        const { index } = providers.get(this);
        for (const key of this[kind].get(spotId) || []) {
            const record = this.places.get(key)?.record;
            if (record && index.getSource(record.id, 'state') === record) yield [key, record.source];
        }
    }

    // How many bots the index has on a spot ('physical'): standingOnly leaves
    // out the bots still on their way there (indexed at their destination),
    // excludeKeys the given state keys, excludeKey one (no set to build).
    physicalCount(spotId, { excludeKeys = null, excludeKey = null, standingOnly = false } = {}) {
        let count = 0;
        for (const [key, state] of this.members(spotId, 'physical')) {
            if (!(standingOnly && state?.activity === 'traveling') && key !== excludeKey && !excludeKeys?.has(key)) count++;
        }
        return count;
    }

    // How many bots are indexed on a spot, one key left out (excludeKey), in
    // O(1): the set's size, without members()' check of each record against
    // the location index (the two are written together: LifeStateCache.set and
    // delete, update and remove here). The hunters' count (huntersOn), read
    // per spot a search scores.
    physicalSize(spotId, excludeKey = null) {
        const members = this.physical.get(spotId);
        if (!members) return 0;
        return members.size - (excludeKey !== null && members.has(excludeKey) ? 1 : 0);
    }

    // The spots with at least one bot indexed there (the status line's walk).
    spotIds() { return this.physical.keys(); }

    size() { return { owners: this.places.size, physical: this.physical.size }; }

    clear() {
        for (const spotId of this.physical.keys()) this.bump(spotId);
        this.places.clear();
        this.physical.clear();
        const { index, ownsSources } = providers.get(this);
        if (ownsSources) index.clearSourceView('state');
    }
}

// The hunters on a spot that share its production (E69, user 10-29), in the
// index of the thread that asks (main's world index, a worker's kernel
// index): the bots indexed there, those on their way included, at least one;
// with a state, the others plus that bot, whether it stands there yet or
// weighs a move there (SpotEconomics' crowd share). One count for the fight
// (SpotProfiles.spotHunters, ColdSimulationKernel.spotHunters) and the spot
// value.
function huntersOn(index, spotId, state = null) {
    if (!index || !spotId) return 1;
    if (!state) return Math.max(1, index.physicalSize(spotId));
    return index.physicalSize(spotId, stateKey(state)) + 1;
}

module.exports = { SpotOccupancyIndex, stateKey, occupiedSpotId, huntersOn };
