const ItemTemplateIndex = require('./ItemTemplateIndex');

function baseValue(item) {
    const template = ItemTemplateIndex.find(invoke('GameServer/DataCache').items,
        item?.fetchSelfId?.() ?? item?.selfId);
    return Math.max(0, Number(template?.template?.price ?? item?.fetchPrice?.() ?? item?.price ?? 0));
}

function equipmentValue(items = []) {
    return Math.round(items.reduce((total, item) => total + baseValue(item), 0));
}

function liveEquipmentValue(actor) {
    return equipmentValue((actor?.backpack?.fetchItems?.() || []).filter(item => item?.fetchEquipped?.()));
}

module.exports = { baseValue, equipmentValue, liveEquipmentValue };
