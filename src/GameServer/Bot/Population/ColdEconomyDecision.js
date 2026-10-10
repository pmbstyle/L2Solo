'use strict';

// A cold bot's wish network is built in the worker when it projects a
// resolve. Main then commits that state and needs the bot's decided activity
// (where to hunt, which mob, which improvement) for its next context, route
// and post-commit improvement. It reads the
// worker's decision made on exactly that state instead of building the
// network again on the main thread (L25). Kept in memory only, one entry per
// bot; a missing or older entry waits for the next worker decision.
const { isMainThread } = require('node:worker_threads');
const { fnv1a32 } = require('../Fnv1a');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const kinds = [undefined, 'improvement', 'book', 'resale', 'shots', 'potions'];
function kindCode(kind) { const code = kinds.indexOf(kind); return code < 0 ? 255 : code; }
function kindFor(code) { return kinds[code]; }
// A wish row carrying only the urgent root's urgency: the leaf has no root of
// its own, so no amount or price is published (MVP-1), only gapHorizonHours.
const URGENCY_ONLY = 62;
class CompactActivity {
    constructor(leaf) {
        this.activity = leaf.activity || null; this.spotId = leaf.spotId ?? null; this.npcId = leaf.npcId ?? null;
        this.itemId = Number(leaf.itemId || (typeof leaf.object === 'number' ? leaf.object : leaf.object?.itemId) || 0);
        this.amount = Number(leaf.amount || 0); this.price = Number(leaf.price || 0);
        if (leaf.unitPrice !== undefined && leaf.unitPrice !== null) this.unitPrice = Number(leaf.unitPrice);
        // The funded root's money-packet ratio: a material bought for a root whose
        // packet row has no item id (henna, merged tail) is funded by this ratio.
        if (Number(leaf.r) > 0 && Number.isFinite(Number(leaf.r))) this.r = Number(leaf.r);
        if (leaf.heldAtDecision !== undefined && leaf.heldAtDecision !== null) this.heldAtDecision = Number(leaf.heldAtDecision);
        if (leaf.rootKey) this.rootKey = leaf.rootKey;
        if (leaf.town) this.town = leaf.town;
        if (leaf.sourceType) this.sourceType = leaf.sourceType;
        if (leaf.kind) this.kind = leaf.kind;
        if (leaf.recipeId) this.recipeId = leaf.recipeId;
        if (leaf.targetId) this.targetId = leaf.targetId;
        if (leaf.funding) this.funding = true;
        if (leaf.items) this.items = leaf.items.slice(0, 8).map(Number);
        if (leaf.activity === 'improving' && leaf.improvement) this.improvement = { ...leaf.improvement };
    }
}
// ARCH-NOTE: tuple arrays plus their JS headers exceed the 0.8 KB budget.
// One binary record keeps exact watch/material numbers, leaf fields and Float32 usefulness;
// the public tuple fields are decoded on demand and are never retained twice.
const encoder = new TextEncoder(), decoder = new TextDecoder();
const WORKSHOP = 16384;
const SHOT = 32768;
const FEASIBILITY = 65536;
const URGENCY_STAGE = 1, URGENCY_SHOTS = 2, URGENCY_POTIONS = 3;
const MAX_BYTES = 800, MAX_SHOT_BYTES = 128;
const COMMAND_HEADER_BYTES = Buffer.byteLength(JSON.stringify(['00000000-0000-0000-0000-000000000000', 5, Number.MAX_SAFE_INTEGER]));
const MAX_SHOT_PAYLOAD_BYTES = MAX_SHOT_BYTES - COMMAND_HEADER_BYTES;
function workshopValues(value) {
    if (!value || value.known === false) return [0, 0, NaN, NaN];
    const recipeId = Number(value.recipeId || 0), productId = Number(value.productId || 0);
    if (!recipeId && !productId && value.known === true) return [0, 0, 0, 0];
    const income = Number(value.incomePerHour), cycle = Number(value.cycleHours);
    return recipeId > 0 && productId > 0 && income > 0 && cycle > 0
        && Number.isFinite(income) && Number.isFinite(cycle) ? [recipeId, productId, income, cycle] : [0, 0, NaN, NaN];
}
function unknownWorkshop() { return { known: false, recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN }; }
class CompactDecision {
    constructor(updatedAt, key, riskWeight, activity, data, flags) {
        this.key = key; this.data = data;
        const view = new DataView(data);
        if (updatedAt !== undefined) view.setFloat64(8, updatedAt, true);
        if (riskWeight !== undefined) view.setFloat64(16, riskWeight, true);
        if (flags !== undefined) view.setUint32(24, flags, true);
    }
    get activity() {
        const counts = this.counts;
        let at = 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21 + ((counts >>> 8) & 15) * 12
            + (counts & 4096 ? 17 : 0) + (counts & 8192 ? 32 : 0) + (counts & WORKSHOP ? 32 : 0) + (counts & FEASIBILITY ? 8 : 0);
        if (counts & SHOT) at += 2 + new DataView(this.data).getUint16(at, true);
        if (at === this.data.byteLength) return null;
        const row = JSON.parse(decoder.decode(new Uint8Array(this.data, at)));
        return new CompactActivity({ activity: row[0], spotId: row[1], npcId: row[2], kind: row[3], rootKey: row[4],
            itemId: row[5], amount: row[6], price: row[7], recipeId: row[8], targetId: row[9], funding: row[10], items: row[11], improvement: row[12], heldAtDecision: row[13], town: row[14], sourceType: row[15], unitPrice: row[16], r: row[17] });
    }
    get updatedAt() { return new DataView(this.data).getFloat64(8, true); }
    get riskWeight() { return new DataView(this.data).getFloat64(16, true); }
    get flags() { return new DataView(this.data).getUint32(24, true); }
    set flags(value) { if (value !== this.flags) { this.data = this.data.slice(0); new DataView(this.data).setUint32(24, value, true); } }
    get stale() { return !!(this.flags & 1); }
    set stale(value) { this.flags = value ? this.flags | 1 : this.flags & ~1; }
    get held() { return !!(this.flags & 2); }
    set held(value) { this.flags = value ? this.flags | 2 : this.flags & ~2; }
    get workshopStale() { return !!(this.flags & 4); }
    set workshopStale(value) { this.flags = value ? this.flags | 4 : this.flags & ~4; }
    get counts() { return new DataView(this.data).getUint32(0, true); }
    get inputHash() { return new DataView(this.data).getUint32(4, true); }
    get usefulness() { return new Float32Array(this.data, 28, (this.counts & 63) * 2); }
    get watch() {
        const counts = this.counts, n = counts & 63, w = (counts >>> 6) & 3, view = new DataView(this.data);
        return Array.from({ length: w }, (_, i) => { const at = 28 + n * 8 + i * 21;
            return [view.getUint32(at, true), view.getFloat64(at + 4, true), view.getFloat64(at + 12, true), view.getUint8(at + 20)]; });
    }
    get materials() {
        const counts = this.counts, n = counts & 63, w = (counts >>> 6) & 3, m = (counts >>> 8) & 15, view = new DataView(this.data);
        return Array.from({ length: m }, (_, i) => { const at = 28 + n * 8 + w * 21 + i * 12;
            return [view.getUint32(at, true), view.getFloat64(at + 4, true)]; });
    }
    get wish() {
        const counts = this.counts;
        if (!(counts & 4096)) return null;
        const at = 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21 + ((counts >>> 8) & 15) * 12;
        const view = new DataView(this.data);
        const kind = view.getUint8(at) & 63;
        if (kind === URGENCY_ONLY) return null;
        return [kind === 63 ? 255 : kind, view.getFloat64(at + 1, true), view.getFloat64(at + 9, true)];
    }
    get urgency() {
        const counts = this.counts;
        if (!(counts & 4096)) return 0;
        const at = 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21 + ((counts >>> 8) & 15) * 12;
        return new DataView(this.data).getUint8(at) >>> 6;
    }
    get clan() {
        const counts = this.counts;
        if (!(counts & 8192)) return null;
        const at = 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21 + ((counts >>> 8) & 15) * 12 + (counts & 4096 ? 17 : 0);
        const view = new DataView(this.data), itemId = view.getFloat64(at + 16, true);
        return { horizonHours: view.getFloat64(at, true), huntPerHour: view.getFloat64(at + 8, true),
            plan: itemId ? { itemId, valueHours: view.getFloat64(at + 24, true) } : null };
    }
    get workshop() {
        const counts = this.counts;
        if (!(counts & WORKSHOP) || this.workshopStale) return unknownWorkshop();
        const at = 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21 + ((counts >>> 8) & 15) * 12
            + (counts & 4096 ? 17 : 0) + (counts & 8192 ? 32 : 0);
        const view = new DataView(this.data);
        const incomePerHour = view.getFloat64(at + 16, true), cycleHours = view.getFloat64(at + 24, true);
        return { known: Number.isFinite(incomePerHour) && Number.isFinite(cycleHours),
            recipeId: view.getFloat64(at, true), productId: view.getFloat64(at + 8, true), incomePerHour, cycleHours };
    }
    get shot() {
        const counts = this.counts;
        if (!(counts & SHOT) || this.workshopStale || this.stale || this.held) return null;
        const at = 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21 + ((counts >>> 8) & 15) * 12
            + (counts & 4096 ? 17 : 0) + (counts & 8192 ? 32 : 0) + (counts & WORKSHOP ? 32 : 0) + (counts & FEASIBILITY ? 8 : 0);
        const bytes = new DataView(this.data).getUint16(at, true);
        return JSON.parse(decoder.decode(new Uint8Array(this.data, at + 2, bytes)));
    }
    get feasibility() {
        const counts = this.counts;
        if (!(counts & FEASIBILITY) || this.workshopStale || this.stale) return null;
        const at = 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21 + ((counts >>> 8) & 15) * 12
            + (counts & 4096 ? 17 : 0) + (counts & 8192 ? 32 : 0) + (counts & WORKSHOP ? 32 : 0);
        const view = new DataView(this.data);
        return [view.getUint32(at, true), view.getUint16(at + 4, true), view.getUint16(at + 6, true)];
    }
}
function compact(record) {
    if (record.data instanceof ArrayBuffer) {
        const result = new CompactDecision(record.updatedAt, record.key, record.riskWeight, null, record.data, record.flags);
        if (Object.hasOwn(record, 'stale')) result.stale = record.stale;
        if (Object.hasOwn(record, 'held')) result.held = record.held;
        if (Object.hasOwn(record, 'workshopStale')) result.workshopStale = record.workshopStale;
        return result;
    }
    const pairs = record.usefulness || [], watch = record.watch || [], materials = record.materials || [], wish = record.wish;
    const w = Math.min(3, watch.length), m = Math.min(8, materials.length);
    const leaf = record.activity;
    const activity = leaf ? encoder.encode(JSON.stringify([leaf.activity, leaf.spotId, leaf.npcId, leaf.kind, leaf.rootKey,
        leaf.itemId, leaf.amount, leaf.price, leaf.recipeId, leaf.targetId, leaf.funding, leaf.items, leaf.improvement,
        ...(leaf.town || leaf.sourceType || leaf.unitPrice !== undefined || leaf.r !== undefined
            ? [leaf.heldAtDecision ?? null, leaf.town || null, leaf.sourceType || null, leaf.unitPrice ?? null,
                ...(leaf.r !== undefined ? [leaf.r] : [])]
            : leaf.heldAtDecision !== undefined ? [leaf.heldAtDecision] : [])])) : [];
    const clan = record.clan;
    const workshop = Object.hasOwn(record, 'workshop') ? workshopValues(record.workshop) : null;
    const feasibility = Array.isArray(record.feasibility) && record.feasibility[2] <= 14 ? record.feasibility : null;
    let shot = record.shot ? encoder.encode(JSON.stringify(record.shot)) : null;
    if (shot?.length > MAX_SHOT_PAYLOAD_BYTES) shot = encoder.encode(JSON.stringify({ unknown: true }));
    const fixed = 28 + w * 21 + m * 12 + (wish ? 17 : 0) + (clan ? 32 : 0) + (workshop ? 32 : 0)
        + (feasibility ? 8 : 0) + (shot ? shot.length + 2 : 0) + activity.length;
    // The key and object/ArrayBuffer wire tags share this cap with the payload.
    const wireRoom = MAX_BYTES - 48 - encoder.encode(String(record.key || '')).length;
    const n = Math.min(40, Math.floor(pairs.length / 2), Math.max(0, Math.floor((wireRoom - fixed) / 8)));
    const data = new ArrayBuffer(fixed + n * 8), view = new DataView(data);
    view.setUint32(0, n | (w << 6) | (m << 8) | (wish ? 4096 : 0) | (clan ? 8192 : 0) | (workshop ? WORKSHOP : 0) | (shot ? SHOT : 0) | (feasibility ? FEASIBILITY : 0), true);
    view.setUint32(4, record.inputHash >>> 0, true);
    new Float32Array(data, 28, n * 2).set(pairs.subarray ? pairs.subarray(0, n * 2) : pairs.slice(0, n * 2));
    let at = 28 + n * 8;
    for (const row of watch.slice(0, w)) { view.setUint32(at, row[0], true); view.setFloat64(at + 4, row[1], true);
        view.setFloat64(at + 12, row[2], true); view.setUint8(at + 20, row[3]); at += 21; }
    for (const row of materials.slice(0, m)) { view.setUint32(at, row[0], true); view.setFloat64(at + 4, row[1], true); at += 12; }
    if (wish) { view.setUint8(at, wish[0]); view.setFloat64(at + 1, wish[1], true); view.setFloat64(at + 9, wish[2], true); at += 17; }
    if (clan) { view.setFloat64(at, clan.horizonHours, true); view.setFloat64(at + 8, clan.huntPerHour, true);
        view.setFloat64(at + 16, clan.plan?.itemId || 0, true); view.setFloat64(at + 24, clan.plan?.valueHours || 0, true); at += 32; }
    if (workshop) { for (const value of workshop) { view.setFloat64(at, value, true); at += 8; } }
    if (feasibility) { view.setUint32(at, feasibility[0], true); view.setUint16(at + 4, feasibility[1], true);
        view.setUint16(at + 6, feasibility[2], true); at += 8; }
    if (shot) { view.setUint16(at, shot.length, true); new Uint8Array(data, at + 2, shot.length).set(shot); at += shot.length + 2; }
    new Uint8Array(data, at).set(activity);
    return new CompactDecision(record.updatedAt, record.key, record.riskWeight, record.activity, data);
}

