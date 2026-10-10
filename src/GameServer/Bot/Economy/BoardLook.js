// One named attention roll at the owner's own resolve or natural hot break.
const Counters = require('./MarketCounters');
const Rolls = require('../AI/TendencyRoll');
const SpotEconomics = require('./SpotEconomics');
const MAX_LINES = 8;
const HOUR_MS = 3600000;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const { fnv1a32 } = require('../Fnv1a');
const MAX_OWNED_LINES = 14;
function lineFingerprint(hash, line) {
    return fnv1a32(`${line.recordId}:${line.lineId}:${line.selfId}:${line.count}:${line.price}:${line.revision};`, hash);
}
function feasibilityPredicate(state, lines, mask = null) {
    let fingerprint = 0x811c9dc5;
    if (mask && lines.length === mask[2] && lines.length <= MAX_OWNED_LINES) {
        for (const line of lines) fingerprint = lineFingerprint(fingerprint, line);
        if (fingerprint === mask[0]) return line => {
            const at = lines.findIndex(row => row.lineId === line.lineId && row.recordId === line.recordId);
            return at < 0 ? undefined : !(mask[1] & (1 << at));
        };
    }
    return line => indexedFeasibility(state, line);
}

// Only indexed owner facts can prove protection at a bounded natural look.
// Deep equipment/combine allocations wait for their worker preparation.
function indexedFeasibility(state, line, reserved = null) {
    const item = state.inventory?.[line.selfId], plan = state.stats?.equipmentPlan;
    if (item?.protected || item?.acceptedCustomer || item?.assignedClan || item?.available === false) return false;
    const target = ['active', 'component_ready', 'ready_to_craft'].includes(plan?.status)
        && Number(plan?.target?.selfId) === Number(line.selfId) ? 1 : 0;
    const held = Math.max(Number(item?.protectedAmount || 0), Number(item?.starterMobLootAmount || 0),
        Number(item?.reservedAmount || 0), Number(state.stats?.clanMaterialDemand?.[line.selfId] || 0),
        Number(reserved?.[line.selfId] || 0), target);
    if (held > Number(item?.amount || 0)) return false;
    return reserved ? true : undefined;
}

// One compact cache for the native maximum of 14 owned lines, independent
// of the eight-line work budget. Header + rows + one scratch = 4352 B.
const WIDTH = 36, HEADER = 4, SCRATCH = HEADER + MAX_OWNED_LINES * WIDTH;
const PRICING_FIELDS = ['price', 'seenCounter', 'seenAt', 'seenItem', 'rival', 'worth', 'seenFills', 'seenCount', 'sigma'];
class SeenLines extends Float64Array {
    constructor() { super(SCRATCH + WIDTH); this.fill(NaN); this[0] = 0; this[1] = 0; this[3] = 0; }
    get size() { return this[0]; }
    get cursor() { return this[1]; }
    set cursor(value) { this[1] = value; }
    get townVisit() { return Number.isNaN(this[2]) ? undefined : this[2]; }
    set townVisit(value) { this[2] = value; }
    slot(id) { for (let i = 0; i < this.size; i++) if (this[HEADER + i * WIDTH] === id) return i; return -1; }
    offset(id) { const i = this.slot(id); return i < 0 ? -1 : HEADER + i * WIDTH; }
    get(id) { const at = this.offset(id); return at < 0 ? undefined : { deals: this[at + 23], at: this[at + 24] }; }
    set(id, value) {
        let at = this.offset(id);
        if (at < 0) {
            // ARCH-NOTE: malformed legacy books over the native cap retain
            // bounded memory and cursor coverage; normal publication caps14.
            if (this.size === MAX_OWNED_LINES) this.delete(this[HEADER]);
            at = HEADER + this.size * WIDTH; this[0]++;
        }
        this[at] = id; this[at + 23] = value.deals; this[at + 24] = value.at;
        return this;
    }
    delete(id) {
        const at = this.offset(id);
        if (at < 0) return false;
        this.copyWithin(at, at + WIDTH, HEADER + this.size * WIDTH);
        const slot = (at - HEADER) / WIDTH, lower = this[3] & ((1 << slot) - 1);
        this[3] = lower | (this[3] >>> (slot + 1)) << slot;
        this[0]--; this.fill(NaN, HEADER + this.size * WIDTH, HEADER + (this.size + 1) * WIDTH);
        return true;
    }
    *keys() { for (let i = 0; i < this.size; i++) yield this[HEADER + i * WIDTH]; }
}
function sameRange(values, left, right, start, end) {
    for (let n = start; n < end; n++) if (!Object.is(values[left + n], values[right + n])) return false;
    return true;
}
const legacySeen = new WeakMap();
function cacheOf(seen) {
    if (seen instanceof SeenLines) return seen;
    if (!seen) return new SeenLines();
    let cache = legacySeen.get(seen);
    if (!cache) legacySeen.set(seen, cache = new SeenLines());
    return cache;
}

