'use strict';
const { isProxy } = require('node:util').types;
const compacted = new WeakSet();

// Structured clone may give an object keyed by item/NPC/skill IDs a large
// holey elements array. For example, twenty item keys can retain 35 KB of
// empty slots. A temporary non-default element descriptor makes V8 use its
// sparse dictionary representation. Restore that descriptor synchronously:
// identity, prototype, values, key order and all attributes stay identical.
// This is a storage hint, not another state/DTO or a correctness dependency.
function compact(value) {
    if (!value || typeof value !== 'object' || isProxy(value) || compacted.has(value)
        || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Object.keys(value);
    if (!keys.length) return false;
    let largest = 0;
    for (const key of keys) {
        const id = Number(key);
        if (!Number.isInteger(id) || id < 0 || id >= 4294967295 || String(id) !== key) return false;
        largest = Math.max(largest, id);
    }
    if (largest < 128 || largest < keys.length * 8) return false;
    const key = keys[0], descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.writable || !descriptor.configurable) return false;
    Object.defineProperty(value, key, { writable: false });
    Object.defineProperty(value, key, { writable: true });
    compacted.add(value);
    return true;
}

function ownValue(value, key) {
    if (!value || typeof value !== 'object' || isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function compactState(state) {
    const stats = ownValue(state, 'stats');
    compact(ownValue(state, 'inventory'));
    compact(ownValue(ownValue(stats, 'coldCombat'), 'cooldowns'));
    compact(ownValue(ownValue(stats, 'targetCombat'), 'populationTargets'));
}

module.exports = { compact, compactState };