// What a decision depends on beyond updatedAt: a commit can merge clan or
// goal changes and a projection can change the class after the network was
// built, both keeping updatedAt; such a decision is not used.
function stateKey(state = {}) {
    const stats = state.stats || {};
    const plan = stats.equipmentPlan;
    return [Number(state.level || 0), Number(stats.classId || 0), state.activity || '', Number(stats.clanId || 0),
        plan ? `${plan.status || ''}:${Number(plan.target?.selfId || 0)}:${plan.clanGoal ? 1 : 0}` : '',
        Number(state.adena ?? state.inventory?.[57]?.amount ?? 0), Number(state.vitals?.mp ?? 0)].join('|');
}

// Units a bot holds against a card's item: the bag and accepted incoming,
// the two amounts the core subtracts from an order (MVP-3).
function heldFor(state, itemId) {
    return Math.max(0, Number(state?.inventory?.[itemId]?.amount || 0))
        + Math.max(0, Number(state?.acceptedIncoming?.[itemId] || 0));
}
// What a shopping leaf still orders now: the core's amount less what reached
// the bag or accepted incoming since the decision (heldAtDecision; a full
// worker leaf is read against its own decided state).
function remainingToOrder(leaf, state, decided = state, itemId = leaf?.itemId) {
    const id = Number(itemId), baseline = Number(leaf?.heldAtDecision ?? heldFor(decided, id));
    return Math.max(0, Math.ceil(Number(leaf?.amount) || 0) - Math.max(0, heldFor(state, id) - baseline));
}