// A same-owner native projection is excluded from the public price signal.
// Consume only its exact delta, never the current aggregate token: a rival
// that changed during a flush must still differ from our used snapshot.
function consumeOwnProjection(seen, previous, next, board, ownerId) {
    if (!seen) return;
    const cache = cacheOf(seen);
    for (let i = 0; i < cache.size; i++) {
        const at = HEADER + i * WIDTH, id = cache[at + 2];
        let increments = 0;
        for (const lines of [previous, next]) for (const line of lines) {
            if (line.ownerId === ownerId && line.selfId === id) increments++;
        }
        if (!increments) continue;
        board.writeItemRevision(id, cache, SCRATCH + 5);
        if (cache[at + 5] === cache[SCRATCH + 5] && cache[at + 6] === cache[SCRATCH + 6]
            && cache[at + 7] === cache[SCRATCH + 7]) cache[at + 8] += increments;
        else cache[at + 5] = NaN;
        const line = next.find(row => row.lineId === cache[at] && row.recordId === cache[at + 1]);
        const prior = previous.find(row => row.lineId === cache[at] && row.recordId === cache[at + 1]);
        // A record revision also advances for unchanged sibling lines. Only
        // absorb it when the cached prior and exact native content agree.
        const sameNative = line && prior && Number(prior.revision) === cache[at + 12]
            && ['ownerId', 'selfId', 'enchant', 'storeType', 'count', 'fills', 'custodyPolicy', 'botOwned'].every(field =>
                Number(prior[field] || 0) === Number(line[field] || 0))
            && prior.town === line.town && prior.kind === line.kind;
        if (sameNative && Number(prior.price) === Number(line.price)
            && PRICING_FIELDS.every(field => Object.is(Number(prior.pricing?.[field] ?? 0),
                Number(line.pricing?.[field] ?? 0)))) cache[at + 12] = Number(line.revision);
        if (sameNative && cache[at + 34] === 1 && PRICING_FIELDS.every((field, n) =>
            Object.is(Number(line.pricing?.[field] ?? 0), cache[at + 25 + n]))
            && Number(line.price) === cache[at + 25]) {
            cache[at + 11] = Number(line.price); cache[at + 12] = Number(line.revision);
            cache[at + 23] = Number(line.pricing.seenCounter); cache[at + 24] = Number(line.pricing.seenAt);
            cache[at + 34] = 2;
        }
    }
}

