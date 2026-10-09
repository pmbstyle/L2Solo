'use strict';

// Large bags contain thousands of physical instances with the same fields.
// Share those field names on the wire, then restore every instance before
// planning or authority checks. The persisted inventory is never compacted.
const WIRE_FIELD = 'inventoryInstanceColumns';
const MIN_INSTANCES = 512;
const STATE_BATCHES = new Set(['snapshot_page', 'claim_ack', 'commit_ack', 'release_ack', 'command_ack']);

function packState(state) {
    if (!state?.inventory || state[WIRE_FIELD]) return state;
    let inventory = null, columns = null;
    for (const [itemId, item] of Object.entries(state.inventory)) {
        const instances = item?.instances;
        if (!Array.isArray(instances) || instances.length < MIN_INSTANCES) continue;
        const keys = Object.keys(instances[0] || {});
        if (!keys.length || keys.length > 32 || instances.some(instance => !instance
            || Array.isArray(instance) || Object.keys(instance).length !== keys.length
            || keys.some(key => !Object.hasOwn(instance, key)))) continue;
        inventory ||= { ...state.inventory };
        columns ||= {};
        columns[itemId] = keys;
        inventory[itemId] = { ...item, instances: instances.map(instance => keys.map(key => instance[key])) };
    }
    return inventory ? { ...state, inventory, [WIRE_FIELD]: columns } : state;
}

function unpackState(state) {
    if (!state?.[WIRE_FIELD]) return state;
    const { [WIRE_FIELD]: columns, ...plain } = state;
    if (typeof columns !== 'object' || Array.isArray(columns)) throw Error('invalid_inventory_wire');
    const inventory = { ...plain.inventory };
    for (const [itemId, keys] of Object.entries(columns)) {
        const item = inventory[itemId];
        if (!Array.isArray(keys) || !keys.length || keys.length > 32
            || keys.some(key => typeof key !== 'string') || new Set(keys).size !== keys.length
            || !Array.isArray(item?.instances)
            || item.instances.some(row => !Array.isArray(row) || row.length !== keys.length)) {
            throw Error('invalid_inventory_wire');
        }
        inventory[itemId] = { ...item, instances: item.instances.map(row =>
            Object.fromEntries(keys.map((key, index) => [key, row[index]]))) };
    }
    return { ...plain, inventory };
}

function packEntry(entry) {
    const state = packState(entry?.state);
    return state === entry?.state ? entry : { ...entry, state };
}

function mapPayload(type, payload, transform) {
    if (type === 'command_request' && Array.isArray(payload.requests)) {
        const requests = payload.requests.map(entry => {
            if (entry.kind !== 'lifecycle') return entry;
            const state = transform(entry.state);
            const plannedState = transform(entry.precomputedPlan?.plannedState);
            const patch = transform(entry.precomputedResult?.patch);
            if (state === entry.state && plannedState === entry.precomputedPlan?.plannedState
                && patch === entry.precomputedResult?.patch) return entry;
            return { ...entry,
                ...(state !== entry.state ? { state } : {}),
                ...(plannedState !== entry.precomputedPlan?.plannedState
                    ? { precomputedPlan: { ...entry.precomputedPlan, plannedState } } : {}),
                ...(patch !== entry.precomputedResult?.patch
                    ? { precomputedResult: { ...entry.precomputedResult, patch } } : {}) };
        });
        return requests.some((entry, index) => entry !== payload.requests[index]) ? { ...payload, requests } : payload;
    }
    if (!STATE_BATCHES.has(type)) return payload;
    let result = payload;
    for (const field of ['rows', 'grants', 'rejected', 'results']) {
        if (!Array.isArray(payload[field])) continue;
        const entries = payload[field].map(entry => {
            const state = transform(entry?.state);
            return state === entry?.state ? entry : { ...entry, state };
        });
        if (entries.some((entry, index) => entry !== payload[field][index])) {
            if (result === payload) result = { ...payload };
            result[field] = entries;
        }
    }
    return result;
}

module.exports = { packState, unpackState, packEntry,
    packPayload: (type, payload) => mapPayload(type, payload, packState),
    unpackPayload: (type, payload) => mapPayload(type, payload, unpackState) };
