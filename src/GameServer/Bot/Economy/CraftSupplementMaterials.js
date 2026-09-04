const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');

function isSupplementalMaterial(selfId) {
    const name = ItemTemplateIndex.find(DataCache.items, selfId)?.template?.name || '';
    return /^(Crystal:|Gemstone\s)/i.test(name);
}

module.exports = { isSupplementalMaterial };