function scalarWorth(ctx, id) {
    if (typeof ctx.preparedWorth === 'function') return ctx.preparedWorth(id);
    // A direct fixture may explicitly provide a prepared scalar reader. This
    // never constructs an economic graph or falls back to a market price.
    return typeof ctx.economy?.worth === 'function' && !ctx.economy?.price ? ctx.economy.worth(id) : NaN;
}
function inputsFor(state, line, ctx, target, at, previousAt, preparedDirty) {
    target.fill(NaN, at, at + 23);
    target[at] = Number(line.lineId); target[at + 1] = Number(line.recordId);
    target[at + 2] = Number(line.selfId); target[at + 3] = Number(line.enchant || 0);
    target[at + 4] = Number(line.storeType);
    if (ctx.board?.writeItemRevision) ctx.board.writeItemRevision(line.selfId, target, at + 5);
    else if (typeof ctx.board?.itemRevision?.(line.selfId) === 'number') {
        // Numeric fixture boards only; compound production strings are opaque.
        target[at + 5] = 0; target[at + 6] = 0; target[at + 7] = 0;
        target[at + 8] = ctx.board.itemRevision(line.selfId);
    }
    target[at + 9] = Number(line.count); target[at + 10] = Number(line.fills || 0);
    target[at + 11] = Number(line.price); target[at + 12] = Number(line.revision);
    target[at + 13] = Number(Counters.itemDeals(line.selfId).deals);
    const sameIdentity = previousAt >= 0 && sameRange(target, previousAt, at, 0, 5);
    const sourceValue = line.storeType === 3 && ctx.preparedValue ? ctx.preparedValue(line.selfId) : NaN;
    // ARCH-NOTE: reuse reserved scalar slot for raw prepared usefulness;
    // no demand producer is added by this price-attention change.
    target[at + 35] = sourceValue;
    const reusable = sameIdentity && !preparedDirty && (ctx.preparedBuffer
        || ctx.preparedValue && Object.is(target[previousAt + 35], sourceValue));
    const raw = line.storeType === 3 ? reusable ? target[previousAt + 14] : scalarWorth(ctx, line.selfId) : null;
    const worth = raw === null || raw === undefined ? NaN : Number(raw);
    target[at + 14] = Number.isFinite(worth) && worth >= 0 ? worth : NaN;
    target[at + 15] = Number.isFinite(target[at + 14])
        ? Math.floor(Math.min(worth, line.price + Math.max(0, Number(ctx.adena) || 0) / Math.max(1, line.count))) : NaN;
    const stock = state.inventory?.[line.selfId] || {}, group = ctx.ownStock?.groups?.get(`${line.selfId}:${line.enchant || 0}`);
    target[at + 16] = Number(group?.units ?? stock.amount ?? 0);
    target[at + 17] = Math.max(Number(stock.reservedAmount || 0), Number(state.stats?.clanMaterialDemand?.[line.selfId] || 0));
    target[at + 18] = Math.max(Number(stock.protectedAmount || 0), Number(stock.starterMobLootAmount || 0));
    target[at + 19] = ctx.ownStock?.known === false ? 0 : group ? Number(!(group.prices?.size > 1)) : NaN;
    const source = invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId);
    const sell = line.storeType === 1 && ctx.canSell?.(line) === false;
    const buy = line.storeType === 3 && ctx.canBuy?.(line) === false;
    target[at + 20] = Number(!source) | Number(sell) << 1 | Number(buy) << 2
        | Number(!!stock.protected) << 3 | Number(!!stock.acceptedCustomer) << 4
        | Number(!!stock.assignedClan) << 5 | Number(stock.available === false) << 6
        | Number(['active', 'component_ready', 'ready_to_craft'].includes(state.stats?.equipmentPlan?.status)
            && Number(state.stats.equipmentPlan.target?.selfId) === Number(line.selfId)) << 7;
    target[at + 21] = Number(ctx.hour); target[at + 22] = Number(ctx.moneyPrice);
}

function attention(state, line, ctx, observed) {
    const itemDeals = Counters.itemDeals(line.selfId).deals;
    if (!(itemDeals > Math.max(finite(line.pricing?.seenItem), finite(observed?.itemDeals)))) return null;
    const counter = Counters.counter(Counters.counterOf(line.selfId), ctx.timestamp);
    const lastAt = Math.max(finite(line.pricing?.seenAt), finite(observed?.at));
    const hours = lastAt > 0 ? Math.max(0, ctx.timestamp - lastAt) / HOUR_MS : 1;
    const understanding = Math.max(0, Math.min(1, finite(ctx.understanding, 0.3)));
    const value = Math.max(0, finite(line.price) * finite(line.count))
        * Math.abs(Counters.moveOf(counter.key || Counters.counterOf(line.selfId), ctx.timestamp))
        * hours * understanding * (1 + SpotEconomics.moneyWeight(state));
    const cost = Math.max(0, finite(ctx.hour)) / 60;
    return { value, cost, probability: value + cost > 0 ? value / (value + cost) : 0,
        deals: counter.deals, itemDeals };
}