// economy: the network built on `seen` (the state before the projection's
// last changes); state: the projected state main will commit.
function capture(economy, state, seen = state) {
    const leaf = economy?.network?.activity || null;
    const queue = economy?.network?.queue || [];
    const urgent = economy?.network?.gap || queue.find(row => row.key === economy?.network?.focus?.[0]) || queue[0];
    // The card's wish is the leaf's own root or none: another root's amount
    // and price never stand in for the core's step (MVP-1).
    const wish = queue.find(row => row.key === leaf?.rootKey) || null;
    const urgency = !urgent ? 0 : urgent.key === 'stock:shots' ? URGENCY_SHOTS
        : urgent.key === 'stock:potions' ? URGENCY_POTIONS : URGENCY_STAGE;
    const useful = new Map(economy?.projection?.values || []);
    for (const [key, value] of economy?.network?.demands || []) {
        if (key.startsWith('item:') && value > 0) useful.set(Number(key.slice(5)), value);
    }
    const usefulness = new Float32Array([...useful].filter(([id, value]) => id > 0 && value > 0)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 40).flat());
    // The core's craft inputs to order only (MVP-3): a quantity-prepared
    // network (a stock reader) holds each input's remaining amount, stock and
    // accepted incoming subtracted once. A network without a stock reader has
    // no missing amounts, and no recipe walk guesses them.
    const missing = new Map();
    const visit = (plan, depth = 0) => {
        if (!plan || depth > 8) return;
        if (plan.kind === 'craft' || plan.improvement) for (const row of plan.requirements || []) {
            const gap = Math.max(0, Number(row.plan?.missingAmount || 0));
            if (row.key?.startsWith('item:') && row.amount > 0 && gap > 0) {
                const id = Number(row.key.slice(5));
                missing.set(id, Math.max(missing.get(id) || 0, gap));
            }
        }
        for (const row of plan.requirements || []) visit(row.plan, depth + 1);
    };
    if (economy?.network?.quantityPrepared) for (const row of queue) visit(row.plan);
    const activity = leaf ? new CompactActivity(leaf) : null;
    if (activity?.activity === 'shopping') {
        activity.heldAtDecision = heldFor(seen, activity.itemId);
        const r = require('../Economy/PurchaseFunding').rootRatio(wish);
        if (r > 0) activity.r = r;
    }
    let clan = null;
    // Workshop-only publications carry no hunting valuation. Clan membership
    // cannot turn that partial source into a second, fabricated economy review.
    if (Number(state?.stats?.clanId) > 0 && economy?.hunt) {
        const horizonHours = economy.horizonHours ?? invoke('GameServer/Bot/Economy/EconomicValuation')
            .stageHours(state, economy.hunt.expPerHour, economy.persona);
        const itemId = Number(state.stats.equipmentPlan?.target?.selfId || 0);
        let valueHours = itemId ? Math.max(0, Number(economy.itemUsefulness(itemId)) || 0) : 0;
        if (itemId && !valueHours) {
            const item = invoke('GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, itemId);
            if (item?.etc?.slot) {
                // ARCH-NOTE: PERF: Wall time expired this resolve's buffs and
                // evicted 159-209 evaluated gains per actor. Sharing the clock
                // reduced paired added P95 6.465 -> 3.335 ms on 300 native actors;
                // the measured maximum 6.569 ms still exceeds the strict +5 ms limit.
                const gain = invoke('GameServer/Bot/Economy/WishProviders').gearGain(state, item, economy.timestamp);
                valueHours = Math.max(0, (gain.attack + gain.defence * economy.deathHours) * horizonHours);
            }
        }
        clan = { horizonHours, huntPerHour: economy.hunt.perHour, plan: itemId ? { itemId, valueHours } : null };
    }
    const decision = compact({
        updatedAt: Number(state?.updatedAt || 0),
        key: stateKey(seen),
        riskWeight: Number(economy?.riskWeight) || 0,
        activity,
        // Upper two bits reuse the existing byte; amount and price remain exact.
        wish: wish ? [(kindCode(wish.object?.kind) & 63) | (urgency << 6),
            Number(wish.object?.amount || 0), Number(wish.price || 0)] : urgency ? [URGENCY_ONLY | (urgency << 6), 0, 0] : null,
        watch: (economy?.watchList || []).slice(0, 3).map(row => [Number(row.itemId), Number(row.amount), Number(row.worth), kindCode(row.kind)]),
        materials: [...missing].slice(0, 8), usefulness, inputHash: fnv1a32(economy?.inputKey || ''), clan,
        workshop: economy?.workshop || unknownWorkshop(), shot: economy?.shot || null,
        feasibility: economy?.workshop?.feasibility || economy?.feasibility || null
    });
    if (Diagnostics.active()) Diagnostics.count('ready_card', 'build', 'decision_pack');
    if (Diagnostics.active() && Diagnostics.enabled(state?.characterId)) Diagnostics.push({ owner: state.characterId,
        caller: 'cold_decision_capture', trigger: 'decision_pack', phase: 'decision_preparation',
        reason: 'prepared_card', inputHash: decision.inputHash, revision: state.simulation?.revision,
        decisionSeq: economy?.network?.decisionSeq, activityLeaf: economy?.network?.activityLeaf,
        wishKey: activity?.rootKey, item: activity?.itemId, planned: activity?.amount,
        owned: activity?.heldAtDecision, quote: activity?.price, town: activity?.town,
        source: activity?.sourceType || activity?.kind, npcId: activity?.npcId,
        recipeId: activity?.recipeId });
    return decision;
}

