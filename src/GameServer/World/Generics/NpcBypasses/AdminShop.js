const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');

module.exports = function(session, parts) {
    const itemIds = DataCache.adminShop[parts[1]];
    if (!itemIds) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    session.activeMerchantTrade = null;
    session.activeAdminShop = {
        category: parts[1],
        itemIds: new Set(itemIds)
    };

    let list = [];

    itemIds.forEach((selfId) => {
        DataCache.fetchItemFromSelfId(selfId, (item) => {
            item.template.price = 0; // Admin prices :)
            const nextId = invoke('GameServer/World/Generics/NpcTalkResponse').items.nextId++;
            list.push(new Item(nextId, utils.crushOb(item)));
        });
    });

    session.dataSendToMe(
        ServerResponse.purchaseList(list, session.actor.backpack.fetchTotalAdena())
    );
};
