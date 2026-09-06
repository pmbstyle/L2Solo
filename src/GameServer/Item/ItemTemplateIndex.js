'use strict';

let indexes = new WeakMap();

// Catalog IDs/order are immutable after loading. Replacing the array or changing
// its length rebuilds automatically; in-place ID/order edits must invalidate it.
function indexFor(items) {
    if (!Array.isArray(items)) return null;
    let index = indexes.get(items);
    if (index && index.length === items.length) return index;
    index = { length: items.length, numeric: new Map(), strict: new Map() };
    items.forEach((item) => {
        if (!item) return;
        const id = item.selfId;
        const numericId = Number(id);
        // Array.find returns the first match, including duplicate catalog IDs.
        if (!index.strict.has(id)) index.strict.set(id, item);
        if (!Number.isNaN(numericId) && !index.numeric.has(numericId)) index.numeric.set(numericId, item);
    });
    indexes.set(items, index);
    return index;
}

function find(items, selfId) {
    const id = Number(selfId);
    return Number.isNaN(id) ? undefined : indexFor(items)?.numeric.get(id);
}

function findStrict(items, selfId) {
    return Number.isNaN(selfId) ? undefined : indexFor(items)?.strict.get(selfId);
}

function invalidate(items) {
    if (items) indexes.delete(items);
    else indexes = new WeakMap();
}

module.exports = { find, findStrict, invalidate };
