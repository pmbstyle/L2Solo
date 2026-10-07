'use strict';

// Private storage only. Exported snapshots and policy results remain ordinary
// objects. Float64 keeps every accepted JS number, including clocks and ids.
const NUMBERS = ['targetId', 'at', 'order', 'affinity', 'trust', 'hostility', 'fear', 'familiarity',
    'lastHuntAt', 'lastAidAt', 'abandonedAt', 'gameAt', 'grudge', 'gratitude'];
const COLUMNS = Object.fromEntries(NUMBERS.map((field, index) => [field, index]));
const KINDS = ['character', 'clan', 'alliance'];
const EVENTS = ['hunted_together', 'helped_in_combat', 'healed', 'resurrected', 'resources_received',
    'mob_contested', 'attacked', 'killed', 'aided_opponent', 'invite_attempt', 'party_formed',
    'party_refused', 'party_dismissed', 'party_kicked', 'party_wiped', 'chat', 'supported_party',
    'trade_completed', 'gave_useful_loot', 'ignored_loot_request', 'insulted', 'crafted_for',
    'buff_service', 'gift', 'loot_taken'];
const EVENT_IDS = new Map(EVENTS.map((type, index) => [type, index]));
const REASONS = 3;
const STRIDE = NUMBERS.length + REASONS;
const META_STRIDE = 3 + REASONS; // kind, player/reason-order flags, count, type codes
// Common key layouts contain no owner data. A bounded cache shares them across
// owners without keeping arbitrary future metadata keys after their last owner.
const layoutCache = new Map();

function layoutFor(keys) {
    const key = JSON.stringify(keys);
    let layout = layoutCache.get(key);
    if (layout) { layoutCache.delete(key); layoutCache.set(key, layout); return layout; }
    layout = Object.freeze({ keys: Object.freeze(keys), columns: Object.freeze(keys.map(field =>
        Object.hasOwn(COLUMNS, field) ? COLUMNS[field] : field === 'kind' ? -1
            : field === 'reasons' ? -2 : field === 'player' ? -3 : -4)) });
    if (layoutCache.size >= 128) layoutCache.delete(layoutCache.keys().next().value);
    layoutCache.set(key, layout);
    return layout;
}

function supported(row) {
    if (!row || !KINDS.includes(row.kind) || !Array.isArray(row.reasons) || row.reasons.length > REASONS) return false;
    for (const field of NUMBERS) {
        if (Object.hasOwn(row, field) && (typeof row[field] !== 'number' || !Number.isFinite(row[field]))) return false;
    }
    if (Object.hasOwn(row, 'player') && typeof row.player !== 'boolean') return false;
    return row.reasons.every(reason => {
        if (!reason || typeof reason !== 'object' || Array.isArray(reason)
            || !EVENT_IDS.has(reason.type) || typeof reason.at !== 'number' || !Number.isFinite(reason.at)) return false;
        const keys = Object.keys(reason);
        return keys.length === 2 && keys.includes('type') && keys.includes('at');
    });
}

