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

// At most eight exact id/deal/time triples: 192 B numeric payload per owner.
// No line object is retained; temporary get() values die in this resolve.
class SeenLines extends Float64Array {
    constructor() { super(MAX_LINES * 3); this.inputs = new Float64Array(MAX_LINES * 4); this.cursor = 0; }
    get size() { for (let i = 0; i < MAX_LINES; i++) if (!this[i * 3]) return i; return MAX_LINES; }
    slot(id) { for (let i = 0; i < this.size; i++) if (this[i * 3] === id) return i; return -1; }
    get(id) { const i = this.slot(id); return i < 0 ? undefined : { deals: this[i * 3 + 1], at: this[i * 3 + 2] }; }
    inputFor(id) { const i = this.slot(id); return i < 0 ? null : this.inputs.subarray(i * 4, i * 4 + 4); }
    inputSet(id, values) { const i = this.slot(id); if (i >= 0) this.inputs.set(values, i * 4); }
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
        this.inputs.copyWithin(i * 4, (i + 1) * 4); this.inputs.fill(0, (MAX_LINES - 1) * 4);
        return true;
    }
    *keys() { for (let i = 0; i < this.size; i++) yield this[i * 3]; }
}
const externalInputs = new WeakMap();
function seenInputs(seen, id) {
    if (!seen) return null;
    return seen.inputFor ? seen.inputFor(id) : externalInputs.get(seen)?.get(id) || null;
}
function keepInputs(seen, id, values) {
    if (seen.inputSet) { seen.inputSet(id, values); return; }
    let inputs = externalInputs.get(seen);
    if (!inputs) externalInputs.set(seen, inputs = new Map());
    for (const key of inputs.keys()) if (!seen.has(key)) inputs.delete(key);
    inputs.set(id, values);
}
function inputsFor(state, line, ctx) {
    // A feasibility mask protects owned reservations; it cannot legitimise
    // source-invalid saved stock or a wish learned from a GM advertisement.
    if (!invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId))
        return [0, Number(line.count), 0, 0];
    const revision = Number(ctx.board?.itemRevision?.(line.selfId) || 0);
    const buyer = ctx.board?.first?.(line.selfId, 3, { excludeOwner: ctx.characterId,
        enchant: Number(line.enchant || 0) });
    const demand = ctx.demandFor?.(line.selfId, line) || null;
    const units = Number(demand?.applicableUnits ?? buyer?.count ?? 0);
    const feasible = typeof ctx.canSell === 'function' && line.storeType === 1 ? ctx.canSell(line) !== false
        : line.storeType !== 3 || Number(ctx.economy?.worth?.(line.selfId) ?? line.pricing?.worth ?? Infinity) > 0;
    // Adena prices are whole units; an unchanged affordable ceiling is not
    // another economic edge. Unknown prepared usefulness is not zero.
    const worth = line.storeType === 3 ? ctx.economy?.worth?.(line.selfId) : null;
    const value = line.storeType === 3 && ctx.canBuy?.(line) === false ? 0
        : line.storeType === 3 && typeof ctx.economy?.worth === 'function'
        ? Number.isFinite(worth) && worth >= 0 ? Math.floor(worth) : -1 : Number(feasible);
    return [revision, Number(line.count), units, value];
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
    // A completed town visit is a named own observation. Reuse the bounded
    // hot/cold look owner; do not restore a second per-bot worker visit map.
    const visitNumber = Math.max(0, finite(state.stats?.townLook?.n));
    const visit = !!lookSeen && visitNumber > (lookSeen.townVisit ?? visitNumber);
    if (lookSeen) lookSeen.townVisit = visitNumber;
    const own = lines.filter(line => line.pricing && line.count > 0
        && (!line.ownerId || Number(line.ownerId) === Number(state.characterId)));
    if (lookSeen) {
        const ids = new Set(own.map(line => line.lineId));
        for (const id of [...lookSeen.keys()]) if (!ids.has(id)) lookSeen.delete(id);
    }
    // Advance on actual natural observation, including several breaks in one
    // minute. Eight observations remain bounded; durable line baselines do not
    // depend on this evictable attention cache.
    const first = own.length > MAX_LINES ? Number(lookSeen?.cursor || 0) % own.length : 0;
    if (lookSeen) lookSeen.cursor = own.length ? (first + MAX_LINES) % own.length : 0;
    const selected = [];
    const reviewReasons = new Map();
    for (let i = 0; i < Math.min(MAX_LINES, own.length); i++) {
        const line = own[(first + i) % own.length];
        const input = inputsFor(state, line, ctx), before = seenInputs(lookSeen, line.lineId);
        let reason = 0;
        if (visit && line.storeType === 3) reason |= 8;
        if (input[0] && (!before || before[0] !== input[0])) reason |= 1;
        if (before && (before[1] !== input[1] || before[2] !== input[2])
            || Number.isFinite(line.pricing.seenCount) && Number(line.pricing.seenCount) !== input[1]
            || Number(line.fills || 0) > Number(line.pricing.seenFills || 0)) reason |= 2;
        if (!input[3] || before && before[3] !== input[3]
            || !before && line.storeType === 3 && typeof ctx.economy?.worth === 'function'
                && input[3] >= 0 && input[3] !== Math.floor(Number(line.pricing.worth))) reason |= 4;
        const choice = attention(state, line, ctx, lookSeen?.get(line.lineId));
        if (!reason && (!choice || Rolls.roll('board_look', Number(state.characterId), `${line.lineId}:${choice.deals}`)
            >= choice.probability)) continue;
        reviewReasons.set(line.lineId, reason);
        selected.push({ line, input, deals: choice?.deals ?? finite(line.pricing.seenCounter) });
    }
    if (!selected.length) return null;
    const review = require('./MarketPricing').look(state, selected.map(row => row.line), { ...ctx, visit, reviewReasons });
    if (lookSeen) {
        const changed = new Set([...(review?.reprices || []), ...(review?.withdrawals || [])].map(row => row.lineId));
        for (const { line, input, deals } of selected) {
            if (changed.has(line.lineId)) continue;
            lookSeen.delete(line.lineId);
            if (lookSeen.size >= MAX_LINES) lookSeen.delete(lookSeen.keys().next().value);
            lookSeen.set(line.lineId, { deals, at: ctx.timestamp });
            keepInputs(lookSeen, line.lineId, input);
        }
    }
    return review;
}

module.exports = { MAX_LINES, MAX_OWNED_LINES, SeenLines, attention, review, indexedFeasibility,
    lineFingerprint, feasibilityPredicate };