// Shared error adjustment of an already prepared usefulness scalar. Neither
// the compact-card reader nor the full worker builds a second wish graph.
function personalUsefulness(value, state, understanding, enabled, id) {
    return value * (enabled ? 1 + (1 - Number(understanding ?? .3))
        * (2 * invoke('GameServer/Bot/AI/TendencyRoll').roll('usefulness', state.characterId, id) - 1) : 1);
}
function preparedCardWorth(decision, id, state, moneyPrice, understanding, enabled) {
    if (!decision || decision.stale || !(moneyPrice > 0)) return NaN;
    const data = decision.data, count = decision.counts & 63;
    if (!data || data.byteLength > MAX_BYTES) return NaN;
    const pairs = new Float32Array(data, 28, count * 2);
    for (let n = 0; n < pairs.length; n += 2) if (pairs[n] === Number(id)) {
        return personalUsefulness(pairs[n + 1], state, understanding, enabled, id) / moneyPrice;
    }
    return NaN;
}

function view(state, decision, deps = {}) {
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const base = Economy.basics(state, deps), packet = state.stats?.money;
    const valid = Array.isArray(packet) && packet.length >= 4;
    const hourAdena = valid ? Number(packet[0]) : base.hourAdena;
    const moneyPrice = valid ? Number(packet[1]) : hourAdena > 0 ? 1 / hourAdena : 0;
    const known = id => {
        const pairs = decision?.usefulness || [];
        for (let i = 0; i < pairs.length; i += 2) if (pairs[i] === Number(id)) return pairs[i + 1];
        return null;
    };
    const enabled = deps.knowledgeEnabled ?? invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled();
    const itemUsefulness = id => personalUsefulness(known(id) || 0, state, base.persona.understanding, enabled, id);
    const activity = decision?.activity || null;
    const wish = decision?.wish ? { object: { kind: kindFor(decision.wish[0]), amount: decision.wish[1] }, price: decision.wish[2] } : null;
    return { ...base, state, hourAdena, moneyPrice, survivalReserve: valid ? Number(packet[2]) : base.survivalReserve,
        gapHorizonHours: !decision?.urgency ? 0 : decision.urgency === URGENCY_SHOTS
            ? base.stock('shots').targetHours : decision.urgency === URGENCY_POTIONS
                ? base.stock('potions').targetHours
                : invoke('GameServer/Bot/Economy/EconomicValuation').stageHours(state, base.hunt.expPerHour, base.persona),
        board: deps.board || invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(),
        network: { activity }, activity, wish,
        watchList: (decision?.watch || []).map(row => ({ itemId: row[0], amount: row[1], worth: row[2], kind: kindFor(row[3]) })),
        materials: decision?.materials || [], inputHash: decision?.inputHash || 0, decided: !!decision,
        workshop: decision?.workshop || unknownWorkshop(),
        itemUsefulness, worth: id => known(id) !== null && moneyPrice > 0 ? itemUsefulness(id) / moneyPrice : base.price(id) };
}
function economyFor(state, deps = {}) {
    if (isMainThread && state?.phase === 'cold') return view(state,
        (deps.decisions || invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions).decided(state), deps);
    return invoke('GameServer/Bot/Economy/EconomyContext').forState(state, deps);
}

