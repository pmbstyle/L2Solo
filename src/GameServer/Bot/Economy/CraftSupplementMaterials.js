const DataCache = invoke('GameServer/DataCache');

function isSupplementalMaterial(selfId) {
    const name = (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId))?.template?.name || '';
    return /^(Crystal:|Gemstone\s)/i.test(name);
}

module.exports = { isSupplementalMaterial };
