'use strict';

const { isMainThread } = require('worker_threads');
const TableMirror = require('./TableMirror');
const Sources = require('../../World/CharacterActorSources');

// The shipped Worker and helper transport checks share this receiver. Cleanup
// advances only a finite copy job started by an actual incoming actor page.
class ColdActorTableReceiver {
    #mirror;
    #owner;
    #onResync;
    #onReady;
    #cleanup = null;
    #stopped = false;

    constructor({ mirror, owner, onResync, onReady }) {
        const consent = !isMainThread && TableMirror.nativeActorMirrorOwner(mirror);
        if (!consent || TableMirror.actorStoreOwner(owner)?.mirror !== mirror
            || Sources.actorStoreIndex(owner) !== consent.index || typeof onResync !== 'function'
            || (onReady !== undefined && typeof onReady !== 'function')) {
            throw new TypeError('invalid_native_actor_table_receiver');
        }
        this.#mirror = mirror;
        this.#owner = owner;
        this.#onResync = onResync;
        this.#onReady = onReady;
    }

    apply(pieces) {
        const containsActors = pieces.some(piece => String(piece?.name) === 'actors');
        if (this.#stopped && containsActors) {
            pieces = pieces.filter(piece => String(piece?.name) !== 'actors');
        }
        const resync = this.#mirror.apply(pieces);
        if (resync.length) this.#onResync(resync);
        if (containsActors && !this.#stopped) {
            this.#scheduleCleanup();
            this.#notifyReady();
        }
        return resync;
    }

    #notifyReady() {
        if (!this.#stopped && this.#onReady && this.#mirror.ready('actors')) this.#onReady();
    }

    #scheduleCleanup() {
        if (this.#stopped || this.#cleanup !== null) return;
        const binding = TableMirror.actorStoreOwner(this.#owner);
        const descriptor = binding?.descriptor;
        if (!descriptor || descriptor.waiting || descriptor.loading || descriptor.cleanupComplete) return;
        this.#cleanup = setImmediate(() => {
            this.#cleanup = null;
            if (this.#stopped) return;
            try {
                const progress = this.#mirror.cleanupStore('actors', 64);
                if (progress.done) this.#notifyReady();
                else if (progress.inspected > 0) this.#scheduleCleanup();
            } catch (error) {
                // An invalid native backing is terminal for this Worker. Its
                // existing exit/restart path creates a fresh role and full copy.
                try { this.stop(); } catch { /* Preserve the original failure. */ }
                throw error;
            }
        });
    }

    stop() {
        if (this.#stopped) return;
        this.#stopped = true;
        if (this.#cleanup !== null) clearImmediate(this.#cleanup);
        this.#cleanup = null;
        this.#mirror.detachStore('actors');
    }
}

module.exports = ColdActorTableReceiver;
