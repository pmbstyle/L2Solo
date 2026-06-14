const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const TradeService   = invoke('GameServer/Bot/TradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');

function merchantSellRows(actor, store) {
    return actor.backpack.fetchItems()
        .filter((item) => !item.fetchEquipped() && item.fetchSelfId() !== 57)
        .map((item) => {
            const wanted = store.items.find((storeItem) => storeItem.selfId === item.fetchSelfId() && storeItem.count > 0);
            if (!wanted) return null;

            return {
                item,
                amount: Math.min(item.fetchAmount(), wanted.count),
                price: wanted.price
            };
        })
        .filter((row) => row && row.amount > 0);
}

function sell(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readD()  // List Id
        .readD(); // Count

    const count = packet.data[1];
    const list = [];

    for (let i = 0; i < count; i++) {
        packet
            .readD()
            .readD();

        list.push({
            objectId: packet.data[2 + (i * 2)],
            amount: packet.data[3 + (i * 2)]
        });
    }

    consume(session, list);
}

async function consume(session, list) {
    const trade = session.activeMerchantTrade;
    const store = trade && trade.store;

    if (!store || store.storeType !== 3) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    try {
        const sold = [];
        for (const line of list) {
            const item = session.actor.backpack.fetchItems().find((ob) => ob.fetchId() === line.objectId);
            if (!item || item.fetchEquipped() || item.fetchSelfId() === 57) continue;

            sold.push(await TradeService.sellToStore(session.actor, store, item.fetchSelfId(), line.amount));
        }

        if (sold.length > 0) {
            const detail = sold.map((item) => `${item.qty} ${item.name}`).join(', ');
            BotSocialMemory.recordTradeCompleted(session, trade.merchant, `sold ${detail}`);
        }

        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.sellList(
            merchantSellRows(session.actor, store),
            session.actor.backpack.fetchTotalAdena()
        ));
    } catch (err) {
        utils.infoWarn('Sell', 'merchant sell error: %s', err.message || err);
        session.dataSendToMe(ServerResponse.actionFailed());
    }
}

module.exports = sell;
