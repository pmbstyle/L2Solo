const ItemTemplateIndex = require('./ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');

function validSlot(value) {
    const slot = Number(value);
    return Number.isInteger(slot) && slot >= 0 && slot <= 31 ? slot : null;
}

function canonicalSlot(selfId, fallback = 0) {
    const template = ItemTemplateIndex.find(DataCache.items, selfId);
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
    const petGear = require('../../../data/Pets/c4-gear.json').gear[item?.fetchSelfId?.()];
    if (petGear) return { wolf: 0x020000, hatchling: 0x040000, strider: 0x080000 }[petGear.category];
    if (!item?.isWearable?.()) return 0;
    return 2 ** slotFor(item);
}

module.exports = { canonicalSlot, slotFor, bodyPart };
