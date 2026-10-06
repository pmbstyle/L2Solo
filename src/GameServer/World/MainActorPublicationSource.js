'use strict';

const { isMainThread } = require('node:worker_threads');
const MAX_AXIS_STRING_LENGTH = 240 * 1024;
let nativeSource = null;

function refusal(message) {
    return new TypeError(message);
}

function axisTag(value) {
    let tag;
    if (value === null) tag = { tag: 'null' };
    else if (value === undefined) tag = { tag: 'undefined' };
    else if (typeof value === 'number') {
        tag = Number.isFinite(value) ? { tag: 'number', value } : { tag: 'nonfinite' };
    } else if (typeof value === 'string') {
        if (value.length > MAX_AXIS_STRING_LENGTH) throw refusal('actor_publication_axis_oversize');
        tag = { tag: 'string', value };
    } else if (typeof value === 'boolean') tag = { tag: 'boolean', value };
    else tag = { tag: 'unsupported' };
    return Object.freeze(tag);
}

function readAxis(actor, method) {
    const getter = actor[method];
    if (getter === undefined) return axisTag(undefined);
    if (typeof getter !== 'function') throw refusal('invalid_actor_publication_axis_method');
    return axisTag(getter.call(actor));
}

function createNativeSource(World, Runtime) {
    let disposed = false;
    let failed = false;
    let failure = null;
    let worldGeneration = 1;
    let publication = 0;
    let occurrence = null;
    const metadata = new WeakMap();
    const issuedRefs = new WeakSet();
    const subscriptions = new Set();

    function available() {
        if (disposed) throw refusal('actor_publication_source_disposed');
        if (failed) throw failure;
    }

    function current(next = occurrence) {
        if (disposed || failed || !next || next !== occurrence
            || World.actorPublicationBinding !== next.binding) return false;
        return next.binding === null
            ? World.user == null && Runtime.index.sourceSize('actor') === 0
            : Runtime.isCurrentWorld(World.user, next.binding);
    }

    function requireCurrent(next = occurrence) {
        available();
        if (!current(next)) throw refusal('stale_actor_publication_occurrence');
    }

    // A permanent issuance failure cannot reuse this process's wire namespace.
    function fail(error) {
        if (failed || disposed) return;
        failed = true;
        failure = error;
        for (const subscription of [...subscriptions]) {
            if (!subscription.active || subscription.suspended) continue;
            subscription.suspended = true;
            try { subscription.onError(error, occurrence); }
            catch { /* The issuer is already permanently unavailable. */ }
        }
    }

    function advancePublication() {
        if (publication === Number.MAX_SAFE_INTEGER) {
            const error = refusal('actor_publication_stamp_exhausted');
            fail(error);
            throw error;
        }
        publication += 1;
        return publication;
    }

    function stamp(record, changed = false) {
        try {
            if (!record || !Number.isSafeInteger(record.id) || record.id <= 0
                || !Number.isSafeInteger(record.order) || record.order <= 0
                || typeof record.token !== 'symbol' || !record.actor
                || record.source !== record.actor || !record.session) {
                throw refusal('invalid_native_actor_publication_record');
            }
            const previous = metadata.get(record);
            if (previous?.occurrence === occurrence && !changed) return previous;
            const value = advancePublication();
            const sameSource = previous?.occurrence === occurrence;
            const ref = sameSource ? previous.ref : Object.freeze({
                id: record.id, record, token: record.token, occurrence
            });
            issuedRefs.add(ref);
            const next = Object.freeze({ ref, occurrence,
                sourceGeneration: sameSource ? previous.sourceGeneration : value,
                publication: value });
            metadata.set(record, next);
            return next;
        } catch (error) {
            fail(error);
            throw error;
        }
    }

    function currentRecord(record, next = occurrence) {
        return current(next) && !!record
            && Runtime.index.getSource(record.id, 'actor') === record
            && World.registeredActorById(record.id) === record
            && record.source === record.actor && record.session.actor === record.actor;
    }

    function deliver(event) {
        const captured = [...subscriptions];
        for (const subscription of captured) {
            if (!current(event.occurrence)) break;
            if (event.kind === 'dirty'
                && metadata.get(event.ref.record)?.publication !== event.publication) break;
            if (!subscription.active || subscription.suspended || !subscriptions.has(subscription)) continue;
            try { subscription.listener(event); }
            catch (error) {
                subscription.suspended = true;
                try { subscription.onError(error, event.occurrence); }
                catch (fault) { fail(fault); }
            }
        }
    }

    function published(envelope) {
        if (disposed || failed) return;
        try {
            if (envelope.kind === 'reset') {
                if (worldGeneration === Number.MAX_SAFE_INTEGER) {
                    throw refusal('actor_publication_world_exhausted');
                }
                advancePublication();
                worldGeneration += 1;
                occurrence = Object.freeze({ binding: envelope.binding, worldGeneration });
                requireCurrent();
                deliver(Object.freeze({ kind: 'reset', occurrence }));
                return;
            }
            requireCurrent();
            if (envelope.binding !== occurrence.binding
                || (envelope.kind !== 'upsert' && envelope.kind !== 'remove')
                || (envelope.kind === 'upsert' && !currentRecord(envelope.record))) {
                throw refusal('incoherent_native_actor_publication');
            }
            const next = stamp(envelope.record, true);
            deliver(Object.freeze({ kind: 'dirty', ref: next.ref, occurrence,
                publication: next.publication }));
        } catch (error) {
            fail(error);
        }
    }

    const unsubscribeNative = World.subscribeActorPublications(published);
    occurrence = Object.freeze({ binding: World.actorPublicationBinding, worldGeneration });
    try { requireCurrent(); }
    catch (error) { unsubscribeNative(); throw error; }

    return Object.freeze({
        currentOccurrence() {
            requireCurrent();
            return occurrence;
        },

        subscribe(listener, onError) {
            available();
            if (typeof listener !== 'function' || typeof onError !== 'function') {
                throw refusal('invalid_actor_publication_subscription');
            }
            const subscription = { listener, onError, active: true, suspended: false };
            subscriptions.add(subscription);
            return () => {
                subscription.active = false;
                subscriptions.delete(subscription);
            };
        },

        capture() {
            requireCurrent();
            const captured = occurrence;
            const count = Runtime.index.sourceSize('actor');
            const iterator = Runtime.index.sourceEntries('actor');
            requireCurrent(captured);
            const entries = Object.freeze({
                next() {
                    requireCurrent(captured);
                    const result = iterator.next();
                    requireCurrent(captured);
                    if (result.done) return Object.freeze({ done: true, value: undefined });
                    const [id, record] = result.value;
                    if (id !== record?.id || !currentRecord(record, captured)) {
                        throw refusal('incoherent_actor_publication_capture');
                    }
                    const next = stamp(record);
                    requireCurrent(captured);
                    if (!currentRecord(record, captured)) throw refusal('stale_actor_publication_capture');
                    return Object.freeze({ done: false, value: next.ref });
                },
                [Symbol.iterator]() { return this; }
            });
            return Object.freeze({ bindingOccurrence: captured,
                worldGeneration: captured.worldGeneration, count, entries });
        },

        resolve(ref, captured) {
            try {
                requireCurrent(captured);
                if (!issuedRefs.has(ref) || ref.occurrence !== captured
                    || metadata.get(ref.record)?.ref !== ref) {
                    throw refusal('foreign_actor_publication_reference');
                }
                const record = Runtime.index.getSource(ref.id, 'actor');
                const registered = World.registeredActorById(ref.id);
                requireCurrent(captured);
                if (!record && !registered) {
                    const cutoff = publication;
                    const row = Object.freeze({ id: ref.id,
                        worldGeneration: captured.worldGeneration, throughPublication: cutoff });
                    const receipt = () => {
                        try {
                            return current(captured) && publication === cutoff
                                && !Runtime.index.getSource(ref.id, 'actor')
                                && !World.registeredActorById(ref.id) && current(captured)
                                && publication === cutoff;
                        } catch { return false; }
                    };
                    return Object.freeze({ kind: 'remove', ref, occurrence: captured, row, current: receipt });
                }
                if (record !== registered || !currentRecord(record, captured)) {
                    throw refusal('incoherent_actor_publication_source');
                }
                const next = stamp(record);
                const valid = () => {
                    try {
                        return currentRecord(record, captured) && record.token === next.ref.token
                            && metadata.get(record) === next && current(captured);
                    } catch { return false; }
                };
                if (!valid()) throw refusal('stale_actor_publication_source');
                const axes = Object.freeze({ x: readAxis(record.actor, 'fetchLocX'),
                    y: readAxis(record.actor, 'fetchLocY'), z: readAxis(record.actor, 'fetchLocZ') });
                if (!valid()) throw refusal('stale_actor_publication_derivation');
                const row = Object.freeze({ id: record.id, worldGeneration: captured.worldGeneration,
                    sourceGeneration: next.sourceGeneration, publication: next.publication,
                    order: record.order, axes });
                return Object.freeze({ kind: 'put', ref: next.ref, occurrence: captured, row, current: valid });
            } catch (error) {
                return Object.freeze({ kind: 'refused', error });
            }
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            for (const subscription of subscriptions) subscription.active = false;
            subscriptions.clear();
            unsubscribeNative();
        }
    });
}

function native() {
    if (arguments.length !== 0 || !isMainThread) throw refusal('invalid_native_actor_publication_owner');
    if (nativeSource) {
        nativeSource.currentOccurrence();
        return nativeSource;
    }
    const World = require('./World');
    const Runtime = require('./CharacterLocationRuntime');
    if (typeof World.subscribeActorPublications !== 'function'
        || !('actorPublicationBinding' in World)) throw refusal('missing_native_actor_publication');
    nativeSource = createNativeSource(World, Runtime);
    return nativeSource;
}

module.exports = Object.freeze({ native });
