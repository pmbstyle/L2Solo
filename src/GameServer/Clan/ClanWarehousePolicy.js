const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');

function templateFor(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function kindFor(item) {
    return String(item?.kind || templateFor(item?.selfId)?.template?.kind || '');
}

function nameFor(item) {
    return String(item?.name || templateFor(item?.selfId)?.template?.name || `Item ${item?.selfId || 0}`);
}

function isBloodMark(item, config = {}) {
    return Number(item?.selfId) === Number(config.bloodMarkItemId || 1419);
}

function isClanWarehouseCandidate(item, config = {}) {
    const selfId = Number(item?.selfId || 0);
    const amount = Number(item?.amount || 0);
    const kind = kindFor(item);
    if (!selfId || selfId === 57 || amount <= 0 || item?.equipped || item?.equippedCount > 0) return false;
    if (ItemDisposition.isRecipeItem(item)) return true;
    if (kind.startsWith('Other.Material')) return true;
    return isBloodMark(item, config);
}

function itemRows(state = {}, items = []) {
    return ItemDisposition.unreservedActorItems(state, items || [])
        .filter((item) => isClanWarehouseCandidate(item))
        .map((item) => ({
            ...item,
            id: Number(item.id || 0),
            selfId: Number(item.selfId || 0),
            name: nameFor(item),
            kind: kindFor(item),
            amount: Math.max(0, Number(item.amount || 0)),
            enchant: Math.max(0, Number(item.enchant || 0)),
            stackable: !ItemDisposition.isRecipeItem(item)
        }))
        .filter((item) => item.id > 0 && item.amount > 0)
        .sort((left, right) => left.id - right.id);
}

function depositCandidates(state = {}, items = [], warehouseItems = [], config = {}) {
    const existingRecipes = new Set((warehouseItems || [])
        .filter((item) => ItemDisposition.isRecipeItem(item) || String(item.kind || '').startsWith('Other.Recipe'))
        .map((item) => Number(item.selfId)));
    const selected = new Set();
    return itemRows(state, items).flatMap((item) => {
        const recipe = ItemDisposition.isRecipeItem(item);
        if (recipe && (existingRecipes.has(item.selfId) || selected.has(item.selfId))) return [];
        selected.add(item.selfId);
        return [{
            ...item,
            amount: recipe ? 1 : item.amount,
            reason: recipe ? 'recipe' : (isBloodMark(item, config) ? 'progression_item' : 'material')
        }];
    });
}

module.exports = {
    depositCandidates,
    isClanWarehouseCandidate,
    isBloodMark,
    kindFor,
    nameFor
};
