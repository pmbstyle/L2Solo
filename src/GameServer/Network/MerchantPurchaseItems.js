const DataCache    = invoke('GameServer/DataCache');
const Item         = invoke('GameServer/Item/Item');
const TradeService = invoke('GameServer/Bot/TradeService');

// Rows of a native merchant buy window: one item per store line whose
// price the C4 packet can carry, built from the item template with the line's
// object id, count and price; a line with an unknown template is left out.
// `refresh` re-quotes the store for `actor` first: the re-render after a
// purchase does, the window opener has already refreshed and passes none.
function merchantPurchaseItems(store, { refresh = false, actor = null } = {}) {
    const items = [];

    if (refresh) TradeService.refreshStorePrices(store, actor);
    TradeService.nativeStoreItems(store).forEach((storeItem) => {
        DataCache.fetchItemFromSelfId(storeItem.selfId, (item) => {
            items.push(new Item(storeItem.objectId, {
                ...utils.crushOb(item),
                amount: storeItem.count,
                price: storeItem.price
            }));
        });
    });

    return items;
}

module.exports = merchantPurchaseItems;
