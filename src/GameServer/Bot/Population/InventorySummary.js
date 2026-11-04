'use strict';

const { isDeepStrictEqual } = require('node:util');

// Cold progression owns counts; instances retain the identity and enchant of
// copies already materialized. A purchase/drop can grow the count before a new
// physical row exists. Never copy the old item's enchant onto that new copy.
function completeInstances(item = {}) {
    // A physical stack owns its whole quantity. Per-unit identities belong
    // only to non-stackable gear, never to Adena, shots or materials.
    if (item.stackable === true) return item;
    if (!Array.isArray(item.instances)) return item;
    const amount = Math.max(0, Math.floor(Number(item.amount) || 0));
    const slots = Array.isArray(item.equippedSlots)
        ? [...new Set(item.equippedSlots.map(Number).filter((slot) => slot > 0))].slice(0, amount)
        : item.instances.filter((instance) => instance.equipped && Number(instance.slot) > 0)
            .map((instance) => Number(instance.slot)).slice(0, amount);
    // When selling surplus, keep worn copies even if they are not first in
    // instance order. Preserve the slot of each surviving equipped copy.
    const instances = item.instances.map((instance) => ({
        ...instance, enchant: Math.max(0, Number(instance.enchant ?? item.enchant ?? 0) || 0)
    }))
        .sort((a, b) => Number(b.equipped && slots.includes(Number(b.slot)))
            - Number(a.equipped && slots.includes(Number(a.slot))))
        .slice(0, amount);
    while (instances.length < amount) instances.push({ id: null, amount: 1, enchant: 0, equipped: false, slot: 0 });
    const remaining = new Set(slots);
    for (const instance of instances) {
        const slot = Number(instance.slot);
        instance.equipped = !!instance.equipped && remaining.delete(slot);
        instance.slot = instance.equipped ? slot : 0;
        instance.amount = 1;
    }
    for (const instance of instances) {
        if (instance.equipped || !remaining.size) continue;
        instance.slot = remaining.values().next().value;
        instance.equipped = true;
        remaining.delete(instance.slot);
    }
    const enchants = [...new Set(instances.map((instance) => Number(instance.enchant || 0)))];
    return { ...item, instances, enchant: enchants.length === 1 ? enchants[0] : null };
}

function canonicalize(inventory = {}) {
    return Object.entries(inventory || {}).reduce((summary, [key, item]) => {
        if (!item || !Number.isFinite(Number(item.amount)) || Number(item.amount) <= 0) return summary;
        summary[key] = completeInstances(item);
        return summary;
    }, {});
}

// What a step did to the bag, shaped as the proposal fields main's commit
// reads (ColdSimulationOwner): bagChanged (the commit rewrites the physical
// items only then), removedItemIds, the selfIds of the stacks the step emptied
// (the commit deletes their rows), and with a moved bag changedItemIds, the
// selfIds of the stacks it added or changed (with the emptied ones the only
// stacks the commit compares with their rows while no other writer touched
// them: Database bot_items_synced). A stack with no positive amount counts as
// absent. Equal items compare raw: raw-equal implies canonical-equal, so a
// miss costs a write, never a skipped one.
function bagChange(baseInventory = {}, nextInventory = {}) {
    const base = baseInventory || {};
    const next = nextInventory || {};
    const removed = [];
    const changed = [];
    for (const key in base) {
        const item = base[key];
        if (!item || !(Number(item.amount) > 0)) continue;
        const after = next[key];
        if (!after || !(Number(after.amount) > 0)) removed.push(Number(item.selfId || key));
    }
    for (const key in next) {
        const after = next[key];
        if (!after || !(Number(after.amount) > 0)) continue;
        const item = base[key];
        if (after === item) continue;
        if (!item || !(Number(item.amount) > 0) || !isDeepStrictEqual(after, item)) changed.push(Number(after.selfId || key));
    }
    if (!removed.length && !changed.length) return { bagChanged: false };
    return removed.length ? { bagChanged: true, changedItemIds: changed, removedItemIds: removed }
        : { bagChanged: true, changedItemIds: changed };
}

// Two bag changes over one commit as one (main's cleanup trip after the step,
// a proposal that replaces a queued one on the same revision): every flag and
// stack either moved. A side without the stack list (a moved bag it does not
// name) leaves none: the commit then compares every stack.
function mergeBagChange(first = {}, second = {}) {
    if (first.bagChanged === false && second.bagChanged === false) return { bagChanged: false };
    const named = (change) => change.bagChanged === false || Array.isArray(change.changedItemIds);
    const removed = [...new Set([...(first.removedItemIds || []), ...(second.removedItemIds || [])])];
    return {
        bagChanged: true,
        ...(named(first) && named(second)
            ? { changedItemIds: [...new Set([...(first.changedItemIds || []), ...(second.changedItemIds || [])])] } : {}),
        ...(removed.length ? { removedItemIds: removed } : {})
    };
}

module.exports = {
    canonicalize,
    completeInstances,
    bagChange,
    mergeBagChange
};
