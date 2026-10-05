// Pure event queue for reviews of bot board lines. Counter delivery uses
// BoardIndex membership; startup/state/ack signals inspect only one owner's
// lines. Eligibility and command execution belong to the caller.
class BoardReviewEvents {
    constructor({ board, counter }) {
        this.board = board;
        this.counter = counter;
        this.lastCounters = new Map();
        this.ready = new Set();
        this.pending = new Set();
        this.inFlight = new Set();
    }

    clear() {
        this.resetCounterHistory();
        this.ready.clear();
        this.pending.clear();
        this.inFlight.clear();
    }

    resetCounterHistory() {
        this.lastCounters.clear();
    }

    enqueue(ownerId) {
        if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return;
        this.pending.add(ownerId);
        if (!this.inFlight.has(ownerId)) this.ready.add(ownerId);
    }

    counterChanged(key, deals) {
        if (!Number.isSafeInteger(deals) || deals <= (this.lastCounters.get(key) || 0)) return;
        this.lastCounters.set(key, deals);
        for (const ownerId of this.board.ownersForCounter(key)) this.enqueue(ownerId);
    }

    ownerStatus(ownerId) {
        let priced = false;
        const counts = new Map();
        for (const line of this.board.ownerLines(ownerId)) {
            if (!line.botOwned || !line.pricing || !this.board.groupOf) continue;
            const seen = line.pricing.seenCounter;
            if (!Number.isSafeInteger(seen) || seen < 0) continue;
            priced = true;
            const key = this.board.groupOf(line.selfId);
            if (!counts.has(key)) counts.set(key, this.counter(key));
            const actual = counts.get(key);
            if (Number.isSafeInteger(actual) && actual > seen) return { priced, behind: true };
        }
        return { priced, behind: false };
    }

    ownerChanged(ownerId) {
        const status = this.ownerStatus(ownerId);
        if (status.behind) this.enqueue(ownerId);
        // Board metadata may arrive before the command ack. Keep its taken
        // token until rearm, so a deal between the two cannot dispatch twice.
        else if (!status.priced || !this.inFlight.has(ownerId)) this.forget(ownerId);
    }

    take(limit) {
        if (!Number.isSafeInteger(limit) || limit <= 0) return [];
        const owners = [];
        for (const ownerId of this.ready) {
            this.ready.delete(ownerId);
            this.inFlight.add(ownerId);
            owners.push(ownerId);
            if (owners.length === limit) break;
        }
        return owners;
    }

    defer(ownerId) {
        if (!this.pending.has(ownerId)) return;
        this.ready.delete(ownerId);
        this.inFlight.delete(ownerId);
    }

    rearm(ownerId) {
        if (!this.pending.has(ownerId)) return;
        this.inFlight.delete(ownerId);
        if (this.ownerStatus(ownerId).behind) this.enqueue(ownerId);
        else this.forget(ownerId);
    }

    forget(ownerId) {
        this.ready.delete(ownerId);
        this.pending.delete(ownerId);
        this.inFlight.delete(ownerId);
    }
}

module.exports = BoardReviewEvents;
