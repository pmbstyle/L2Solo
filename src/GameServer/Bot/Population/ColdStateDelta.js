// Sparse JSON transport against the state protected by the proposal's lease.
// Arrays are replaced; object keys support both changes and deletions.
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diff(before, after) {
    if (JSON.stringify(before) === JSON.stringify(after)) return null;
    if (!object(before) || !object(after)) return { value: after };
    const changes = [];
    const removed = Object.keys(before).filter(key => !Object.hasOwn(after, key));
    for (const key of Object.keys(after)) {
        const change = diff(before[key], after[key]);
        if (change) changes.push([key, change]);
    }
    return { changes, removed };
}

function create(before, after) {
    return diff(JSON.parse(JSON.stringify(before)), JSON.parse(JSON.stringify(after))) || { changes: [], removed: [] };
}

function apply(before, delta) {
    if (Object.hasOwn(delta, 'value')) return delta.value;
    const result = { ...before };
    for (const key of delta.removed || []) delete result[key];
    for (const [key, change] of delta.changes || []) {
        Object.defineProperty(result, key, { value: apply(before?.[key], change), enumerable: true, configurable: true, writable: true });
    }
    return result;
}

module.exports = { create, apply };
