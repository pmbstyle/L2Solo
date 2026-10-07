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
const kinds = [undefined, 'improvement', 'book', 'resale', 'shots', 'potions'];
function kindCode(kind) { const code = kinds.indexOf(kind); return code < 0 ? 255 : code; }
function kindFor(code) { return kinds[code]; }
class CompactActivity {
    constructor(leaf) {
        this.activity = leaf.activity || null; this.spotId = leaf.spotId ?? null; this.npcId = leaf.npcId ?? null;
        this.itemId = Number(leaf.itemId || (typeof leaf.object === 'number' ? leaf.object : leaf.object?.itemId) || 0);
        this.amount = Number(leaf.amount || 0); this.price = Number(leaf.price || 0);
        if (leaf.heldAtDecision !== undefined && leaf.heldAtDecision !== null) this.heldAtDecision = Number(leaf.heldAtDecision);
        if (leaf.rootKey) this.rootKey = leaf.rootKey;
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
        const at = 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21 + ((counts >>> 8) & 15) * 12
            + (counts & 4096 ? 17 : 0) + (counts & 8192 ? 32 : 0);
        if (at === this.data.byteLength) return null;
        const row = JSON.parse(decoder.decode(new Uint8Array(this.data, at)));
        return new CompactActivity({ activity: row[0], spotId: row[1], npcId: row[2], kind: row[3], rootKey: row[4],
            itemId: row[5], amount: row[6], price: row[7], recipeId: row[8], targetId: row[9], funding: row[10], items: row[11], improvement: row[12], heldAtDecision: row[13] });
    }
    get updatedAt() { return new DataView(this.data).getFloat64(8, true); }
    get riskWeight() { return new DataView(this.data).getFloat64(16, true); }
    get flags() { return new DataView(this.data).getUint32(24, true); }
    set flags(value) { if (value !== this.flags) { this.data = this.data.slice(0); new DataView(this.data).setUint32(24, value, true); } }
    get stale() { return !!(this.flags & 1); }
    set stale(value) { this.flags = value ? this.flags | 1 : this.flags & ~1; }
    get held() { return !!(this.flags & 2); }
    set held(value) { this.flags = value ? this.flags | 2 : this.flags & ~2; }
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
        return [view.getUint8(at), view.getFloat64(at + 1, true), view.getFloat64(at + 9, true)];
    }
    get clan() {
        const counts = this.counts;
        if (!(counts & 8192)) return null;
        const at = 28 + (counts & 63) * 8 + ((counts >>> 6) & 3) * 21 + ((counts >>> 8) & 15) * 12 + (counts & 4096 ? 17 : 0);
        const view = new DataView(this.data), itemId = view.getFloat64(at + 16, true);
        return { horizonHours: view.getFloat64(at, true), huntPerHour: view.getFloat64(at + 8, true),
            plan: itemId ? { itemId, valueHours: view.getFloat64(at + 24, true) } : null };
    }
}
function compact(record) {
    if (record.data instanceof ArrayBuffer) {
        const result = new CompactDecision(record.updatedAt, record.key, record.riskWeight, null, record.data, record.flags);
        if (Object.hasOwn(record, 'stale')) result.stale = record.stale;
        if (Object.hasOwn(record, 'held')) result.held = record.held;
        for (const key of ['workshopToken', 'workshop']) if (Object.hasOwn(record, key)) result[key] = record[key];
        return result;
    }
    const pairs = record.usefulness || [], watch = record.watch || [], materials = record.materials || [], wish = record.wish;
    const n = Math.min(40, pairs.length / 2), w = Math.min(3, watch.length), m = Math.min(8, materials.length);
    const leaf = record.activity;
    const activity = leaf ? encoder.encode(JSON.stringify([leaf.activity, leaf.spotId, leaf.npcId, leaf.kind, leaf.rootKey,
        leaf.itemId, leaf.amount, leaf.price, leaf.recipeId, leaf.targetId, leaf.funding, leaf.items, leaf.improvement,
        ...(leaf.heldAtDecision !== undefined ? [leaf.heldAtDecision] : [])])) : [];
    const clan = record.clan;
    const data = new ArrayBuffer(28 + n * 8 + w * 21 + m * 12 + (wish ? 17 : 0) + (clan ? 32 : 0) + activity.length), view = new DataView(data);
    view.setUint32(0, n | (w << 6) | (m << 8) | (wish ? 4096 : 0) | (clan ? 8192 : 0), true);
    view.setUint32(4, record.inputHash >>> 0, true);
    new Float32Array(data, 28, n * 2).set(pairs.subarray ? pairs.subarray(0, n * 2) : pairs.slice(0, n * 2));
    let at = 28 + n * 8;
    for (const row of watch.slice(0, w)) { view.setUint32(at, row[0], true); view.setFloat64(at + 4, row[1], true);
        view.setFloat64(at + 12, row[2], true); view.setUint8(at + 20, row[3]); at += 21; }
    for (const row of materials.slice(0, m)) { view.setUint32(at, row[0], true); view.setFloat64(at + 4, row[1], true); at += 12; }
    if (wish) { view.setUint8(at, wish[0]); view.setFloat64(at + 1, wish[1], true); view.setFloat64(at + 9, wish[2], true); at += 17; }
    if (clan) { view.setFloat64(at, clan.horizonHours, true); view.setFloat64(at + 8, clan.huntPerHour, true);
        view.setFloat64(at + 16, clan.plan?.itemId || 0, true); view.setFloat64(at + 24, clan.plan?.valueHours || 0, true); at += 32; }
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
        plan ? `${plan.status || ''}:${Number(plan.target?.selfId || 0)}:${plan.clanGoal ? 1 : 0}` : ''].join('|');
}

