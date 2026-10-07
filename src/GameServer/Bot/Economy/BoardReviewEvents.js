// Pure event queue for reviews of bot board lines. Counter delivery uses
// BoardIndex membership; startup/state/ack signals inspect only one owner's
// lines. Eligibility and command execution belong to the caller.
const BoardRules = require('../../AfkTrade/BoardRules');
const { BUY } = require('../../AfkTrade/BoardIndex');
const MAX_PRICED_LINES = BoardRules.BOT_SHOP_LINES
    + Object.values(BoardRules.BOT_RECORDS).reduce((sum, count) => sum + count, 0);
class BoardReviewEvents {
    constructor({ board, counter }) {
        this.board = board;
        this.counter = counter;
        this.lastCounters = new Map();
        this.ready = new Set();
        this.pending = new Set();
        this.inFlight = new Set();
        this.changedWhileInFlight = new Set();
        this.coverageVersions = new Map();
        this.coverageSequence = 0;
        this.coverageFloor = 0;
        this.acceptedEdges = new Map();
        // Owners whose bot finished a town visit since its last review: the
        // look at the market is an event of its own, with no deal needed.
        this.visits = new Set();
    }

    clear() {
        this.resetCounterHistory();
        this.ready.clear();
        this.pending.clear();
        this.inFlight.clear();
        this.changedWhileInFlight.clear();
        this.resetBoardCoverage();
        this.acceptedEdges.clear();
        this.visits.clear();
    }

    // Versions live for the queue epoch. Forget/relist cannot recreate an
    // older stamp. A full input copy is unknown, not line retirement.
    resetBoardCoverage() {
        this.coverageFloor = ++this.coverageSequence;
        this.coverageVersions.clear();
    }

    coverageVersion(ownerId) {
        return this.coverageVersions.get(ownerId) ?? this.coverageFloor;
    }

    advanceCoverage(ownerId) {
        this.coverageVersions.set(ownerId, ++this.coverageSequence);
    }

    lastAcceptedEdge(ownerId) { return this.acceptedEdges.get(ownerId) || null; }

    edgeOf(ownerId) {
        const lines = this.board.ownerLines(ownerId).filter(line => line.botOwned && line.pricing);
        if (!lines.length || lines.length > MAX_PRICED_LINES || !this.board.groupOf) return null;
        const counts = new Map();
        const parts = lines.map(line => {
            const key = this.board.groupOf(line.selfId);
            if (!counts.has(key)) counts.set(key, this.counter(key));
            return [line.recordId, line.revision, line.lineId, line.selfId, line.storeType, line.count, line.price, line.fills,
                line.pricing.price, line.pricing.seenCounter, line.pricing.seenItem,
                line.pricing.rival, line.pricing.worth, line.pricing.seenFills, key, counts.get(key)];
        });
        parts.sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[2]) - Number(b[2]));
        return JSON.stringify(parts);
    }

    acceptSafetyEdge(ownerId, edge) {
        this.acceptedEdges.set(ownerId, edge);
        this.enqueue(ownerId);
    }

    resetCounterHistory() {
        this.lastCounters.clear();
    }

    enqueue(ownerId) {
        if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return;
        this.advanceCoverage(ownerId);
        this.pending.add(ownerId);
        if (this.inFlight.has(ownerId)) this.changedWhileInFlight.add(ownerId);
        else this.ready.add(ownerId);
    }

    // The bot looked at the market in a town. Only an owner with a priced buy
    // line is worth a review: there the look can show that nobody sells.
    visit(ownerId) {
        if (!this.board.ownerLines(ownerId).some(line => line.botOwned && line.pricing && line.storeType === BUY)) return;
        this.visits.add(ownerId);
        this.enqueue(ownerId);
    }

    consumeVisit(ownerId) {
        this.visits.delete(ownerId);
    }

    counterChanged(key, deals) {
        if (!Number.isSafeInteger(deals) || deals <= (this.lastCounters.get(key) || 0)) return;
        this.lastCounters.set(key, deals);
        for (const ownerId of this.board.ownersForCounter(key)) this.enqueue(ownerId);
    }

    ownerStatus(ownerId) {
        if (this.visits.has(ownerId)) return { priced: true, behind: true };
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

    ownerChanged(ownerId, { current = true } = {}) {
        const status = this.ownerStatus(ownerId);
        if (current && (!status.priced || !status.behind)) this.acceptedEdges.delete(ownerId);
        if (status.behind) this.enqueue(ownerId);
        // Board metadata may arrive before the command ack. Keep its taken
        // token until rearm, so a deal between the two cannot dispatch twice.
        else if (!status.priced || !this.inFlight.has(ownerId)) this.forget(ownerId);
    }

    take(limit) {
        if (!Number.isSafeInteger(limit) || limit <= 0) return [];
        const owners = [];
        for (const ownerId of this.ready) {
            this.advanceCoverage(ownerId);
            this.ready.delete(ownerId);
            this.changedWhileInFlight.delete(ownerId);
            this.inFlight.add(ownerId);
            owners.push(ownerId);
            if (owners.length === limit) break;
        }
        return owners;
    }

    defer(ownerId) {
        if (!this.pending.has(ownerId)) return;
        this.advanceCoverage(ownerId);
        this.ready.delete(ownerId);
        this.inFlight.delete(ownerId);
        this.changedWhileInFlight.delete(ownerId);
    }

    // A zero-change command may have newer input already waiting. Retry that
    // input once after ack; without it, defer until a fresh external signal.
    deferAfterCommand(ownerId) {
        if (this.changedWhileInFlight.has(ownerId)) this.rearm(ownerId);
        else this.defer(ownerId);
    }

    rearm(ownerId) {
        if (!this.pending.has(ownerId)) return;
        this.advanceCoverage(ownerId);
        this.inFlight.delete(ownerId);
        this.changedWhileInFlight.delete(ownerId);
        if (this.ownerStatus(ownerId).behind) this.enqueue(ownerId);
        else this.forget(ownerId);
    }

    forget(ownerId) {
        this.visits.delete(ownerId);
        this.advanceCoverage(ownerId);
        this.ready.delete(ownerId);
        this.pending.delete(ownerId);
        this.inFlight.delete(ownerId);
        this.changedWhileInFlight.delete(ownerId);
    }
}

module.exports = BoardReviewEvents;
