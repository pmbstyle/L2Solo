const World         = invoke('GameServer/World/World');
const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const Item           = invoke('GameServer/Item/Item');
const TradeService   = invoke('GameServer/Bot/TradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotManager     = invoke('GameServer/Bot/BotManager');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');

function merchantPurchaseItems(store, actor) {
    const items = [];

    TradeService.refreshStorePrices(store, actor);
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
    const adminShop = session.activeAdminShop;

    // A shop on the board trades only through the board (PrivateStoreBuy):
    // its window's store is a projection of the record (E43).
    if (store?.afkTrade === true) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }
    if (store && store.storeType === 1) {
        try {
            if (store.repricing === true || Number(trade.revision || 1) !== Number(store.revision || 1)) {
                throw new Error("Store listing changed.");
            }
            const bought = [];
            const sellerSession = BotManager.sessions.find((candidate) => candidate.actor === trade.merchant);
            for (const item of data.list) {
                const result = await TradeService.buyFromStore(session.actor, store, item.selfId, item.amount, {
                    expectedRevision: trade.revision,
                    expectedUnitPrice: trade.prices?.[Number(item.selfId)]
                });
                bought.push(result);
                MarketTelemetry.recordTrade({
                    channel: 'wts',
                    sourceType: 'private_store_player_purchase',
                    selfId: item.selfId,
                    itemName: result.name,
                    quantity: result.qty,
                    unitPrice: result.qty ? result.totalAdena / result.qty : 0,
                    town: store.town || sellerSession?.coldMarketState?.currentRegion,
                    sellerCharacterId: trade.merchant?.fetchId?.(),
                    sellerName: trade.merchant?.fetchName?.(),
                    buyerCharacterId: session.actor.fetchId(),
                    buyerName: session.actor.fetchName()
                });
            }

            if (bought.length > 0) {
                const detail = bought.map((item) => `${item.qty} ${item.name}`).join(', ');
                BotSocialMemory.recordTradeCompleted(session, trade.merchant, `bought ${detail}`);
            }

            session.dataSendToMe(ServerResponse.userInfo(session.actor));
            session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
            const soldOut = !store.items.some((item) => Number(item.count || 0) > 0);
            if (soldOut) {
                session.activeMerchantTrade = null;
                session.dataSendToMe(ServerResponse.actionFailed());
                return;
            }
            session.dataSendToMe(ServerResponse.purchaseList(
                merchantPurchaseItems(store, session.actor),
                session.actor.backpack.fetchTotalAdena()
            ));
            trade.prices = Object.fromEntries(store.items.map(line => [Number(line.selfId), Number(line.price)]));
        } catch (err) {
            utils.infoWarn('Purchase', 'merchant purchase error: %s', err.message || err);
            if (store.repricing === true || Number(trade.revision || 1) !== Number(store.revision || 1) || /changed/i.test(String(err.message || err))) {
                session.activeMerchantTrade = null;
                session.viewedPrivateStoreSeller = null;
            }
            session.dataSendToMe(ServerResponse.actionFailed());
        }
        return;
    }

    if (adminShop) {
        const allowed = data.list.every((item) => adminShop.itemIds.has(item.selfId));
        if (!allowed) {
            session.activeAdminShop = null;
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        World.purchaseItems(session, data.list, { free: true });
        return;
    }

    if (session.activeNpcShop) {
        const allowed = data.list.every((item) => session.activeNpcShop.itemIds.has(item.selfId));
        if (!allowed) {
            session.activeNpcShop = null;
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        World.purchaseItems(session, data.list, { prices: session.activeNpcShop.prices });
        return;
    }

    World.purchaseItems(session, data.list);
}

module.exports = purchase;
