// One named attention roll at the owner's own resolve or natural hot break.
const Counters = require('./MarketCounters');
const Rolls = require('../AI/TendencyRoll');
const SpotEconomics = require('./SpotEconomics');
const MAX_LINES = 8;
const HOUR_MS = 3600000;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

// At most eight exact id/deal/time triples: 192 B numeric payload per owner.
// No line object is retained; temporary get() values die in this resolve.
class SeenLines extends Float64Array {
    constructor() { super(MAX_LINES * 3); }
    get size() { for (let i = 0; i < MAX_LINES; i++) if (!this[i * 3]) return i; return MAX_LINES; }
    slot(id) { for (let i = 0; i < this.size; i++) if (this[i * 3] === id) return i; return -1; }
    get(id) { const i = this.slot(id); return i < 0 ? undefined : { deals: this[i * 3 + 1], at: this[i * 3 + 2] }; }
    set(id, value) {
        let i = this.slot(id);
        if (i < 0) { i = this.size; if (i === MAX_LINES) { this.delete(this[0]); i--; } }
        this[i * 3] = id; this[i * 3 + 1] = value.deals; this[i * 3 + 2] = value.at;
        return this;
    }
    delete(id) {
        const i = this.slot(id);
        if (i < 0) return false;
        this.copyWithin(i * 3, (i + 1) * 3); this.fill(0, (MAX_LINES - 1) * 3);
        return true;
    }
    *keys() { for (let i = 0; i < this.size; i++) yield this[i * 3]; }
}

function attention(state, line, ctx, observed) {
    const counter = Counters.counter(Counters.counterOf(line.selfId), ctx.timestamp);
    const seen = Math.max(finite(line.pricing?.seenCounter), finite(observed?.deals));
    if (!(counter.deals > seen)) return null;
    const lastAt = Math.max(finite(line.pricing?.seenAt), finite(observed?.at));
    const hours = lastAt > 0 ? Math.max(0, ctx.timestamp - lastAt) / HOUR_MS : 1;
    const understanding = Math.max(0, Math.min(1, finite(ctx.understanding, 0.3)));
    const value = Math.max(0, finite(line.price) * finite(line.count))
        * Math.abs(Counters.moveOf(counter.key || Counters.counterOf(line.selfId), ctx.timestamp))
        * hours * understanding * (1 + SpotEconomics.moneyWeight(state));
    const cost = Math.max(0, finite(ctx.hour)) / 60; // one minute, in adena
    return { value, cost, probability: value + cost > 0 ? value / (value + cost) : 0,
        deals: counter.deals };
}

function review(state, lines, ctx, lookSeen) {
    const own = lines.filter(line => line.pricing && line.count > 0
        && (!line.ownerId || Number(line.ownerId) === Number(state.characterId)));
    if (lookSeen) {
        const ids = new Set(own.map(line => line.lineId));
        for (const id of [...lookSeen.keys()]) if (!ids.has(id)) lookSeen.delete(id);
    }
    // ARCH-NOTE: actual board caps total 14 lines, while this task budgets 8.
    // Rotate an eight-line window by the current minute; no new saved cursor.
    // Evicted no-change observations may be checked again without a DB write.
    const first = own.length > MAX_LINES ? Math.floor(ctx.timestamp / 60000) % own.length : 0;
    const selected = [];
    for (let i = 0; i < Math.min(MAX_LINES, own.length); i++) {
        const line = own[(first + i) % own.length];
        const choice = attention(state, line, ctx, lookSeen?.get(line.lineId));
        if (!choice || Rolls.roll('board_look', Number(state.characterId), `${line.lineId}:${choice.deals}`)
            >= choice.probability) continue;
        selected.push({ line, deals: choice.deals });
    }
    if (!selected.length) return null;
    const review = require('./MarketPricing').look(state, selected.map(row => row.line), ctx);
    if (lookSeen) {
        const changed = new Set([...(review?.reprices || []), ...(review?.withdrawals || [])].map(row => row.lineId));
        for (const { line, deals } of selected) {
            if (changed.has(line.lineId)) continue;
            lookSeen.delete(line.lineId);
            if (lookSeen.size >= MAX_LINES) lookSeen.delete(lookSeen.keys().next().value);
            lookSeen.set(line.lineId, { deals, at: ctx.timestamp });
        }
    }
    return review;
}

module.exports = { MAX_LINES, SeenLines, attention, review };
