'use strict';
// The board's buyers (worker): what each bot's held build
// wants from player supply (its card's watch rows: item, the most it pays a unit),
// registered while the card is held (register, from the worker's held card: a build
// taken, a card restored on a record's first row) and dropped with it, no clock. A new
// SELL line, or a cheaper one, wakes at most five buyers of its item whose budget
// reaches its price, far and near together (recordChanged → wake: offer_posted, which
// wakes the build); a woken want leaves the index until the build it wakes holds its
// next card, a want whose wake is refused (a bot that cannot take it now) stays. At most
// MAX_WANTS per bot (the rest counted: board:wait:capped). Beside it the owners' own
// lines (lineEvents): the same record change raises their own-line situations.
const MAX_WANTS = 8;
const WAKES_PER_RECORD = 5;

// Each item keeps an indexed max-heap of budgets. Publication visits only
// this owner's wants; a new record wakes at most five: a want refused (its own
// record's owner, a bot that cannot take it now: the wake's false) is passed over
// without spending one, so buyers below it still hear the offer.
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
    // wake(ownerId, { itemId, price }): the offer that woke the buyer; true when taken.
    // capped(): told a want past MAX_WANTS.
    constructor({ wake, capped = () => {} }) {
        if (typeof wake !== 'function') throw new TypeError('market buyer waiters require a wake');
        Object.assign(this, { wake, capped });
        this.items = new Map(); this.owners = new Map(); this.sequence = 0;
    }
    clear() { this.items.clear(); this.owners.clear(); }
    size() { return { owners: this.owners.size, items: this.items.size }; }
    remove(ownerId) {
        for (const node of this.owners.get(ownerId) || []) {
            const heap = this.items.get(node.itemId);
            heap?.remove(node);
            if (!heap?.nodes.length) this.items.delete(node.itemId);
        }
        this.owners.delete(ownerId);
    }
    // A card held: its wants replace the bot's. wants: [{ itemId, budget }] (budget: the
    // most it pays a unit, as the wallet read when the card was held).
    register(ownerId, wants = []) {
        this.remove(ownerId);
        const byItem = new Map();
        for (const { itemId, budget } of wants) {
            const id = Number(itemId), most = Number(budget);
            if (Number.isSafeInteger(id) && id > 0 && Number.isFinite(most) && most > 0) byItem.set(id, Math.max(byItem.get(id) || 0, most));
        }
        const nodes = [];
        for (const [itemId, budget] of byItem) {
            if (nodes.length >= MAX_WANTS) { this.capped(); break; }
            if (!this.items.has(itemId)) this.items.set(itemId, new ItemWaiters());
            const node = { ownerId, itemId, budget, sequence: ++this.sequence, position: -1 };
            this.items.get(itemId).add(node); nodes.push(node);
        }
        if (nodes.length) this.owners.set(ownerId, nodes);
    }
    // A SELL record posted or changed: the offers it adds (a new line, a lower price,
    // more units) wake their buyers. Returns the woken owner ids.
    recordChanged(record, previous = []) {
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
        try {
            for (const [itemId, price] of offers) {
                const heap = this.items.get(itemId);
                while (heap?.peek()?.budget >= price && woken.length < WAKES_PER_RECORD) {
                    const node = heap.peek(); heap.remove(node);
                    if (node.ownerId === Number(record.ownerId) || !this.wake(node.ownerId, { itemId, price })) { held.push(node); continue; }
                    this.remove(node.ownerId); woken.push(node.ownerId);
                }
                if (woken.length === WAKES_PER_RECORD) break;
            }
        } finally {
            for (const node of held) {
                if (!this.items.has(node.itemId)) this.items.set(node.itemId, new ItemWaiters());
                this.items.get(node.itemId).add(node);
            }
        }
        return woken;
    }
}

// The own-line situations of a board record's change (record: BoardIndex.recordOf;
// previous: its indexed lines before; board: the index with the record put): a bot
// owner's line filled (its fills moved: a sale, a bid answered; a line sold out leaves
// the record and raises none) raises goal_done:line on it; a new SELL line raises
// line_undercut on the bot owners of the same item's dearer SELL lines where it sells
// (its town; an unplaced line every town) when it moves the best rival price that line
// was priced against past its accepted noise (MarketPricing.rivalMoved, the look's own
// test: a smaller move is one the look keeps its price through), at most
// WAKES_PER_RECORD a line from the cheapest up, each owner past them told to
// capped(). A C4 seller sees a new stall or
// shout of his item when it appears; a rival's price change he sees at his own next
// look (his town arrival, arrived_town), so a reprice raises none: two sellers of one
// item do not undercut each other at machine speed. wake(ownerId, name).
// lazy: MarketPricing's graph is loaded after the worker's board modules.
const Pricing = () => invoke('GameServer/Bot/Economy/MarketPricing');
function lineEvents(record, previous, board, wake, capped = () => {}) {
    const ownerId = Number(record.ownerId), old = new Map(previous.map(line => [line.lineId, line]));
    if (record.botOwned && record.lines.some(line => line.fills > Number(old.get(Number(line.lineId))?.fills ?? line.fills))) {
        wake(ownerId, 'goal_done:line');
    }
    if (Number(record.storeType) !== 1) return;
    const woken = new Set();
    for (const line of record.lines) {
        if (old.has(Number(line.lineId))) continue;
        let raised = 0;
        for (const other of board.lines(Number(line.selfId), 1, record.town)) {
            if (!(other.price > Number(line.price)) || !other.botOwned || other.ownerId === ownerId || woken.has(other.ownerId)) continue;
            const seen = other.pricing?.rival, sigma = other.pricing?.sigma;
            if (seen > 0 && sigma > 0) {
                const rival = board.first(Number(line.selfId), 1, { excludeOwner: other.ownerId, enchant: other.enchant });
                if (!(rival?.price > 0) || !Pricing().rivalMoved(seen, rival.price, sigma)) continue;
            }
            woken.add(other.ownerId);
            if (raised === WAKES_PER_RECORD) { capped(); continue; }
            raised++;
            wake(other.ownerId, 'line_undercut');
        }
    }
}

module.exports = { MarketBuyerWaiters, MAX_WANTS, lineEvents };