// economy: the network built on `seen` (the state before the projection's
// last changes); state: the projected state main will commit.
function capture(economy, state, seen = state) {
    const leaf = economy?.network?.activity || null;
    const wish = economy?.network?.queue?.find(row => row.key === leaf?.rootKey);
    const useful = new Map(economy?.projection?.values || []);
    for (const [key, value] of economy?.network?.demands || []) {
        if (key.startsWith('item:') && value > 0) useful.set(Number(key.slice(5)), value);
    }
    const usefulness = new Float32Array([...useful].filter(([id, value]) => id > 0 && value > 0)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 40).flat());
    const missing = new Map();
    for (const row of economy?.network?.queue || []) {
        for (const material of row.object?.materials || []) {
            const id = Number(material.selfId), amount = Math.max(0, Number(material.amount || 0) - Number(state?.inventory?.[id]?.amount || 0));
            if (id > 0 && amount > 0) missing.set(id, Math.max(missing.get(id) || 0, amount));
        }
    }
    const visit = (key, amount = 1, depth = 0) => {
        if (depth > 8) return;
        const plan = economy?.network?.plans?.get(key);
        if (!plan) return;
        if (plan.kind === 'craft') for (const row of plan.requirements || []) {
            if (row.key?.startsWith('item:') && row.amount > 0) {
                const id = Number(row.key.slice(5));
                const gap = Math.max(0, row.amount * amount - Number(state?.inventory?.[id]?.amount || 0));
                if (gap > 0) missing.set(id, Math.max(missing.get(id) || 0, gap));
            }
        }
        for (const row of plan.requirements || []) visit(row.key, amount * row.amount, depth + 1);
    };
    for (const wish of economy?.network?.queue || []) visit(wish.key, Number(wish.object?.amount || 1));
    const activity = leaf ? new CompactActivity(leaf) : null;
    if (activity?.activity === 'shopping') activity.heldAtDecision = Math.max(0, Number(seen?.inventory?.[activity.itemId]?.amount || 0));
    let clan = null;
    if (Number(state?.stats?.clanId) > 0) {
        const horizonHours = economy.horizonHours ?? require('../Economy/EconomicValuation')
            .stageHours(state, economy.hunt.expPerHour, economy.persona);
        const itemId = Number(state.stats.equipmentPlan?.target?.selfId || 0);
        let valueHours = itemId ? Math.max(0, Number(economy.itemUsefulness(itemId)) || 0) : 0;
        if (itemId && !valueHours) {
            const item = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, itemId);
            if (item?.etc?.slot) {
                const gain = require('../Economy/WishProviders').gearGain(state, item);
                valueHours = Math.max(0, (gain.attack + gain.defence * economy.deathHours) * horizonHours);
            }
        }
        clan = { horizonHours, huntPerHour: economy.hunt.perHour, plan: itemId ? { itemId, valueHours } : null };
    }
    return compact({
        updatedAt: Number(state?.updatedAt || 0),
        key: stateKey(seen),
        riskWeight: Number(economy?.riskWeight) || 0,
        activity,
        wish: wish ? [kindCode(wish.object?.kind), Number(wish.object?.amount || 0), Number(wish.price || 0)] : null,
        watch: (economy?.watchList || []).slice(0, 3).map(row => [Number(row.itemId), Number(row.amount), Number(row.worth), kindCode(row.kind)]),
        materials: [...missing].slice(0, 8), usefulness, inputHash: fnv1a32(economy?.inputKey || ''), clan
    });
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
    const itemUsefulness = id => (known(id) || 0) * (enabled ? 1 + (1 - Number(base.persona.understanding ?? .3))
        * (2 * require('../AI/TendencyRoll').roll('usefulness', state.characterId, id) - 1) : 1);
    const activity = decision?.activity || null;
    const wish = decision?.wish ? { object: { kind: kindFor(decision.wish[0]), amount: decision.wish[1] }, price: decision.wish[2] } : null;
    return { ...base, state, hourAdena, moneyPrice, survivalReserve: valid ? Number(packet[2]) : base.survivalReserve,
        gapHorizonHours: !valid || !(packet[3] > 0) ? 0 : ['shots', 'potions'].includes(wish?.object.kind)
            ? base.stock(wish.object.kind).targetHours
            : require('../Economy/EconomicValuation').stageHours(state, base.hunt.expPerHour, base.persona),
        board: deps.board || invoke('GameServer/AfkTrade/AfkTradeService').boardIndex(),
        network: { activity }, activity, wish,
        watchList: (decision?.watch || []).map(row => ({ itemId: row[0], amount: row[1], worth: row[2], kind: kindFor(row[3]) })),
        materials: decision?.materials || [], inputHash: decision?.inputHash || 0, decided: !!decision,
        itemUsefulness, worth: id => known(id) !== null && moneyPrice > 0 ? itemUsefulness(id) / moneyPrice : base.price(id) };
}
function economyFor(state, deps = {}) {
    if (isMainThread && state?.phase === 'cold') return view(state,
        (deps.decisions || invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions).decided(state), deps);
    return invoke('GameServer/Bot/Economy/EconomyContext').forState(state, deps);
}

