// Queue only a named hot owner's own line/state changes. Board deals never
// call this queue; their counters are observed at the owner's natural break.
class BoardReviewEvents {
    constructor({ board }) {
        this.board = board;
        this.ready = new Set();
        this.pending = new Set();
        this.inFlight = new Set();
        this.changedWhileInFlight = new Set();
        this.reasons = new Map();
        this.retired = new Set();
    }

    clear() {
        this.ready.clear(); this.pending.clear(); this.inFlight.clear(); this.changedWhileInFlight.clear();
        this.reasons.clear(); this.retired.clear();
    }

    enqueue(ownerId, reason = 'owner', revision = null) {
        if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return;
        this.pending.add(ownerId);
        // New source facts replace the prior reason; durable native work stays
        // under its original in-flight identity until acknowledgement.
        this.reasons.set(ownerId, { reason, revision });
        this.retired.delete(ownerId);
        if (this.inFlight.has(ownerId)) this.changedWhileInFlight.add(ownerId);
        else this.ready.add(ownerId);
    }

    ownerStatus(ownerId) {
        return { priced: this.board.ownerLines(ownerId).some(line => line.botOwned && line.pricing && line.count > 0) };
    }

    ownerChanged(ownerId, reason = 'owner', revision = null) {
        if (this.ownerStatus(ownerId).priced) this.enqueue(ownerId, reason, revision);
        else this.forget(ownerId);
    }

    take(limit) {
        if (!Number.isSafeInteger(limit) || limit <= 0) return [];
        const owners = [];
        for (const ownerId of this.ready) {
            this.ready.delete(ownerId);
            this.changedWhileInFlight.delete(ownerId);
            this.inFlight.add(ownerId);
            owners.push(ownerId);
            if (owners.length === limit) break;
        }
        return owners;
    }

    defer(ownerId) {
        this.ready.delete(ownerId); this.inFlight.delete(ownerId); this.changedWhileInFlight.delete(ownerId);
        if (this.retired.delete(ownerId)) { this.pending.delete(ownerId); this.reasons.delete(ownerId); }
    }

    deferAfterCommand(ownerId) {
        if (this.changedWhileInFlight.has(ownerId)) this.rearm(ownerId);
        else this.defer(ownerId);
    }

    rearm(ownerId) {
        if (this.retired.has(ownerId)) { this.defer(ownerId); return; }
        if (!this.pending.has(ownerId)) return;
        const changed = this.changedWhileInFlight.has(ownerId);
        this.inFlight.delete(ownerId); this.changedWhileInFlight.delete(ownerId);
        if (changed && this.ownerStatus(ownerId).priced) this.enqueue(ownerId);
        else this.forget(ownerId);
    }

    forget(ownerId) {
        this.ready.delete(ownerId); this.pending.delete(ownerId);
        this.reasons.delete(ownerId); this.changedWhileInFlight.delete(ownerId);
        if (this.inFlight.has(ownerId)) this.retired.add(ownerId);
        else this.retired.delete(ownerId);
    }
}

module.exports = BoardReviewEvents;
