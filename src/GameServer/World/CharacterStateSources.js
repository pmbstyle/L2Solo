'use strict';

const { isMainThread, workerData } = require('worker_threads');
const CharacterLocationIndex = require('./CharacterLocationIndex');
const cacheOwners = new WeakMap();
const nativeGrants = new WeakMap();
const capabilities = new WeakMap();
const packets = Symbol('character-state-packet');
const nativeEpoch = String(workerData?.workerEpoch || 'cold-worker');

function stateLocation(state) {
    return { locX: Number(state.loc?.locX || 0), locY: Number(state.loc?.locY || 0), locZ: 0 };
}

function spatialState(state) {
    if (!state || state.phase !== 'cold' || state.activity === 'pk_hunting') return false;
    const loc = stateLocation(state);
    return Number.isFinite(loc.locX) && Number.isFinite(loc.locY);
}

// Internal constructor consent: the real Cache validates its Runtime role
// before registering here. This helper does not independently brand that role.
function registerCacheOwner(index, cache, consent = null) {
    if (!(index instanceof CharacterLocationIndex) || index.legacyStateCache !== true) {
        throw new TypeError('invalid_life_location_index');
    }
    if (!cache || (typeof cache !== 'object' && typeof cache !== 'function')) {
        throw new TypeError('invalid_life_cache_owner');
    }
    if (cacheOwners.has(index)) throw new TypeError('life_location_index_already_owned');
    cacheOwners.set(index, { cache, consent, grant: null, capability: null });
}

function issueNativeGrant(index, cache, capturedRole, effectiveEpoch) {
    const owner = cacheOwners.get(index);
    if (isMainThread || effectiveEpoch !== nativeEpoch || !capturedRole
        || owner?.cache !== cache || owner.consent?.role !== capturedRole
        || !owner.consent.isCurrent()) throw new TypeError('invalid_worker_passive_grant');
    if (owner.grant) return owner.grant;
    const grant = Object.freeze({});
    nativeGrants.set(grant, { index, cache, role: capturedRole, epoch: effectiveEpoch });
    owner.grant = grant;
    return grant;
}

function currentOwner(index, cache) {
    const owner = cacheOwners.get(index);
    const grant = nativeGrants.get(owner?.grant);
    if (isMainThread || !grant || grant.index !== index || grant.cache !== cache
        || grant.role !== owner.consent?.role || grant.epoch !== nativeEpoch
        || owner.cache !== cache || !owner.consent.isCurrent()) {
        throw new TypeError('invalid_worker_passive_state_sources');
    }
    return owner;
}

function passiveForCache(index, cache) {
    const owner = currentOwner(index, cache);
    if (owner.capability) return owner.capability;
    if (index.sourceSize('state') !== 0) throw new TypeError('worker_passive_state_sources_not_empty');
    const capability = Object.freeze({});
    capabilities.set(capability, { index, cache, attached: null });
    owner.capability = capability;
    return capability;
}

function standalone() {
    const capability = Object.freeze({});
    capabilities.set(capability, { index: new CharacterLocationIndex({ legacyStateCache: true }), cache: null, attached: null });
    return capability;
}

function cacheAttached(index, cache) {
    const owner = cacheOwners.get(index);
    return owner?.cache === cache && !!capabilities.get(owner.capability)?.attached;
}

function* packetValues(records) {
    for (const record of records) yield record[packets];
}

function* packetEntries(records) {
    for (const [id, record] of records) yield [id, record[packets]];
}

function attachKernel(capability) {
    const provider = capabilities.get(capability);
    if (!provider) throw new TypeError('invalid_character_state_sources');
    const { index, cache } = provider;
    if (cache) currentOwner(index, cache);
    if (provider.attached) throw new TypeError('character_state_sources_already_attached');
    function validate() {
        if (provider.attached !== handle) throw new TypeError('invalid_character_state_attachment');
        if (cache) return currentOwner(index, cache);
        return null;
    }
    function changed(owner) {
        if (owner) owner.consent.onMutation();
    }
    const handle = Object.freeze({
        index,
        get(id) { validate(); return index.getSource(id, 'state')?.[packets]; },
        has(id) { validate(); return index.getSource(id, 'state') !== null; },
        size() { validate(); return index.sourceSize('state'); },
        keys() { validate(); return index.sourceKeys('state'); },
        values() { validate(); return packetValues(index.sourceValues('state')); },
        entries() { validate(); return packetEntries(index.sourceEntries('state')); },
        publish(id, packet) {
            const owner = validate();
            const state = packet?.state;
            if (!state || (typeof state !== 'object' && typeof state !== 'function')) {
                throw new TypeError('invalid_character_state_packet');
            }
            const indexed = spatialState(state);
            const current = index.getSource(id, 'state');
            if (current?.source === state) {
                index.updateSource(id, 'state', state, { indexed });
                current[packets] = packet;
            } else {
                index.setSource(id, 'state', { id, source: state, [packets]: packet,
                    get phase() { return state.phase === 'cold' ? 'cold' : 'hot'; },
                    loc: () => stateLocation(state) }, { indexed });
            }
            changed(owner);
            return packet;
        },
        remove(id, expectedSource) {
            const owner = validate();
            const removed = index.removeSource(id, 'state', expectedSource);
            if (removed) changed(owner);
            return removed;
        },
        clear() {
            const owner = validate();
            index.clearSourceView('state');
            changed(owner);
        }
    });
    provider.attached = handle;
    return handle;
}

module.exports = Object.freeze({ registerCacheOwner, issueNativeGrant, passiveForCache,
    standalone, attachKernel, cacheAttached, stateLocation, spatialState });
