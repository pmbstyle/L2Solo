const PurchaseFunding = require('./PurchaseFunding');

function eligible(state) {
    return state?.phase === 'cold' && ['hunting', 'party_wait'].includes(state.activity)
        && Number(state.vitals?.hp ?? state.hp ?? 1) > 0
        && !state.partyId && !state.party?.partyId && !state.stats?.travel
        && !state.stats?.pveEncounter && !state.stats?.pvpEncounter;
}

// Each item keeps an indexed max-heap of affordable budgets. Publication
// visits only this owner's wants; a new record inspects at most five nodes.
// State objects remain in the canonical provider, never in this index.
class ItemWaiters {
    constructor() { this.nodes = []; }
    before(a, b) { return a.budget > b.budget || (a.budget === b.budget && a.sequence < b.sequence); }
    swap(a, b) {
        [this.nodes[a], this.nodes[b]] = [this.nodes[b], this.nodes[a]];
        this.nodes[a].position = a; this.nodes[b].position = b;
    }
    up(at) {
        while (at > 0) {
            const parent = (at - 1) >> 1;
            if (!this.before(this.nodes[at], this.nodes[parent])) break;
            this.swap(at, parent); at = parent;
        }
    }
    down(at) {
        while (at * 2 + 1 < this.nodes.length) {
            let child = at * 2 + 1;
            if (child + 1 < this.nodes.length && this.before(this.nodes[child + 1], this.nodes[child])) child++;
            if (!this.before(this.nodes[child], this.nodes[at])) break;
            this.swap(at, child); at = child;
        }
    }
    add(node) { node.position = this.nodes.length; this.nodes.push(node); this.up(node.position); }
    remove(node) {
        const at = node.position;
        if (this.nodes[at] !== node) return;
        const last = this.nodes.pop(); node.position = -1;
        if (at < this.nodes.length) {
            this.nodes[at] = last; last.position = at;
            this.up(at); this.down(last.position);
        }
    }
    peek() { return this.nodes[0]; }
}

class MarketBuyerWaiters {
    constructor({ stateFor, demandsFor, wake }) {
        if ([stateFor, demandsFor, wake].some(fn => typeof fn !== 'function')) {
            throw new TypeError('market buyer waiters require canonical state, demand and wake providers');
        }
        Object.assign(this, { stateFor, demandsFor, wake });
        this.items = new Map(); this.owners = new Map(); this.sequence = 0;
        this.stats = { inspected: 0, woken: 0 };
    }
    clear() { this.items.clear(); this.owners.clear(); }
    remove(ownerId) {
        for (const node of this.owners.get(ownerId) || []) {
            const heap = this.items.get(node.itemId);
            heap?.remove(node);
            if (!heap?.nodes.length) this.items.delete(node.itemId);
        }
        this.owners.delete(ownerId);
    }
    ownerChanged(ownerId, timestamp = Date.now()) {
        this.remove(ownerId);
        const state = this.stateFor(ownerId);
        if (!eligible(state)) return;
        const reserve = PurchaseFunding.operatingReserve(state);
        const byItem = new Map();
        for (const [itemId, signal] of this.demandsFor(state, timestamp)) {
            const budget = Math.max(0, Number(signal.budget) - reserve);
            if (signal.ready && Number.isSafeInteger(itemId) && itemId > 0 && Number.isFinite(budget) && budget > 0) {
                byItem.set(itemId, Math.max(byItem.get(itemId) || 0, budget));
            }
        }
        const nodes = [];
        for (const [itemId, budget] of byItem) {
            if (!this.items.has(itemId)) this.items.set(itemId, new ItemWaiters());
            const node = { ownerId, itemId, budget, sequence: ++this.sequence, position: -1 };
            this.items.get(itemId).add(node); nodes.push(node);
        }
        if (nodes.length) this.owners.set(ownerId, nodes);
    }
    recordChanged(record, previous = [], timestamp = Date.now()) {
        if (Number(record.storeType) !== 1) return [];
        const old = new Map(previous.map(line => [line.lineId, line]));
        const offers = new Map();
        for (const line of record.lines || []) {
            const before = old.get(Number(line.lineId));
            const price = Number(line.price), count = Number(line.count), itemId = Number(line.selfId);
            if (!(price > 0) || !Number.isFinite(price) || !(count > 0) || !Number.isSafeInteger(itemId)) continue;
            if (before?.storeType === 1 && before.selfId === itemId && price >= before.price && count <= before.count
                && before.ownerId === Number(record.ownerId) && (before.town || null) === (record.town || null)
                && Number(before.enchant || 0) === Number(line.enchant || 0)) continue;
            offers.set(itemId, Math.min(offers.get(itemId) ?? Infinity, price));
        }
        const woken = [], held = [];
        let inspected = 0;
        try {
            for (const [itemId, price] of offers) {
                const heap = this.items.get(itemId);
                while (heap?.peek()?.budget >= price && inspected < 5) {
                    const node = heap.peek(); heap.remove(node); inspected++;
                    if (node.ownerId === Number(record.ownerId)) { held.push(node); continue; }
                    const state = this.stateFor(node.ownerId);
                    this.remove(node.ownerId);
                    if (!eligible(state)) continue;
                    const reserve = PurchaseFunding.operatingReserve(state);
                    const demand = this.demandsFor(state, timestamp).find(([id, signal]) => id === itemId
                        && signal.ready && Number(signal.budget) - reserve >= price);
                    if (!demand) continue;
                    if (this.wake(node.ownerId, timestamp)) woken.push(node.ownerId);
                }
                if (inspected === 5) break;
            }
        } finally {
            for (const node of held) {
                if (!this.items.has(node.itemId)) this.items.set(node.itemId, new ItemWaiters());
                this.items.get(node.itemId).add(node);
            }
            this.stats.inspected += inspected; this.stats.woken += woken.length;
        }
        return woken;
    }
}

module.exports = { MarketBuyerWaiters, eligible };
