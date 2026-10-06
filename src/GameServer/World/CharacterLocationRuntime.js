'use strict';

const CharacterLocationIndex = require('./CharacterLocationIndex');
const { isMainThread, workerData } = require('worker_threads');
const actorAllocation = isMainThread ? null : CharacterLocationIndex.createWorkerActorIndex();
const index = actorAllocation?.index ?? new CharacterLocationIndex({ legacyStateCache: true });
const nativeEpoch = String(workerData?.workerEpoch || 'cold-worker');
let current = null;
let worldBound = false;
let projectorRole = null;
let actorMirror = null;
let actorMirrorConsent = null;

function beginWorkerProjectorRole(epoch) {
    if (isMainThread || worldBound || epoch !== nativeEpoch) throw new TypeError('invalid_worker_projector_role');
    if (!projectorRole) projectorRole = Object.freeze({});
    return projectorRole;
}

function workerProjectorRole() { return projectorRole; }

function isWorkerProjectorRole(role, locationIndex) {
    return !isMainThread && !worldBound && !!projectorRole && role === projectorRole && locationIndex === index;
}

function requireActorProjector() {
    if (!isWorkerProjectorRole(projectorRole, index)) throw new TypeError('invalid_actor_projector_role');
}

function actorProducerReads() {
    if (arguments.length !== 0) throw new TypeError('invalid_actor_producer_arguments');
    requireActorProjector();
    return actorAllocation.producerReads;
}

function registerNativeActorMirror(mirror) {
    if (arguments.length !== 1) throw new TypeError('invalid_native_actor_mirror_arguments');
    requireActorProjector();
    const Mirror = require('../Bot/Population/TableMirror');
    const consent = Mirror.nativeActorMirrorOwner(mirror);
    if (actorMirror || !consent || consent.mirror !== mirror || consent.index !== index
        || consent.role !== projectorRole || consent.epoch !== nativeEpoch) {
        throw new TypeError('invalid_native_actor_mirror');
    }
    // Last synchronous constructor operation; consumed registration never clears.
    actorMirrorConsent = consent;
    actorMirror = mirror;
}

function nativeActorMirror() {
    if (arguments.length !== 0) throw new TypeError('invalid_native_actor_mirror_arguments');
    requireActorProjector();
    if (!actorMirror) return null;
    const Mirror = require('../Bot/Population/TableMirror');
    if (Mirror.nativeActorMirrorOwner(actorMirror) !== actorMirrorConsent) {
        throw new TypeError('stale_native_actor_mirror');
    }
    return actorMirror;
}

function attachActorReadOwner(owner) {
    if (arguments.length !== 1) throw new TypeError('invalid_actor_read_owner_arguments');
    requireActorProjector();
    const Mirror = require('../Bot/Population/TableMirror');
    const Sources = require('./CharacterActorSources');
    const binding = Mirror.actorStoreOwner(owner);
    const registered = nativeActorMirror();
    if (!registered || !binding || binding.mirror !== registered || Sources.actorStoreIndex(owner) !== index) {
        throw new TypeError('invalid_native_actor_read_owner');
    }
    actorAllocation.installOwner(owner);
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
    beginWorkerProjectorRole, workerProjectorRole, isWorkerProjectorRole,
    actorProducerReads, registerNativeActorMirror, nativeActorMirror, attachActorReadOwner });
