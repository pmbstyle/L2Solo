'use strict';

// Who stands on each spot and who is heading there, kept up to date at every
// state write. SpotProfiles.indexedOccupancy turns it into the same snapshot
// occupancySnapshot builds from a full state list, rebuilding only the spots
// whose members changed instead of walking the whole population every second.

function stateKey(state = {}) {
    return String(state.characterId || state.name || state.stats?.generatedIndex || '');
}

function occupiedSpotId(state = {}) {
    if (state.activity === 'traveling' && state.stats?.travel?.spotId) return state.stats.travel.spotId;
    if (['merchant', 'shopping', 'crafting', 'traveling'].includes(state.activity)) return null;
    return state.spotId || null;
}

function farmIntentCandidate(state = {}) {
    if (['merchant', 'shopping', 'crafting', 'dead'].includes(state.activity)) return null;
    const clanObjective = state.stats?.clanPartyObjective;
    const request = state.stats?.partyRequest;
    const plan = state.stats?.equipmentPlan;
    if (clanObjective?.spotId && ['open', 'deferred'].includes(String(clanObjective.status || ''))) {
        return clanObjective.spotId;
    }
    if (request?.spotId && ['open', 'deferred'].includes(String(request.status || ''))) return request.spotId;
    if (plan?.status === 'active' && ['direct_drop', 'craft'].includes(plan.strategy) && plan.next?.spotId) {
        return plan.next.spotId;
    }
    return null;
}

function capacityBackedOff(state, spotId, timestamp) {
    return (state.stats?.capacityBackoffs || []).some(entry => String(entry.spotId) === String(spotId)
        && Number(entry.until) > timestamp);
}

function farmIntentSpotId(state = {}, timestamp = Date.now()) {
    const spotId = farmIntentCandidate(state);
    return spotId && !capacityBackedOff(state, spotId, timestamp) ? spotId : null;
}

function addMember(membersBySpot, spotId, key, state) {
    if (!spotId) return;
    if (!membersBySpot.has(spotId)) membersBySpot.set(spotId, new Map());
    membersBySpot.get(spotId).set(key, state);
}

function removeMember(membersBySpot, spotId, key) {
    const members = membersBySpot.get(spotId);
    if (!members) return;
    members.delete(key);
    if (!members.size) membersBySpot.delete(spotId);
}

class SpotOccupancyIndex {
    constructor() {
        this.places = new Map();
        this.physical = new Map();
        this.reserved = new Map();
        // A capacity backoff hides a farm intent only until it expires, with
        // no state write at that moment: these intents are rechecked by time.
        this.backedOff = new Map();
        this.dirty = new Set();
    }

    update(state, timestamp = Date.now()) {
        const key = stateKey(state);
        this.remove(key);
        const spotId = occupiedSpotId(state);
        const candidate = farmIntentCandidate(state);
        const backedOff = !!candidate && capacityBackedOff(state, candidate, timestamp);
        const intentSpotId = backedOff ? null : candidate;
        this.places.set(key, { state, spotId, intentSpotId });
        if (backedOff) this.backedOff.set(key, state);
        addMember(this.physical, spotId, key, state);
        addMember(this.reserved, spotId, key, state);
        addMember(this.reserved, intentSpotId, key, state);
        if (spotId) this.dirty.add(spotId);
        if (intentSpotId) this.dirty.add(intentSpotId);
    }

    remove(key) {
        const place = this.places.get(key);
        if (!place) return;
        removeMember(this.physical, place.spotId, key);
        removeMember(this.reserved, place.spotId, key);
        removeMember(this.reserved, place.intentSpotId, key);
        if (place.spotId) this.dirty.add(place.spotId);
        if (place.intentSpotId) this.dirty.add(place.intentSpotId);
        this.places.delete(key);
        this.backedOff.delete(key);
    }

    // Intents whose capacity backoff has ended since the state was written.
    refreshBackoffs(timestamp) {
        for (const state of [...this.backedOff.values()]) {
            if (farmIntentSpotId(state, timestamp)) this.update(state, timestamp);
        }
    }

    clear() {
        for (const spotId of [...this.physical.keys(), ...this.reserved.keys()]) this.dirty.add(spotId);
        this.places.clear();
        this.physical.clear();
        this.reserved.clear();
        this.backedOff.clear();
    }
}

module.exports = { SpotOccupancyIndex, stateKey, occupiedSpotId, farmIntentSpotId };
