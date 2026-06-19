const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');

module.exports = function(session, parts) {
    session.activeMerchantTrade = null;
    session.activeAdminShop = null;
    session.activeNpcShop = null;

    let list = [];
    let entries = [];

    if (parts[1] === 'npc') {
        entries = NpcShopBuyLists.fetchForNpc(session.activeNpcTalk?.selfId);
    } else {
        entries = NpcShopBuyLists.fetchFallback(parts[1]);
    }

    if (!entries.length) {
        entries = NpcShopBuyLists.fetchFallback('grocer');
    }

    const prices = new Map();
    const itemIds = new Set();

    entries.forEach((entry) => {
        itemIds.add(entry.selfId);
        if (entry.price !== undefined) {
            prices.set(entry.selfId, entry.price);
        }

        DataCache.fetchItemFromSelfId(entry.selfId, (item) => {
            // Retrieve item nextId generator from dynamic context
            const nextId = invoke('GameServer/World/Generics/NpcTalkResponse').items.nextId++;
            const row = utils.crushOb(item);
            if (entry.price !== undefined) row.price = entry.price;
            list.push(new Item(nextId, row));
        });
    });

    session.activeNpcShop = {
        npcSelfId: session.activeNpcTalk?.selfId,
        itemIds,
        prices
    };

    session.dataSendToMe(
        ServerResponse.purchaseList(list, session.actor.backpack.fetchTotalAdena())
    );
};