function review(state, lines, ctx, lookSeen) {
    const cache = cacheOf(lookSeen);
    const visitNumber = Math.max(0, finite(state.stats?.townLook?.n));
    const visit = visitNumber > (cache.townVisit ?? visitNumber);
    cache.townVisit = visitNumber;
    const own = lines.filter(line => line.pricing && line.count > 0
        && (!line.ownerId || Number(line.ownerId) === Number(state.characterId)));
    for (const id of [...cache.keys()]) if (!own.some(line => Number(line.lineId) === id)) cache.delete(id);
    const first = own.length > MAX_LINES ? cache.cursor % own.length : 0;
    cache.cursor = own.length ? (first + MAX_LINES) % own.length : 0;
    if ((ctx.preparedBuffer || null) !== cache.preparedBuffer || ctx.moneyPrice !== cache.preparedMoney
        || ctx.understanding !== cache.preparedUnderstanding || ctx.knowledgeEnabled !== cache.preparedKnowledge) {
        cache[3] = (1 << MAX_OWNED_LINES) - 1;
        cache.preparedBuffer = ctx.preparedBuffer || null;
        cache.preparedMoney = ctx.moneyPrice; cache.preparedUnderstanding = ctx.understanding;
        cache.preparedKnowledge = ctx.knowledgeEnabled;
    }
    const selected = [], reviewReasons = new Map();
    for (let i = 0; i < Math.min(MAX_LINES, own.length); i++) {
        const line = own[(first + i) % own.length];
        let at = cache.offset(Number(line.lineId));
        const dirty = at < 0 || !!(cache[3] & (1 << ((at - HEADER) / WIDTH)));
        inputsFor(state, line, ctx, cache, SCRATCH, at, dirty);
        const exists = at >= 0 && sameRange(cache, at, SCRATCH, 1, 5);
        if (at >= 0 && !exists) { cache.delete(Number(line.lineId)); at = -1; }
        let reason = visit && line.storeType === 3 ? 8 : 0;
        if (exists ? !sameRange(cache, at, SCRATCH, 5, 9)
            : cache[SCRATCH + 8] > 0) reason |= 1;
        if (exists && !sameRange(cache, at, SCRATCH, 9, 13)
            || Number.isFinite(line.pricing.seenCount) && Number(line.pricing.seenCount) !== Number(line.count)
            && !exists || Number(line.fills || 0) > Number(line.pricing.seenFills || 0) && !exists) reason |= 2;
        if (!exists && line.storeType === 3 && Number.isFinite(cache[SCRATCH + 14])
                && Math.floor(cache[SCRATCH + 14]) !== Math.floor(Number(line.pricing.worth))
            || cache[SCRATCH + 20] & 7 && (!exists || cache[at + 34] !== 1)
            || exists && !sameRange(cache, at, SCRATCH, 14, 23)) reason |= 4;
        const choice = reason ? null : attention(state, line, ctx, exists
            ? { itemDeals: cache[at + 13], at: cache[at + 24] } : null);
        const noticed = reason || choice && Rolls.roll('board_look', Number(state.characterId), `${line.lineId}:${choice.itemDeals}`)
            < choice.probability;
        if (at < 0) { cache.set(Number(line.lineId), { deals: finite(line.pricing.seenCounter), at: finite(line.pricing.seenAt) }); at = cache.offset(Number(line.lineId)); }
        // Remember attempted/no-op observations too, so an unchanged repeat
        // cannot repeat a rejected attention roll or economic computation.
        for (let n = 0; n < 23; n++) cache[at + n] = cache[SCRATCH + n];
        cache[at + 35] = cache[SCRATCH + 35];
        cache[3] &= ~(1 << ((at - HEADER) / WIDTH));
        if (!noticed) continue;
        reviewReasons.set(line.lineId, reason);
        selected.push(line);
        cache[at + 23] = Counters.counter(Counters.counterOf(line.selfId), ctx.timestamp).deals;
        cache[at + 24] = ctx.timestamp;
        cache[at + 34] = 0;
    }
    if (!selected.length) return null;
    const result = invoke('GameServer/Bot/Economy/MarketPricing').look(state, selected, { ...ctx, visit, reviewReasons });
    for (const move of result?.reprices || []) {
        const at = cache.offset(Number(move.lineId));
        if (at < 0) continue;
        for (let n = 0; n < PRICING_FIELDS.length; n++) cache[at + 25 + n] = Number(move.pricing?.[PRICING_FIELDS[n]] ?? 0);
        cache[at + 34] = 1;
    }
    for (const move of result?.withdrawals || []) {
        const at = cache.offset(Number(move.lineId));
        if (at >= 0) { cache.fill(NaN, at + 25, at + 34); cache[at + 34] = 1; }
    }
    return result;
}

module.exports = { MAX_LINES, MAX_OWNED_LINES, SeenLines, attention, review, indexedFeasibility,
    lineFingerprint, feasibilityPredicate, consumeOwnProjection };