// Compare the existing compact economic output, without decoding it or
// keeping another per-owner snapshot. Input digest, publication clock and
// validity/held flags are metadata. The feasibility fingerprint binds its
// mask to board identities/revisions; the mask itself is an economic result.
function sameEconomicOutput(before, after) {
    if (before.data.byteLength > MAX_BYTES || after.data.byteLength > MAX_BYTES) return null;
    if (before.data.byteLength !== after.data.byteLength || before.counts !== after.counts) return false;
    const counts = before.counts;
    const fingerprint = counts & FEASIBILITY ? 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21
        + ((counts >>> 8) & 15) * 12 + (counts & 4096 ? 17 : 0) + (counts & 8192 ? 32 : 0)
        + (counts & WORKSHOP ? 32 : 0) : -1;
    const left = new Uint8Array(before.data), right = new Uint8Array(after.data);
    for (let at = 16; at < left.length; at++) {
        if (at >= 24 && at < 28 || at >= fingerprint && at < fingerprint + 4) continue;
        if (left[at] !== right[at]) return false;
    }
    return true;
}

class ColdEconomyDecisions {
    constructor() {
        this.byId = new Map();
        this.hits = Diagnostics.active() ? 0 : null;
        this.misses = Diagnostics.active() ? 0 : null;
    }

