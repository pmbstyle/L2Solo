'use strict';

const CharacterLocationIndex = require('./CharacterLocationIndex');
const { isMainThread, workerData } = require('worker_threads');
const index = new CharacterLocationIndex({ legacyStateCache: true });
const nativeEpoch = String(workerData?.workerEpoch || 'cold-worker');
let current = null;
let worldBound = false;
let projectorRole = null;

function beginWorkerProjectorRole(epoch) {
    if (isMainThread || worldBound || epoch !== nativeEpoch) throw new TypeError('invalid_worker_projector_role');
    if (!projectorRole) projectorRole = Object.freeze({});
    return projectorRole;
}

function workerProjectorRole() { return projectorRole; }

function isWorkerProjectorRole(role, locationIndex) {
    return !isMainThread && !worldBound && !!projectorRole && role === projectorRole && locationIndex === index;
}

function bindWorld(user) {
    if (projectorRole && user != null) throw new TypeError('worker_projector_world_binding');
    if (user != null && (typeof user !== 'object' && typeof user !== 'function')) {
        throw new TypeError('invalid_character_world_source');
    }
    if (user != null) worldBound = true;
    if (current?.source === user) return current;
    if (!current && user == null) return null;
    index.clearSourceView('actor');
    current = user == null ? null : Object.freeze({ source: user, token: Symbol('character-world') });
    return current;
}

function isCurrentWorld(user, binding) {
    return !!binding && binding === current && binding.source === user;
}

module.exports = Object.freeze({ index, bindWorld, isCurrentWorld,
    beginWorkerProjectorRole, workerProjectorRole, isWorkerProjectorRole });
