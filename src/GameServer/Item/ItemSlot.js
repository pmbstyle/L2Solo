const DataCache = invoke('GameServer/DataCache');

function validSlot(value) {
    const slot = Number(value);
    return Number.isInteger(slot) && slot >= 0 && slot <= 31 ? slot : null;
}

function canonicalSlot(selfId, fallback = 0) {
    const template = (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId));
    if (template) {
        const flattened = utils.crushOb(template);
        const slot = validSlot(flattened.slot ?? template.etc?.slot);
        if (slot !== null) return slot;
    }
    return validSlot(fallback) ?? 0;
}

function slotFor(item, fallback = 0) {
    const current = validSlot(item?.fetchSlot?.() ?? item?.slot);
    if (item?.fetchEquipped?.()) return current ?? canonicalSlot(item.fetchSelfId?.(), fallback);
    return canonicalSlot(item?.fetchSelfId?.() ?? item?.selfId, current ?? fallback);
}

function bodyPart(item) {
    if (!item?.isWearable?.()) return 0;
    return 2 ** slotFor(item);
}

module.exports = { canonicalSlot, slotFor, bodyPart };