    // committed: the commit's result. A commit that merged board deals or PK
    // drops into the bag keeps the worker's updatedAt, but the decision was
    // made on the bag before them: keep its numbers, but defer its wishes.
    accept(characterId, decision, committed = null) {
        const id = Number(characterId);
        if (!id) return;
        const incoming = decision ? compact(decision) : null;
        const bagChanged = !!committed?.settled || !!committed?.pkDrops?.length;
        if (Diagnostics.active() && incoming && Number.isFinite(Number(incoming.updatedAt))) {
            const previous = this.byId.get(id);
            Diagnostics.count('ready_card', 'publication', !previous ? 'first_card'
                : previous.updatedAt === incoming.updatedAt ? 'same_clock' : 'updated_at');
            const same = previous ? sameEconomicOutput(previous, incoming) : null;
            Diagnostics.count('ready_card', same === null ? 'comparison_unavailable' : same ? 'unchanged' : 'changed',
                same === null ? previous ? 'wide_packet' : 'not_retained' : 'economic_output');
            if (Diagnostics.enabled(id)) {
                const activity = incoming.activity;
                Diagnostics.push({ owner: id, caller: 'cold_decision_accept', phase: 'decision_publication',
                    trigger: bagChanged ? 'native_bag_changed' : 'state_publication',
                    reason: same === null ? 'comparison_unavailable' : same ? 'economic_output_unchanged' : 'economic_output_changed',
                    inputHash: incoming.inputHash, wishKey: activity?.rootKey, item: activity?.itemId,
                    planned: activity?.amount, quote: activity?.price, source: activity?.sourceType || activity?.kind,
                    town: activity?.town, npcId: activity?.npcId, recipeId: activity?.recipeId });
            }
        }
        if (incoming && Number.isFinite(Number(incoming.updatedAt))) this.byId.set(id, compact({ ...incoming, stale: bagChanged }));
        else if (this.byId.has(id)) this.byId.get(id).stale = true;
    }

