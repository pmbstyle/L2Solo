const DataCache = invoke('GameServer/DataCache');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');

function material(line) {
    const template = ItemTemplateIndex.find(DataCache.items, line?.selfId);
    const kind = String(line?.kind || template?.template?.kind || '');
    return kind.startsWith('Other.Material') || [1785, 2508, 3031].includes(Number(line?.selfId));
}

function shot(line) {
    const template = ItemTemplateIndex.find(DataCache.items, line?.selfId);
    return String(line?.kind || template?.template?.kind || '').startsWith('Other.Shot');
}

function viable(line) {
    const count = Number(line?.count);
    return Number.isSafeInteger(count) && count > 0;
}

module.exports = { material, shot, viable };