class ColdEconomyDecisions {
    constructor() {
        this.byId = new Map();
        this.hits = 0;
        this.misses = 0;
    }

    // committed: the commit's result. A commit that merged board deals or PK
    // drops into the bag keeps the worker's updatedAt, but the decision was
    // made on the bag before them: keep its numbers, but defer its wishes.
    accept(characterId, decision, committed = null) {
        const id = Number(characterId);
        if (!id) return;
        const incoming = decision ? compact(decision) : null;
        const bagChanged = !!committed?.settled || !!committed?.pkDrops?.length;
        const previous = this.byId.get(id);
        if (incoming && Number.isFinite(Number(incoming.updatedAt))) this.byId.set(id, compact({ ...incoming, stale: bagChanged,
            ...(previous?.workshopToken !== undefined ? { workshopToken: previous.workshopToken, workshop: previous.workshop } : {}) }));
        else if (this.byId.has(id)) this.byId.get(id).stale = true;
    }

    // The worker's decision made on exactly this state, or held for a command.
    decided(state) {
        const id = Number(state?.characterId);
        const decision = this.byId.get(id);
        if (decision && (decision.held || !decision.stale && decision.updatedAt === Number(state?.updatedAt || 0)
            && decision.key === stateKey(state))) {
            this.hits += 1;
            return decision;
        }
        this.misses += 1;
        return null;
    }

    // A miss waits for the next worker decision.
    activity(state) { return this.decided(state)?.activity || null; }
    hold(id, decision) { if (decision) this.byId.set(Number(id), compact({ ...compact(decision), held: true })); }
    release(id) { const decision = this.byId.get(Number(id)); if (decision) { decision.held = false; decision.stale = true; } }
    forget(id) { this.byId.delete(Number(id)); }
    size() { return this.byId.size; }
    clanNumbers(id) {
        const entry = this.byId.get(Number(id)), clan = entry?.clan;
        return clan ? { ...clan, updatedAt: entry.updatedAt } : null;
    }
    workshopFor(state, build) {
        const id = Number(state.characterId), entry = this.byId.get(id) || { stale: true };
        const token = fnv1a32(JSON.stringify([state.stats?.workshop?.entries, state.stats?.recipes || state.recipes]));
        // ARCH-NOTE: workshop income is computed only when its learned entries/recipes change.
        // Keep these four numbers in the existing decision entry, with no second bot cache.
        if (entry.workshopToken !== token) { entry.workshopToken = token; entry.workshop = build(); this.byId.set(id, entry); }
        return entry.workshop;
    }
}

module.exports = { capture, stateKey, ColdEconomyDecisions, economyFor, view, kindCode, kindFor, compact };
