const World         = invoke('GameServer/World/World');
const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const Item           = invoke('GameServer/Item/Item');
const TradeService   = invoke('GameServer/Bot/TradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');

function merchantPurchaseItems(store) {
    const items = [];

    store.items.forEach((storeItem) => {
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

function purchase(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // List Id
        .readD(); // Count

    let list = [];

    for (let i = 0; i < packet.data[1]; i++) {
        packet
            .readD()
            .readD();

        list.push({ selfId: packet.data[2 + (i * 2)], amount: packet.data[3 + (i * 2)] });
    }

    consume(session, {
        listId: packet.data[0],
          list: list
    });
}

async function consume(session, data) {
    const trade = session.activeMerchantTrade;
    const store = trade && trade.store;

    if (store && store.storeType === 1) {
        try {
            const bought = [];
            for (const item of data.list) {
                bought.push(await TradeService.buyFromStore(session.actor, store, item.selfId, item.amount));
            }

            if (bought.length > 0) {
                const detail = bought.map((item) => `${item.qty} ${item.name}`).join(', ');
                BotSocialMemory.recordTradeCompleted(session, trade.merchant, `bought ${detail}`);
            }

            session.dataSendToMe(ServerResponse.userInfo(session.actor));
            session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
            session.dataSendToMe(ServerResponse.purchaseList(
                merchantPurchaseItems(store),
                session.actor.backpack.fetchTotalAdena()
            ));
        } catch (err) {
            utils.infoWarn('Purchase', 'merchant purchase error: %s', err.message || err);
            session.dataSendToMe(ServerResponse.actionFailed());
        }
        return;
    }

    World.purchaseItems(session, data.list);
}

module.exports = purchase;
