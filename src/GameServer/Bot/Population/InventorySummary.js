'use strict';

// Cold progression owns counts; instances retain the identity and enchant of
// copies already materialized. A purchase/drop can grow the count before a new
// physical row exists. Never copy the old item's enchant onto that new copy.
function completeInstances(item = {}) {
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

module.exports = {
    canonicalize,
    completeInstances
};