class PackedInteractionRows {
    constructor(snapshot) {
        this.version = snapshot.version;
        this.ownerId = snapshot.ownerId;
        this.revision = snapshot.revision;
        this.replayFloor = snapshot.replayFloor;
        this.length = snapshot.relations.length;
        this.values = new Float64Array(this.length * STRIDE);
        this.meta = new Uint8Array(this.length * META_STRIDE);
        this.layoutIds = new Uint16Array(this.length);
        this.layouts = [null];
        this.indexes = new Map();
        this.extras = null;
        this.fallback = null;
        const layouts = new Map(), characterIds = [];
        for (let ordinal = 0; ordinal < this.length; ordinal++) {
            // Preserve the old JSON-clone normalization and isolate caller
            // mutations, while only one transient plain row exists at a time.
            const row = JSON.parse(JSON.stringify(snapshot.relations[ordinal]));
            if (!this.indexes.has(row.kind)) this.indexes.set(row.kind, new Map());
            this.indexes.get(row.kind).set(row.targetId, ordinal);
            if (row.kind === 'character') characterIds.push(row.targetId);
            const keys = Object.keys(row), key = JSON.stringify(keys);
            let layoutId = layouts.get(key);
            if (!supported(row) || (layoutId === undefined && this.layouts.length > 65535)) {
                if (!this.fallback) this.fallback = new Map();
                this.fallback.set(ordinal, row);
                continue;
            }
            if (layoutId === undefined) {
                layoutId = this.layouts.length;
                layouts.set(key, layoutId);
                this.layouts.push(layoutFor(keys));
            }
            this.layoutIds[ordinal] = layoutId;
            const base = ordinal * STRIDE, metadata = ordinal * META_STRIDE;
            this.meta[metadata] = KINDS.indexOf(row.kind);
            this.meta[metadata + 1] = row.player === true ? 8 : 0;
            this.meta[metadata + 2] = row.reasons.length;
            for (let column = 0; column < NUMBERS.length; column++) {
                this.values[base + column] = row[NUMBERS[column]] ?? 0;
            }
            for (let slot = 0; slot < row.reasons.length; slot++) {
                const reason = row.reasons[slot];
                this.values[base + NUMBERS.length + slot] = reason.at;
                this.meta[metadata + 3 + slot] = EVENT_IDS.get(reason.type);
                if (Object.keys(reason)[0] === 'at') this.meta[metadata + 1] |= 1 << slot;
            }
            const extra = keys.filter(field => !Object.hasOwn(COLUMNS, field)
                && !['kind', 'reasons', 'player'].includes(field));
            if (extra.length) {
                if (!this.extras) this.extras = new Map();
                this.extras.set(ordinal, Object.fromEntries(extra.map(field => [field, row[field]])));
            }
        }
        this.characterIds = Object.freeze(characterIds);
    }

    decode(ordinal) {
        if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.length) return null;
        const layout = this.layouts[this.layoutIds[ordinal]];
        if (!layout) return this.fallback.get(ordinal);
        const base = ordinal * STRIDE, metadata = ordinal * META_STRIDE, row = {};
        for (let index = 0; index < layout.keys.length; index++) {
            const field = layout.keys[index], column = layout.columns[index];
            let value;
            if (column >= 0) value = this.values[base + column];
            else if (column === -1) value = KINDS[this.meta[metadata]];
            else if (column === -3) value = !!(this.meta[metadata + 1] & 8);
            else if (column === -2) {
                value = [];
                for (let slot = 0; slot < this.meta[metadata + 2]; slot++) {
                    const type = EVENTS[this.meta[metadata + 3 + slot]], at = this.values[base + NUMBERS.length + slot];
                    value.push(this.meta[metadata + 1] & (1 << slot) ? { at, type } : { type, at });
                }
            } else value = this.extras.get(ordinal)[field];
            if (field === '__proto__') Object.defineProperty(row, field, { value, enumerable: true, writable: true, configurable: true });
            else row[field] = value;
        }
        return row;
    }

    row(kind, targetId) {
        if (typeof kind !== 'string' || typeof targetId !== 'number') {
            // The public view historically formed a string key. Preserve its
            // coercion for diagnostic callers without retaining string keys.
            const key = `${kind}:${targetId}`, split = key.indexOf(':');
            kind = key.slice(0, split);
            const text = key.slice(split + 1);
            targetId = Number(text);
            if (`${targetId}` !== text) return null;
        }
        const ordinal = this.indexes.get(kind)?.get(targetId);
        return ordinal === undefined ? null : this.decode(ordinal);
    }

    mapRows(work) {
        return Array.from({ length: this.length }, (_, index) => work(this.decode(index), index));
    }

    plain() {
        return { version: this.version, ownerId: this.ownerId, revision: this.revision,
            replayFloor: this.replayFloor, readOnly: true, relations: this.mapRows(row => row), recent: [] };
    }
}

module.exports = PackedInteractionRows;