    // The worker's decision made on exactly this state, or held for a command.
    decided(state) {
        const diagnostic = Diagnostics.active();
        if (diagnostic) Diagnostics.count('ready_card', 'request');
        const id = Number(state?.characterId);
        const decision = this.byId.get(id);
        if (this.matches(state, decision)) {
            if (diagnostic) { this.hits += 1; Diagnostics.count('ready_card', 'hit', decision.held ? 'held_command' : 'same_inputs'); }
            return decision;
        }
        if (diagnostic) {
            this.misses += 1;
            Diagnostics.count('ready_card', 'miss', !decision ? 'not_published' : decision.stale ? 'stale_card'
                : decision.updatedAt !== Number(state?.updatedAt || 0) ? 'state_publication' : 'input_dependency_changed');
        }
        return null;
    }

    // A miss waits for the next worker decision.
    matches(state, decision) {
        return !!decision && (decision.held || !decision.stale && decision.updatedAt === Number(state?.updatedAt || 0)
            && decision.key === stateKey(state));
    }
    // Observer inspection shares admission rules without affecting hit counters.
    inspect(state) {
        const decision = this.byId.get(Number(state?.characterId));
        return this.matches(state, decision) ? decision : null;
    }
    activity(state) { return this.decided(state)?.activity || null; }
    hold(id, decision) { if (decision) this.byId.set(Number(id), compact({ ...compact(decision), held: true })); }
    release(id) { const decision = this.byId.get(Number(id)); if (decision) { decision.held = false; decision.stale = true; } }
    forget(id) {
        if (this.byId.delete(Number(id)) && Diagnostics.active()) Diagnostics.count('ready_card', 'eviction', 'owner_release');
    }
    size() { return this.byId.size; }
    clanNumbers(id) {
        const entry = this.byId.get(Number(id)), clan = entry?.clan;
        return clan ? { ...clan, updatedAt: entry.updatedAt } : null;
    }
    workshopFor(state) {
        // A held strategic decision may survive a physical command. Its earning
        // estimate cannot: the accepted publication must still match this bag.
        const entry = this.byId.get(Number(state?.characterId));
        return entry && !entry.stale && entry.updatedAt === Number(state?.updatedAt || 0)
            && entry.key === stateKey(state) ? entry.workshop : unknownWorkshop();
    }
    feasibilityFor(state) {
        const entry = this.byId.get(Number(state?.characterId));
        return entry && !entry.stale && entry.updatedAt === Number(state?.updatedAt || 0)
            && entry.key === stateKey(state) ? entry.feasibility : null;
    }
    staleWorkshop(id, expected) {
        const entry = this.byId.get(Number(id));
        if (entry && (!expected || entry.updatedAt === expected.updatedAt && entry.key === expected.key)) entry.workshopStale = true;
    }
    clear() {
        if (Diagnostics.active() && this.byId.size) Diagnostics.count('ready_card', 'eviction', 'reset', this.byId.size);
        this.byId.clear();
    }
}

module.exports = { personalUsefulness, preparedCardWorth, capture, heldFor, remainingToOrder, stateKey, CompactActivity, ColdEconomyDecisions, economyFor, view, kindCode, kindFor, compact, workshopValues,
    unknownWorkshop, MAX_BYTES, MAX_SHOT_BYTES, COMMAND_HEADER_BYTES, MAX_SHOT_PAYLOAD_BYTES };
