const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');

module.exports = function(session, parts) {
    let list = [];

    DataCache.adminShop[parts[1]].forEach((selfId) => {
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
